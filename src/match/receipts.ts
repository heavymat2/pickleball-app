import type { DatabaseSync } from "node:sqlite";
import { nameSimilarity } from "../camt/normalize.ts";

/**
 * Matching bank debits against receipt files.
 *
 * The goal is the double-check: every charge on the account should be explained
 * by a receipt, and every receipt should correspond to a charge. Anything left
 * over on either side is what actually needs attention at tax time.
 *
 * Suggestions are never auto-confirmed. The matcher proposes, a human disposes.
 */

export interface MatchCandidate {
  transactionId: number;
  receiptId: number;
  confidence: number;
  method: string;
  transaction: { date: string; amount: number; counterparty: string | null };
  receipt: { filename: string; date: string | null; amount: number | null; vendor: string | null };
}

export interface MatchOptions {
  /** Widest gap, in days, between a receipt and its booking. */
  maxDayGap?: number;
  /** Relative amount tolerance, for FX-settled card charges. */
  amountTolerance?: number;
  /** Suggestions below this confidence are not recorded. */
  minConfidence?: number;
}

const DEFAULTS = {
  // Card purchases post up to a few days late, and a paper receipt can be
  // photographed later still. Beyond two weeks a same-amount coincidence is
  // more likely than a real pairing.
  maxDayGap: 14,
  // Card settlement in a foreign currency lands a few percent off the receipt.
  amountTolerance: 0.02,
  minConfidence: 0.5,
} as const;

interface TxRow {
  id: number;
  booking_date: string;
  amount: number;
  counterparty_raw: string | null;
}

interface ReceiptRow {
  id: number;
  filename: string;
  receipt_date: string | null;
  amount: number | null;
  vendor: string | null;
}

function daysBetween(a: string, b: string): number {
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.abs(Date.parse(a) - Date.parse(b)) / dayMs;
}

/**
 * Score one pairing in [0, 1], or null when the pair is not viable.
 *
 * Amount is a hard gate rather than a weighted term: a receipt for a different
 * sum is simply not the receipt for this charge, however well the date and
 * vendor line up.
 */
function score(tx: TxRow, receipt: ReceiptRow, options: Required<MatchOptions>): {
  confidence: number;
  method: string;
} | null {
  if (receipt.amount === null) return null;

  const difference = Math.abs(tx.amount - receipt.amount);
  const relative = difference / Math.max(tx.amount, 0.01);
  if (difference > 0.01 && relative > options.amountTolerance) return null;

  const parts: string[] = [];
  // Exact to the rappen is much stronger evidence than "within tolerance".
  let confidence = difference <= 0.01 ? 0.55 : 0.4;
  parts.push(difference <= 0.01 ? "amount" : "amount~");

  if (receipt.receipt_date) {
    const gap = daysBetween(tx.booking_date, receipt.receipt_date);
    if (gap > options.maxDayGap) return null;

    if (gap <= 1) {
      confidence += 0.3;
      parts.push("date");
    } else if (gap <= 4) {
      confidence += 0.2;
      parts.push("date~");
    } else {
      confidence += 0.08;
      parts.push("date~~");
    }
  }

  const similarity = nameSimilarity(tx.counterparty_raw, receipt.vendor ?? receipt.filename);
  if (similarity > 0) {
    confidence += 0.15 * similarity;
    parts.push(similarity >= 0.99 ? "name" : "name~");
  }

  return { confidence: Math.min(confidence, 1), method: parts.join("+") };
}

/**
 * Propose receipt matches for unmatched debits.
 *
 * Each transaction and each receipt is used at most once: candidates are ranked
 * globally by confidence and taken greedily, so the strongest pairing wins the
 * receipt rather than whichever transaction happened to be scanned first.
 */
export function findMatches(db: DatabaseSync, options: MatchOptions = {}): MatchCandidate[] {
  const settings: Required<MatchOptions> = {
    maxDayGap: options.maxDayGap ?? DEFAULTS.maxDayGap,
    amountTolerance: options.amountTolerance ?? DEFAULTS.amountTolerance,
    minConfidence: options.minConfidence ?? DEFAULTS.minConfidence,
  };

  const transactions = db
    .prepare(
      `SELECT t.id, t.booking_date, t.amount, t.counterparty_raw
       FROM bank_transaction t
       WHERE t.direction = 'DBIT'
         AND t.reversal = 0
         AND NOT EXISTS (
           SELECT 1 FROM tx_receipt_match m
           WHERE m.transaction_id = t.id AND m.status = 'confirmed'
         )
       ORDER BY t.booking_date`,
    )
    .all() as unknown as TxRow[];

  const receipts = db
    .prepare(
      `SELECT r.id, r.filename, r.receipt_date, r.amount, r.vendor
       FROM receipt r
       WHERE r.amount IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM tx_receipt_match m
           WHERE m.receipt_id = r.id AND m.status = 'confirmed'
         )`,
    )
    .all() as unknown as ReceiptRow[];

  const candidates: MatchCandidate[] = [];

  for (const tx of transactions) {
    for (const receipt of receipts) {
      const scored = score(tx, receipt, settings);
      if (!scored || scored.confidence < settings.minConfidence) continue;

      candidates.push({
        transactionId: tx.id,
        receiptId: receipt.id,
        confidence: Number(scored.confidence.toFixed(3)),
        method: scored.method,
        transaction: {
          date: tx.booking_date,
          amount: tx.amount,
          counterparty: tx.counterparty_raw,
        },
        receipt: {
          filename: receipt.filename,
          date: receipt.receipt_date,
          amount: receipt.amount,
          vendor: receipt.vendor,
        },
      });
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence);

  const usedTransactions = new Set<number>();
  const usedReceipts = new Set<number>();
  const chosen: MatchCandidate[] = [];

  for (const candidate of candidates) {
    if (usedTransactions.has(candidate.transactionId)) continue;
    if (usedReceipts.has(candidate.receiptId)) continue;
    usedTransactions.add(candidate.transactionId);
    usedReceipts.add(candidate.receiptId);
    chosen.push(candidate);
  }

  return chosen;
}

/** Record suggestions, leaving any human decision on the same pair untouched. */
export function saveMatches(db: DatabaseSync, matches: MatchCandidate[]): number {
  const insert = db.prepare(`
    INSERT INTO tx_receipt_match (transaction_id, receipt_id, confidence, method, status)
    VALUES (?, ?, ?, ?, 'suggested')
    ON CONFLICT (transaction_id, receipt_id) DO UPDATE SET
      confidence = excluded.confidence,
      method     = excluded.method
    WHERE tx_receipt_match.status = 'suggested'
  `);

  let written = 0;
  db.exec("BEGIN");
  try {
    for (const match of matches) {
      const result = insert.run(match.transactionId, match.receiptId, match.confidence, match.method);
      written += Number(result.changes);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return written;
}

export interface ReconciliationGaps {
  /** Debits with no confirmed or suggested receipt. */
  unmatchedTransactions: { id: number; date: string; amount: number; counterparty: string | null }[];
  /** Receipts with an amount but no candidate booking. */
  unmatchedReceipts: { id: number; filename: string; date: string | null; amount: number | null }[];
  /** Receipts still awaiting amount extraction. */
  pendingReceipts: number;
}

/** The two "needs attention" lists, plus how many receipts are not yet readable. */
export function reconciliationGaps(db: DatabaseSync): ReconciliationGaps {
  const unmatchedTransactions = db
    .prepare(
      `SELECT t.id, t.booking_date AS date, t.amount, t.counterparty_raw AS counterparty
       FROM bank_transaction t
       WHERE t.direction = 'DBIT'
         AND t.reversal = 0
         AND NOT EXISTS (
           SELECT 1 FROM tx_receipt_match m
           WHERE m.transaction_id = t.id AND m.status IN ('suggested', 'confirmed')
         )
       ORDER BY t.booking_date DESC`,
    )
    .all() as unknown as ReconciliationGaps["unmatchedTransactions"];

  const unmatchedReceipts = db
    .prepare(
      `SELECT r.id, r.filename, r.receipt_date AS date, r.amount
       FROM receipt r
       WHERE r.amount IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM tx_receipt_match m
           WHERE m.receipt_id = r.id AND m.status IN ('suggested', 'confirmed')
         )
       ORDER BY r.receipt_date DESC`,
    )
    .all() as unknown as ReconciliationGaps["unmatchedReceipts"];

  const pending = db
    .prepare(`SELECT COUNT(*) AS n FROM receipt WHERE amount IS NULL`)
    .get() as { n: number };

  return { unmatchedTransactions, unmatchedReceipts, pendingReceipts: pending.n };
}
