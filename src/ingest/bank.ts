import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseCamt053 } from "../camt/parse.ts";
import { counterpartyKey } from "../camt/normalize.ts";
import type { Statement } from "../camt/types.ts";

export interface ImportResult {
  file: string;
  statements: number;
  inserted: number;
  /** Entries already present, keyed by `acct_svcr_ref`. Re-imports are safe. */
  skipped: number;
}

/**
 * Insert a statement's entries.
 *
 * `INSERT OR IGNORE` against the unique `acct_svcr_ref` makes importing
 * idempotent, so the whole Drive folder can be re-run at any time without
 * producing duplicates or needing a watermark.
 */
function insertStatement(db: DatabaseSync, statement: Statement, sourceFile: string): {
  inserted: number;
  skipped: number;
} {
  const insertTx = db.prepare(`
    INSERT OR IGNORE INTO bank_transaction (
      acct_svcr_ref, iban, booking_date, value_date, amount, signed_amount,
      currency, direction, status, reversal, counterparty_raw, counterparty_key,
      counterparty_iban, qr_reference, remittance_info, additional_info,
      domain_code, family_code, sub_family_code, kind, source_file
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const balanceOf = (type: string): number | null => {
    const balance = statement.balances.find((entry) => entry.type === type);
    if (!balance) return null;
    return balance.direction === "DBIT" ? -balance.amount : balance.amount;
  };

  db.prepare(`
    INSERT OR IGNORE INTO bank_statement (
      statement_id, iban, electronic_seq_nb, from_date, to_date,
      opening_balance, closing_balance, currency, source_file
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    statement.id,
    statement.iban,
    statement.electronicSequenceNumber,
    statement.fromDate,
    statement.toDate,
    balanceOf("OPBD"),
    balanceOf("CLBD"),
    statement.currency,
    sourceFile,
  );

  let inserted = 0;
  let skipped = 0;

  for (const tx of statement.transactions) {
    const result = insertTx.run(
      tx.acctSvcrRef,
      tx.iban,
      tx.bookingDate,
      tx.valueDate,
      tx.amount,
      tx.signedAmount,
      tx.currency,
      tx.direction,
      tx.status,
      tx.reversal ? 1 : 0,
      tx.counterpartyRaw,
      counterpartyKey(tx.counterpartyRaw),
      tx.counterpartyIban,
      tx.qrReference,
      tx.remittanceInfo,
      tx.additionalInfo,
      tx.domainCode,
      tx.familyCode,
      tx.subFamilyCode,
      tx.kind,
      sourceFile,
    );

    if (result.changes > 0) inserted += 1;
    else skipped += 1;
  }

  return { inserted, skipped };
}

/** Import a single camt.053 file. */
export function importCamtFile(db: DatabaseSync, path: string): ImportResult {
  const statements = parseCamt053(readFileSync(path, "utf8"));
  const file = basename(path);

  let inserted = 0;
  let skipped = 0;

  // One transaction for the whole file: a half-imported statement is worse
  // than a failed one, since the balances would no longer reconcile.
  db.exec("BEGIN");
  try {
    for (const statement of statements) {
      const counts = insertStatement(db, statement, file);
      inserted += counts.inserted;
      skipped += counts.skipped;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { file, statements: statements.length, inserted, skipped };
}

/**
 * Import every camt file in a directory.
 *
 * Files that fail to parse are reported and skipped rather than aborting the
 * run — one malformed download should not block the rest of the month.
 */
export function importCamtDirectory(
  db: DatabaseSync,
  paths: string[],
): { results: ImportResult[]; failures: { file: string; error: string }[] } {
  const results: ImportResult[] = [];
  const failures: { file: string; error: string }[] = [];

  for (const path of paths) {
    try {
      results.push(importCamtFile(db, path));
    } catch (error) {
      failures.push({
        file: basename(path),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { results, failures };
}

/**
 * Statement sequence numbers missing between the lowest and highest imported.
 *
 * PostFinance numbers statements consecutively, so a gap means a day was never
 * downloaded and the books are silently incomplete.
 */
export function missingStatementSequences(db: DatabaseSync, iban: string): number[] {
  const rows = db
    .prepare(
      `SELECT electronic_seq_nb AS seq FROM bank_statement
       WHERE iban = ? AND electronic_seq_nb IS NOT NULL
       ORDER BY electronic_seq_nb`,
    )
    .all(iban) as { seq: number }[];

  if (rows.length === 0) return [];

  const present = new Set(rows.map((row) => row.seq));
  const first = rows[0]!.seq;
  const last = rows[rows.length - 1]!.seq;

  const missing: number[] = [];
  for (let seq = first; seq <= last; seq += 1) {
    if (!present.has(seq)) missing.push(seq);
  }
  return missing;
}
