/**
 * Turning PostFinance's free text into something groupable.
 *
 * Card entries (`CCRD`/`POSD`) carry no structured counterparty — the merchant
 * exists only inside the `AddtlNtryInf` sentence. Direct debits and transfers
 * do carry a structured name, so those never come through here.
 */

/** Legal forms dropped when building a grouping key, so "Salt Mobile SA" and "Salt Mobile" collapse together. */
const LEGAL_FORMS = new Set([
  "AG", "SA", "GMBH", "SARL", "SAGL", "LTD", "LIMITED", "INC", "LLC", "PLC",
  "BV", "NV", "GBR", "KG", "OHG", "EG", "SE", "SPA", "SRL", "AS", "AB", "OY",
]);

/**
 * Markers that terminate the merchant name inside a card entry's text. The
 * merchant sits between the card number and whichever of these comes first.
 */
const MERCHANT_TERMINATORS = [
  " PAYMENT ID ",
  " BESTELLNUMMER ",
  " SENDER REFERENZ",
  " REFERENZ:",
  " N/A",
];

const CARD_PREFIX = /KARTEN\s*NR\.?\s*[X*]+\d+\s+/i;

/**
 * Pull the merchant out of a card entry's free-text line.
 *
 * "APPLE PAY KAUF/DIENSTLEISTUNG VOM 30.06.2026 KARTEN NR. XXXX8247 GRAPHICART AG ZÜRICH (CH)"
 *   -> "GRAPHICART AG ZÜRICH"
 *
 * Returns null when the text does not look like a card entry, rather than
 * guessing — a wrong merchant is worse than an unresolved one.
 */
export function merchantFromCardText(text: string | null | undefined): string | null {
  if (!text) return null;

  const afterCard = text.split(CARD_PREFIX)[1];
  if (afterCard === undefined) return null;

  let merchant = afterCard;
  for (const terminator of MERCHANT_TERMINATORS) {
    const at = merchant.toUpperCase().indexOf(terminator);
    if (at !== -1) merchant = merchant.slice(0, at);
  }

  // Trailing country marker, e.g. "GRAPHICART AG ZÜRICH (CH)".
  merchant = merchant.replace(/\s*\([A-Z]{2}\)\s*$/, "");
  merchant = merchant.trim();

  return merchant.length > 0 ? merchant : null;
}

/**
 * Collapse a counterparty name to a stable grouping key.
 *
 * Used to decide whether two bookings are the same payee — for recurring-cost
 * detection and for matching receipts. Deliberately lossy; always keep the raw
 * name for display.
 */
export function counterpartyKey(name: string | null | undefined): string | null {
  if (!name) return null;

  const cleaned = name
    .toUpperCase()
    .normalize("NFD")
    // Strip combining diacritics so "ZÜRICH" and "ZURICH" agree.
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s*\([A-Z]{2}\)\s*$/, "")
    // Punctuation to spaces, but keep "." and "/" so "APPLE.COM/BILL" survives.
    .replace(/[^A-Z0-9./\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = cleaned
    .split(" ")
    .filter((token) => token.length > 0 && !LEGAL_FORMS.has(token));

  return tokens.length > 0 ? tokens.join(" ") : null;
}

/** Tokens of a grouping key, for overlap scoring. */
export function keyTokens(name: string | null | undefined): string[] {
  const key = counterpartyKey(name);
  if (!key) return [];
  return key.split(/[\s./]+/).filter((token) => token.length > 1);
}

/**
 * Similarity of two counterparty names in [0, 1].
 *
 * Token-overlap over the smaller side, so "APPLE.COM/BILL CORK" still scores
 * 1 against "Apple" — a receipt rarely repeats the bank's city and noise
 * tokens, and penalizing it for that would lose real matches.
 */
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const left = new Set(keyTokens(a));
  const right = new Set(keyTokens(b));
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;

  return shared / Math.min(left.size, right.size);
}
