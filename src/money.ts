/**
 * Swiss amount parsing.
 *
 * PostFinance writes thousands separators three different ways depending on
 * the document: a plain space in PDF statements ("1 953.55"), an apostrophe in
 * invoices and exports ("4'669.45"), and nothing at all in camt.053 XML
 * ("4669.45"). A narrow no-break space also shows up in some PDF text layers.
 *
 * Getting this wrong is not a rounding error: reading "4 669.45" as 669.45
 * loses CHF 4'000 silently, which is a bug this project has already hit once
 * (recorded against the vehicle Privatanteil in kontierung-regeln.json).
 */

/** Separators that may appear between thousands groups. */
const THOUSANDS = /[\s   ']/g;

/**
 * A Swiss-formatted amount: optional sign, digits in groups of three separated
 * by space or apostrophe, and an optional two-decimal fraction. Anchored, so a
 * string carrying anything else is rejected rather than partly parsed.
 */
const SWISS_AMOUNT =
  /^[+-]?\d{1,3}(?:[\s   ']\d{3})*(?:[.,]\d{1,2})?$|^[+-]?\d+(?:[.,]\d{1,2})?$/;

/**
 * Parse a Swiss-formatted amount, or return null when the text is not one.
 *
 * Returns null rather than a partial number: in bookkeeping a wrong amount is
 * far worse than a missing one, because only the missing one gets noticed.
 */
export function parseSwissAmount(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null;

  const trimmed = text.trim();
  if (trimmed === "" || !SWISS_AMOUNT.test(trimmed)) return null;

  const normalized = trimmed.replace(THOUSANDS, "").replace(",", ".");
  const value = Number(normalized);

  return Number.isFinite(value) ? value : null;
}

/** Format for display in Swiss convention, e.g. 1234.5 -> "1'234.50". */
export function formatChf(value: number): string {
  const fixed = Math.abs(value).toFixed(2);
  const [whole = "0", fraction = "00"] = fixed.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return `${value < 0 ? "-" : ""}${grouped}.${fraction}`;
}

/**
 * Round to rappen.
 *
 * Amounts are summed as floats, so a ledger total can drift by fractions of a
 * rappen. Round at the boundary where a figure is written or compared, never
 * mid-calculation.
 */
export function toRappen(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Whether two amounts agree to the rappen, tolerating float drift. */
export function amountsEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}
