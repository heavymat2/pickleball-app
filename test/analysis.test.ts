import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "../src/db/index.ts";
import { counterpartyKey } from "../src/camt/normalize.ts";
import { detectFixedCosts, monthlyEquivalent, monthlyRunRate, saveFixedCosts } from "../src/analyze/fixed-costs.ts";
import { findMatches, reconciliationGaps, saveMatches } from "../src/match/receipts.ts";
import { dateFromFilename, importReceipts } from "../src/ingest/receipts.ts";

let sequence = 0;

/** Insert a debit; the reference only has to be unique. */
function addDebit(db: DatabaseSync, date: string, amount: number, payee: string): void {
  sequence += 1;
  db.prepare(
    `INSERT INTO bank_transaction
       (acct_svcr_ref, iban, booking_date, amount, signed_amount, direction,
        counterparty_raw, counterparty_key, kind)
     VALUES (?, 'CH99', ?, ?, ?, 'DBIT', ?, ?, 'card')`,
  ).run(`ref-${sequence}`, date, amount, -amount, payee, counterpartyKey(payee));
}

/** Twelve monthly charges on the 3rd, for a payee billing a steady amount. */
function addMonthly(db: DatabaseSync, payee: string, amount: number, months = 12): void {
  for (let month = 1; month <= months; month += 1) {
    addDebit(db, `2026-${String(month).padStart(2, "0")}-03`, amount, payee);
  }
}

test("detects a monthly subscription", () => {
  const db = openDatabase(":memory:");
  addMonthly(db, "Adobe Systems", 62.9);

  const [cost, ...rest] = detectFixedCosts(db);
  assert.equal(rest.length, 0);
  assert.equal(cost!.cadence, "monthly");
  assert.equal(cost!.typicalAmount, 62.9);
  assert.equal(cost!.occurrences, 12);
  assert.equal(cost!.regularity, 1);
  assert.equal(cost!.lapsed, false);

  db.close();
});

test("counts two charges in one month as one monthly cost", () => {
  const db = openDatabase(":memory:");
  // The same payee billing twice on one day is the real PostFinance case that
  // naive day-gap logic reads as a zero-day interval.
  for (let month = 1; month <= 6; month += 1) {
    const date = `2026-${String(month).padStart(2, "0")}-30`;
    addDebit(db, date, 90.25, "Salt Mobile SA");
    addDebit(db, date, 90.25, "Salt Mobile SA");
  }

  const [cost] = detectFixedCosts(db);
  assert.equal(cost!.cadence, "monthly");
  assert.equal(cost!.occurrences, 6);
  // The monthly commitment is both lines, not one of them.
  assert.equal(cost!.typicalAmount, 180.5);

  db.close();
});

test("ignores a payee whose amount swings too widely", () => {
  const db = openDatabase(":memory:");
  const amounts = [12, 180, 34, 9, 210, 45, 88, 15, 260, 30, 74, 19];
  amounts.forEach((amount, index) => {
    addDebit(db, `2026-${String(index + 1).padStart(2, "0")}-11`, amount, "Migros");
  });

  assert.deepEqual(detectFixedCosts(db), []);
  db.close();
});

test("ignores a payee seen only twice", () => {
  const db = openDatabase(":memory:");
  addDebit(db, "2026-01-05", 50, "Rare Vendor");
  addDebit(db, "2026-02-05", 50, "Rare Vendor");

  assert.deepEqual(detectFixedCosts(db), []);
  db.close();
});

test("recognizes a quarterly cadence", () => {
  const db = openDatabase(":memory:");
  for (const month of ["01", "04", "07", "10"]) {
    addDebit(db, `2026-${month}-15`, 300, "Versicherung AG");
  }

  const [cost] = detectFixedCosts(db);
  assert.equal(cost!.cadence, "quarterly");
  assert.equal(cost!.typicalAmount, 300);
  // A quarterly CHF 300 is CHF 100 a month.
  assert.equal(monthlyEquivalent(cost!), 100);

  db.close();
});

test("flags a subscription that stopped posting", () => {
  const db = openDatabase(":memory:");
  // Ends well over two months before "now", whenever the suite runs.
  const year = new Date().getUTCFullYear() - 2;
  for (let month = 1; month <= 6; month += 1) {
    addDebit(db, `${year}-${String(month).padStart(2, "0")}-08`, 25, "Old Tool");
  }

  const [cost] = detectFixedCosts(db);
  assert.equal(cost!.lapsed, true);
  // A lapsed cost is not part of what you pay now.
  assert.equal(monthlyRunRate([cost!]), 0);

  db.close();
});

test("run rate sums cadence-normalized costs, biggest first", () => {
  const db = openDatabase(":memory:");
  addMonthly(db, "Studio Miete", 800);
  addMonthly(db, "Adobe Systems", 62.9);
  for (const month of ["01", "04", "07", "10"]) {
    addDebit(db, `2026-${month}-15`, 300, "Versicherung AG");
  }

  const costs = detectFixedCosts(db);
  assert.deepEqual(costs.map((cost) => cost.displayName), [
    "Studio Miete",
    "Versicherung AG",
    "Adobe Systems",
  ]);
  assert.equal(monthlyRunRate(costs), 962.9);

  db.close();
});

test("saving fixed costs is idempotent", () => {
  const db = openDatabase(":memory:");
  addMonthly(db, "Adobe Systems", 62.9);

  saveFixedCosts(db, detectFixedCosts(db));
  saveFixedCosts(db, detectFixedCosts(db));

  const count = db.prepare("SELECT COUNT(*) AS n FROM fixed_cost").get() as { n: number };
  assert.equal(count.n, 1);

  db.close();
});

test("matches a receipt to a charge on amount, date and vendor", () => {
  const db = openDatabase(":memory:");
  addDebit(db, "2026-03-12", 85, "EXAMPLE CAMERA AG ZÜRICH");
  importReceipts(db, [
    { driveFileId: "d1", filename: "2026-03-12_ExampleCamera_Stativ.pdf", amount: 85, vendor: "Example Camera" },
  ]);

  const [match, ...rest] = findMatches(db);
  assert.equal(rest.length, 0);
  assert.equal(match!.receipt.filename, "2026-03-12_ExampleCamera_Stativ.pdf");
  assert.ok(match!.confidence > 0.9, `expected high confidence, got ${match!.confidence}`);
  assert.match(match!.method, /amount\+date/);

  db.close();
});

test("does not match a receipt for a different amount", () => {
  const db = openDatabase(":memory:");
  addDebit(db, "2026-03-12", 85, "Example Camera AG");
  importReceipts(db, [
    { driveFileId: "d1", filename: "2026-03-12_ExampleCamera.pdf", amount: 240, vendor: "Example Camera" },
  ]);

  assert.deepEqual(findMatches(db), []);
  db.close();
});

test("does not match a receipt months away from the charge", () => {
  const db = openDatabase(":memory:");
  addDebit(db, "2026-03-12", 85, "Example Camera AG");
  importReceipts(db, [
    { driveFileId: "d1", filename: "2026-09-12_ExampleCamera.pdf", amount: 85, vendor: "Example Camera" },
  ]);

  assert.deepEqual(findMatches(db), []);
  db.close();
});

test("each receipt is claimed by only one charge", () => {
  const db = openDatabase(":memory:");
  // Two identical charges, one receipt: exactly one pairing may be proposed.
  addDebit(db, "2026-03-12", 85, "Example Camera AG");
  addDebit(db, "2026-03-12", 85, "Example Camera AG");
  importReceipts(db, [
    { driveFileId: "d1", filename: "2026-03-12_ExampleCamera.pdf", amount: 85, vendor: "Example Camera" },
  ]);

  assert.equal(findMatches(db).length, 1);
  db.close();
});

test("tolerates a small FX difference but records it as approximate", () => {
  const db = openDatabase(":memory:");
  addDebit(db, "2026-03-12", 100, "Example Shop");
  importReceipts(db, [
    { driveFileId: "d1", filename: "2026-03-12_ExampleShop.pdf", amount: 101.5, vendor: "Example Shop" },
  ]);

  const [match] = findMatches(db);
  assert.match(match!.method, /amount~/);
  db.close();
});

test("gaps list both unexplained charges and unused receipts", () => {
  const db = openDatabase(":memory:");
  addDebit(db, "2026-03-12", 85, "Example Camera AG");
  addDebit(db, "2026-03-14", 42, "Mystery Vendor");
  importReceipts(db, [
    { driveFileId: "d1", filename: "2026-03-12_ExampleCamera.pdf", amount: 85, vendor: "Example Camera" },
    { driveFileId: "d2", filename: "2026-03-20_Orphan.pdf", amount: 999, vendor: "Orphan" },
    { driveFileId: "d3", filename: "photo-of-a-receipt.jpg" },
  ]);

  saveMatches(db, findMatches(db));
  const gaps = reconciliationGaps(db);

  assert.deepEqual(gaps.unmatchedTransactions.map((tx) => tx.amount), [42]);
  assert.deepEqual(gaps.unmatchedReceipts.map((receipt) => receipt.filename), ["2026-03-20_Orphan.pdf"]);
  // The photo has no amount yet, so it is pending rather than unmatched.
  assert.equal(gaps.pendingReceipts, 1);

  db.close();
});

test("re-registering a receipt updates rather than duplicates", () => {
  const db = openDatabase(":memory:");
  const first = importReceipts(db, [{ driveFileId: "d1", filename: "receipt.jpg" }]);
  assert.deepEqual(first, { inserted: 1, updated: 0 });

  // A later extraction pass supplies the amount read off the image.
  const second = importReceipts(db, [{ driveFileId: "d1", filename: "receipt.jpg", amount: 42.5 }]);
  assert.deepEqual(second, { inserted: 0, updated: 1 });

  const row = db
    .prepare("SELECT amount, extract_status FROM receipt WHERE drive_file_id = 'd1'")
    .get() as { amount: number; extract_status: string };
  assert.equal(row.amount, 42.5);
  assert.equal(row.extract_status, "parsed");

  db.close();
});

test("a known amount is not wiped by a later listing that lacks one", () => {
  const db = openDatabase(":memory:");
  importReceipts(db, [{ driveFileId: "d1", filename: "receipt.jpg", amount: 42.5 }]);
  importReceipts(db, [{ driveFileId: "d1", filename: "receipt.jpg" }]);

  const row = db.prepare("SELECT amount FROM receipt WHERE drive_file_id = 'd1'").get() as { amount: number };
  assert.equal(row.amount, 42.5);

  db.close();
});

test("marks receipts flagged as not for invoicing", () => {
  const db = openDatabase(":memory:");
  importReceipts(db, [
    { driveFileId: "d1", filename: "2026-03-12_Kaffee nicht verrechnen.jpg", amount: 6.5 },
    { driveFileId: "d2", filename: "2026-03-12_Taxi Gurten.jpg", amount: 32 },
  ]);

  const flagged = db
    .prepare("SELECT filename FROM receipt WHERE do_not_invoice = 1")
    .all() as { filename: string }[];
  assert.deepEqual(flagged.map((row) => row.filename), ["2026-03-12_Kaffee nicht verrechnen.jpg"]);

  db.close();
});

test("reads a date out of a filename in any of the formats in use", () => {
  assert.equal(dateFromFilename("2026-03-12_Migros.pdf"), "2026-03-12");
  assert.equal(dateFromFilename("20260312_Migros.pdf"), "2026-03-12");
  assert.equal(dateFromFilename("Beleg 12.03.2026 Migros.pdf"), "2026-03-12");
  assert.equal(dateFromFilename("IMG_4821.jpg"), null);
  // Well-formed but impossible, so not a date.
  assert.equal(dateFromFilename("2026-13-45_Migros.pdf"), null);
});
