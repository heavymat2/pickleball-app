import type { DatabaseSync } from "node:sqlite";
import { counterpartyKey } from "../camt/normalize.ts";

/**
 * Receipt intake.
 *
 * Receipts live in Drive ("2026 Belege"), and Drive is reached through the MCP
 * tools in a Claude session rather than from this process. So the app takes a
 * plain list of files: a session lists the folder, hands the JSON over, and the
 * matching runs locally.
 *
 * Most receipts are photos with no text layer, so `amount` and `date` are
 * frequently unknown at intake and get filled in by a later extraction pass.
 */

export interface ReceiptInput {
  driveFileId?: string;
  filename: string;
  folderId?: string;
  /** ISO date of the purchase, not of the upload. */
  receiptDate?: string;
  amount?: number;
  currency?: string;
  vendor?: string;
  notes?: string;
}

/**
 * Filenames carrying this marker are excluded from client invoicing — the
 * convention the feelgood-rechnung skill already relies on. They still count
 * as business expenses, so they stay in the books.
 */
const DO_NOT_INVOICE = /nicht\s*verrechnen/i;

/** Leading `YYYY-MM-DD`, `YYYYMMDD` or `DD.MM.YYYY` in a filename. */
const DATE_PATTERNS: { pattern: RegExp; build: (m: RegExpMatchArray) => string }[] = [
  { pattern: /(\d{4})-(\d{2})-(\d{2})/, build: (m) => `${m[1]}-${m[2]}-${m[3]}` },
  { pattern: /(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/, build: (m) => `${m[1]}-${m[2]}-${m[3]}` },
  { pattern: /(\d{2})\.(\d{2})\.(\d{4})/, build: (m) => `${m[3]}-${m[2]}-${m[1]}` },
];

/**
 * Best-effort date from a filename.
 *
 * Only used when the caller supplies no date; a real date read off the receipt
 * always wins, since a file can be named long after the purchase.
 */
export function dateFromFilename(filename: string): string | null {
  for (const { pattern, build } of DATE_PATTERNS) {
    const match = filename.match(pattern);
    if (!match) continue;

    const iso = build(match);
    const parsed = new Date(`${iso}T00:00:00Z`);
    // Guard against a plausible-looking but invalid date like 2026-13-45.
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso) {
      return iso;
    }
  }
  return null;
}

export interface ReceiptImportResult {
  inserted: number;
  updated: number;
}

/**
 * Register receipts, keyed on the Drive file id so a re-listing updates rather
 * than duplicates. Values already known are not overwritten with nulls.
 */
export function importReceipts(db: DatabaseSync, receipts: ReceiptInput[]): ReceiptImportResult {
  const upsert = db.prepare(`
    INSERT INTO receipt (
      drive_file_id, filename, folder_id, receipt_date, amount, currency,
      vendor, vendor_key, do_not_invoice, extract_status, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (drive_file_id) DO UPDATE SET
      filename       = excluded.filename,
      folder_id      = COALESCE(excluded.folder_id, receipt.folder_id),
      receipt_date   = COALESCE(excluded.receipt_date, receipt.receipt_date),
      amount         = COALESCE(excluded.amount, receipt.amount),
      vendor         = COALESCE(excluded.vendor, receipt.vendor),
      vendor_key     = COALESCE(excluded.vendor_key, receipt.vendor_key),
      do_not_invoice = excluded.do_not_invoice,
      extract_status = CASE
        WHEN COALESCE(excluded.amount, receipt.amount) IS NOT NULL THEN 'parsed'
        ELSE receipt.extract_status
      END
  `);

  const existing = db.prepare(`SELECT 1 FROM receipt WHERE drive_file_id = ?`);

  let inserted = 0;
  let updated = 0;

  db.exec("BEGIN");
  try {
    for (const input of receipts) {
      const date = input.receiptDate ?? dateFromFilename(input.filename);
      const amount = input.amount ?? null;
      const isUpdate =
        input.driveFileId !== undefined && existing.get(input.driveFileId) !== undefined;

      upsert.run(
        input.driveFileId ?? null,
        input.filename,
        input.folderId ?? null,
        date,
        amount,
        input.currency ?? "CHF",
        input.vendor ?? null,
        counterpartyKey(input.vendor),
        DO_NOT_INVOICE.test(input.filename) ? 1 : 0,
        amount === null ? "pending" : "parsed",
        input.notes ?? null,
      );

      if (isUpdate) updated += 1;
      else inserted += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { inserted, updated };
}
