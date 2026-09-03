import type { DatabaseSync } from "node:sqlite";

/**
 * Recurring-cost detection.
 *
 * Fixed costs are inferred from what the account actually did, not from a list
 * kept by hand — a list by hand is exactly the thing that goes stale.
 *
 * Charges are bucketed per calendar month and summed before any cadence
 * reasoning. That matters: a subscription can post as two lines on one day
 * (PostFinance does this), and raw day-gaps would then read as a zero-day
 * interval rather than one monthly charge.
 */

export type Cadence = "monthly" | "quarterly" | "yearly";

export interface DetectedFixedCost {
  counterpartyKey: string;
  displayName: string;
  cadence: Cadence;
  /** Median of the per-period totals — robust to a one-off surcharge. */
  typicalAmount: number;
  minAmount: number;
  maxAmount: number;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  /** Share of expected periods that actually carry a charge, in [0, 1]. */
  regularity: number;
  /** True when nothing has posted for more than two expected periods. */
  lapsed: boolean;
}

export interface DetectOptions {
  /** Minimum periods with a charge before a payee counts as recurring. */
  minOccurrences?: number;
  /** Maximum spread (max/min) of period totals still considered "the same" charge. */
  maxAmountRatio?: number;
  /** Minimum share of expected periods that must carry a charge. */
  minRegularity?: number;
  /** Only consider bookings on or after this date. */
  since?: string;
}

const DEFAULTS = {
  minOccurrences: 3,
  // Utilities and phone bills drift; a 2.5x spread still reads as one charge,
  // while a genuinely variable payee (groceries) blows well past it.
  maxAmountRatio: 2.5,
  minRegularity: 0.6,
} as const;

interface ChargeRow {
  counterparty_key: string;
  counterparty_raw: string | null;
  booking_date: string;
  amount: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Whole months between two `YYYY-MM` keys. */
function monthsBetween(from: string, to: string): number {
  const [fromYear, fromMonth] = from.split("-").map(Number) as [number, number];
  const [toYear, toMonth] = to.split("-").map(Number) as [number, number];
  return (toYear - fromYear) * 12 + (toMonth - fromMonth);
}

/** Months per period, used to turn a cadence into an expected-period count. */
const PERIOD_MONTHS: Record<Cadence, number> = { monthly: 1, quarterly: 3, yearly: 12 };

/**
 * Infer a cadence from the gaps between months that carry a charge.
 *
 * Uses the median gap so a single skipped month does not reclassify a monthly
 * subscription as quarterly.
 */
function cadenceFromGaps(monthKeys: string[]): Cadence | null {
  if (monthKeys.length < 2) return null;

  const gaps: number[] = [];
  for (let i = 1; i < monthKeys.length; i += 1) {
    gaps.push(monthsBetween(monthKeys[i - 1]!, monthKeys[i]!));
  }

  const typical = median(gaps);
  if (typical <= 1.5) return "monthly";
  if (typical <= 4.5) return "quarterly";
  if (typical <= 13) return "yearly";
  return null;
}

/**
 * Find recurring charges in the transaction history.
 *
 * Only debits are considered; incoming money is revenue, handled separately.
 */
export function detectFixedCosts(db: DatabaseSync, options: DetectOptions = {}): DetectedFixedCost[] {
  const minOccurrences = options.minOccurrences ?? DEFAULTS.minOccurrences;
  const maxAmountRatio = options.maxAmountRatio ?? DEFAULTS.maxAmountRatio;
  const minRegularity = options.minRegularity ?? DEFAULTS.minRegularity;

  const rows = db
    .prepare(
      `SELECT counterparty_key, counterparty_raw, booking_date, amount
       FROM bank_transaction
       WHERE direction = 'DBIT'
         AND reversal = 0
         AND counterparty_key IS NOT NULL
         AND booking_date >= ?
       ORDER BY counterparty_key, booking_date`,
    )
    .all(options.since ?? "0000-01-01") as unknown as ChargeRow[];

  const byPayee = new Map<string, ChargeRow[]>();
  for (const row of rows) {
    const existing = byPayee.get(row.counterparty_key);
    if (existing) existing.push(row);
    else byPayee.set(row.counterparty_key, [row]);
  }

  const detected: DetectedFixedCost[] = [];

  for (const [key, charges] of byPayee) {
    // Collapse to one total per calendar month before reasoning about cadence.
    const perMonth = new Map<string, number>();
    for (const charge of charges) {
      const month = charge.booking_date.slice(0, 7);
      perMonth.set(month, (perMonth.get(month) ?? 0) + charge.amount);
    }

    const monthKeys = [...perMonth.keys()].sort();
    if (monthKeys.length < minOccurrences) continue;

    const cadence = cadenceFromGaps(monthKeys);
    if (!cadence) continue;

    const totals = monthKeys.map((month) => perMonth.get(month)!);
    const minAmount = Math.min(...totals);
    const maxAmount = Math.max(...totals);

    // A payee whose amount swings wildly is spending, not a fixed cost.
    if (minAmount <= 0 || maxAmount / minAmount > maxAmountRatio) continue;

    const firstMonth = monthKeys[0]!;
    const lastMonth = monthKeys[monthKeys.length - 1]!;
    const periodMonths = PERIOD_MONTHS[cadence];
    const expectedPeriods = Math.floor(monthsBetween(firstMonth, lastMonth) / periodMonths) + 1;
    const regularity = expectedPeriods > 0 ? monthKeys.length / expectedPeriods : 0;

    if (regularity < minRegularity) continue;

    const latestCharge = charges[charges.length - 1]!;
    const monthsSinceLast = monthsBetween(lastMonth, new Date().toISOString().slice(0, 7));

    detected.push({
      counterpartyKey: key,
      displayName: latestCharge.counterparty_raw ?? key,
      cadence,
      typicalAmount: Number(median(totals).toFixed(2)),
      minAmount: Number(minAmount.toFixed(2)),
      maxAmount: Number(maxAmount.toFixed(2)),
      occurrences: monthKeys.length,
      firstSeen: charges[0]!.booking_date,
      lastSeen: latestCharge.booking_date,
      regularity: Number(Math.min(regularity, 1).toFixed(2)),
      lapsed: monthsSinceLast > periodMonths * 2,
    });
  }

  // Biggest monthly commitment first — that is the order worth reading.
  return detected.sort((a, b) => monthlyEquivalent(b) - monthlyEquivalent(a));
}

/** A cadence-normalized monthly figure, so quarterly and yearly costs compare. */
export function monthlyEquivalent(cost: DetectedFixedCost): number {
  return cost.typicalAmount / PERIOD_MONTHS[cost.cadence];
}

/** Total monthly run rate across all active detected costs. */
export function monthlyRunRate(costs: DetectedFixedCost[]): number {
  return Number(
    costs
      .filter((cost) => !cost.lapsed)
      .reduce((sum, cost) => sum + monthlyEquivalent(cost), 0)
      .toFixed(2),
  );
}

/** Persist detections, preserving any category and confirmation set by hand. */
export function saveFixedCosts(db: DatabaseSync, costs: DetectedFixedCost[]): void {
  const upsert = db.prepare(`
    INSERT INTO fixed_cost (
      counterparty_key, display_name, cadence, typical_amount, min_amount,
      max_amount, occurrences, first_seen, last_seen, active, detected_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (counterparty_key) DO UPDATE SET
      display_name   = excluded.display_name,
      cadence        = excluded.cadence,
      typical_amount = excluded.typical_amount,
      min_amount     = excluded.min_amount,
      max_amount     = excluded.max_amount,
      occurrences    = excluded.occurrences,
      first_seen     = excluded.first_seen,
      last_seen      = excluded.last_seen,
      active         = excluded.active,
      detected_at    = datetime('now')
  `);

  db.exec("BEGIN");
  try {
    for (const cost of costs) {
      upsert.run(
        cost.counterpartyKey,
        cost.displayName,
        cost.cadence,
        cost.typicalAmount,
        cost.minAmount,
        cost.maxAmount,
        cost.occurrences,
        cost.firstSeen,
        cost.lastSeen,
        cost.lapsed ? 0 : 1,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
