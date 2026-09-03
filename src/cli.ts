#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { openDatabase } from "./db/index.ts";
import { importCamtDirectory, missingStatementSequences } from "./ingest/bank.ts";
import { importReceipts, type ReceiptInput } from "./ingest/receipts.ts";
import { detectFixedCosts, monthlyEquivalent, monthlyRunRate, saveFixedCosts } from "./analyze/fixed-costs.ts";
import { findMatches, reconciliationGaps, saveMatches } from "./match/receipts.ts";

const chf = (value: number): string =>
  value.toLocaleString("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function pad(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
}

function commandImport(files: string[]): void {
  if (files.length === 0) {
    console.error("usage: fgos import <camt-file.xml> [...]");
    process.exitCode = 1;
    return;
  }

  const db = openDatabase();
  const { results, failures } = importCamtDirectory(db, files);

  const inserted = results.reduce((sum, result) => sum + result.inserted, 0);
  const skipped = results.reduce((sum, result) => sum + result.skipped, 0);

  console.log(`Imported ${results.length} file(s): ${inserted} new entries, ${skipped} already present.`);

  for (const failure of failures) {
    console.error(`  failed: ${failure.file} — ${failure.error}`);
  }

  const ibans = db.prepare(`SELECT DISTINCT iban FROM bank_statement`).all() as { iban: string }[];
  for (const { iban } of ibans) {
    const missing = missingStatementSequences(db, iban);
    if (missing.length > 0) {
      console.warn(`  gap in ${iban}: statements ${missing.join(", ")} were never imported.`);
    }
  }

  db.close();
}

function commandReceipts(file: string | undefined): void {
  if (!file) {
    console.error("usage: fgos receipts <listing.json>");
    console.error("  listing.json: [{ driveFileId, filename, receiptDate?, amount?, vendor? }, ...]");
    process.exitCode = 1;
    return;
  }

  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) {
    console.error("Expected a JSON array of receipts.");
    process.exitCode = 1;
    return;
  }

  const db = openDatabase();
  const { inserted, updated } = importReceipts(db, parsed as ReceiptInput[]);
  console.log(`Receipts: ${inserted} new, ${updated} updated.`);
  db.close();
}

function commandFixedCosts(save: boolean): void {
  const db = openDatabase();
  const costs = detectFixedCosts(db);

  if (costs.length === 0) {
    console.log("No recurring charges detected yet — import more statements first.");
    db.close();
    return;
  }

  console.log(`${pad("Payee", 34)}${pad("Cadence", 11)}${"Typical".padStart(10)}${"Per month".padStart(11)}  Seen  Last`);
  console.log("-".repeat(88));

  for (const cost of costs) {
    const flag = cost.lapsed ? " (lapsed)" : "";
    console.log(
      pad(cost.displayName, 34) +
        pad(cost.cadence, 11) +
        chf(cost.typicalAmount).padStart(10) +
        chf(monthlyEquivalent(cost)).padStart(11) +
        String(cost.occurrences).padStart(6) +
        `  ${cost.lastSeen}${flag}`,
    );
  }

  console.log("-".repeat(88));
  console.log(`Monthly run rate (active only): CHF ${chf(monthlyRunRate(costs))}`);

  if (save) {
    saveFixedCosts(db, costs);
    console.log(`Saved ${costs.length} fixed cost(s).`);
  }

  db.close();
}

function commandMatch(save: boolean): void {
  const db = openDatabase();
  const matches = findMatches(db);

  if (matches.length === 0) {
    console.log("No new receipt matches proposed.");
  } else {
    console.log(`${matches.length} proposed match(es):\n`);
    for (const match of matches) {
      console.log(
        `  ${match.transaction.date}  CHF ${chf(match.transaction.amount).padStart(9)}  ` +
          `${pad(match.transaction.counterparty ?? "(unknown)", 28)}` +
          `→ ${pad(match.receipt.filename, 34)} ` +
          `${(match.confidence * 100).toFixed(0)}% [${match.method}]`,
      );
    }
    if (save) {
      console.log(`\nRecorded ${saveMatches(db, matches)} suggestion(s).`);
    }
  }

  db.close();
}

function commandGaps(): void {
  const db = openDatabase();
  const gaps = reconciliationGaps(db);

  console.log(`Charges with no receipt: ${gaps.unmatchedTransactions.length}`);
  for (const tx of gaps.unmatchedTransactions.slice(0, 25)) {
    console.log(`  ${tx.date}  CHF ${chf(tx.amount).padStart(9)}  ${tx.counterparty ?? "(unknown)"}`);
  }
  if (gaps.unmatchedTransactions.length > 25) {
    console.log(`  … and ${gaps.unmatchedTransactions.length - 25} more`);
  }

  console.log(`\nReceipts with no charge: ${gaps.unmatchedReceipts.length}`);
  for (const receipt of gaps.unmatchedReceipts.slice(0, 25)) {
    const amount = receipt.amount === null ? "        ?" : chf(receipt.amount).padStart(9);
    console.log(`  ${receipt.date ?? "??????????"}  CHF ${amount}  ${receipt.filename}`);
  }
  if (gaps.unmatchedReceipts.length > 25) {
    console.log(`  … and ${gaps.unmatchedReceipts.length - 25} more`);
  }

  if (gaps.pendingReceipts > 0) {
    console.log(`\n${gaps.pendingReceipts} receipt(s) still need an amount read off the file.`);
  }

  db.close();
}

function commandStats(): void {
  const db = openDatabase();

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN direction = 'DBIT' THEN amount END), 0) AS out,
              COALESCE(SUM(CASE WHEN direction = 'CRDT' THEN amount END), 0) AS in_,
              MIN(booking_date) AS first_date,
              MAX(booking_date) AS last_date
       FROM bank_transaction WHERE reversal = 0`,
    )
    .get() as { n: number; out: number; in_: number; first_date: string | null; last_date: string | null };

  if (totals.n === 0) {
    console.log("No transactions imported yet. Run: fgos import <camt files>");
    db.close();
    return;
  }

  const receipts = db.prepare(`SELECT COUNT(*) AS n FROM receipt`).get() as { n: number };
  const confirmed = db
    .prepare(`SELECT COUNT(*) AS n FROM tx_receipt_match WHERE status = 'confirmed'`)
    .get() as { n: number };

  console.log(`Period      ${totals.first_date} → ${totals.last_date}`);
  console.log(`Bookings    ${totals.n}`);
  console.log(`Out         CHF ${chf(totals.out)}`);
  console.log(`In          CHF ${chf(totals.in_)}`);
  console.log(`Net         CHF ${chf(totals.in_ - totals.out)}`);
  console.log(`Receipts    ${receipts.n} (${confirmed.n} confirmed against a charge)`);

  db.close();
}

const [command, ...args] = process.argv.slice(2);
const save = args.includes("--save");
const positional = args.filter((arg) => !arg.startsWith("--"));

switch (command) {
  case "import":
    commandImport(positional);
    break;
  case "receipts":
    commandReceipts(positional[0]);
    break;
  case "fixed-costs":
    commandFixedCosts(save);
    break;
  case "match":
    commandMatch(save);
    break;
  case "gaps":
    commandGaps();
    break;
  case "stats":
    commandStats();
    break;
  default:
    console.log(`Feelgood OS

  fgos import <file.xml> [...]   Import camt.053 bank statements
  fgos receipts <listing.json>   Register receipt files
  fgos match [--save]            Propose receipt ↔ charge matches
  fgos gaps                      Charges without receipts, and vice versa
  fgos fixed-costs [--save]      Detect recurring charges and the monthly run rate
  fgos stats                     Overview of what is imported

Database: ${process.env["FEELGOOD_DB"] ?? "data/feelgood.db"}`);
    if (command !== undefined) process.exitCode = 1;
}
