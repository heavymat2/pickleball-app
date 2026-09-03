import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseCamt053 } from "../src/camt/parse.ts";
import { counterpartyKey, merchantFromCardText, nameSimilarity } from "../src/camt/normalize.ts";
import { openDatabase } from "../src/db/index.ts";
import { importCamtFile, missingStatementSequences } from "../src/ingest/bank.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "camt053-sample.xml");
const statements = parseCamt053(readFileSync(fixture, "utf8"));

test("parses the statement header and balances", () => {
  assert.equal(statements.length, 1);
  const [statement] = statements;

  assert.equal(statement!.iban, "CH9300762011623852957");
  assert.equal(statement!.currency, "CHF");
  assert.equal(statement!.owner, "Example Studio Zürich");
  assert.equal(statement!.electronicSequenceNumber, 126);
  assert.equal(statement!.fromDate, "2026-06-30");
  assert.equal(statement!.toDate, "2026-06-30");

  const closing = statement!.balances.find((balance) => balance.type === "CLBD");
  assert.equal(closing?.amount, 1265.43);
  assert.equal(closing?.currency, "CHF");
});

test("reads every booked entry", () => {
  assert.equal(statements[0]!.transactions.length, 6);
});

test("prefers the ultimate party over a payment processor", () => {
  const viaProcessor = statements[0]!.transactions.find((tx) => tx.acctSvcrRef === "05162000EDDY671K")!;

  // Dbtr is the processor; UltmtDbtr is the client who actually paid. Filing
  // this against the processor would lose the customer entirely.
  assert.equal(viaProcessor.counterpartyRaw, "BEISPIEL MEDIA GMBH");
  // The account, unlike the name, belongs to the direct party.
  assert.equal(viaProcessor.counterpartyIban, "CH6109000000163845434");
});

test("keeps the invoice number from structured remittance", () => {
  const viaProcessor = statements[0]!.transactions.find((tx) => tx.acctSvcrRef === "05162000EDDY671K")!;

  // The invoice number appears only in AddtlRmtInf, and it is the hook for
  // tying an incoming payment to a project.
  assert.equal(viaProcessor.remittanceInfo, "Rechnung: 0000000175");
  // A SCOR creditor reference lands in the same field as a Swiss QR reference.
  assert.equal(viaProcessor.qrReference, "RF32000000175");
});

test("signs debits negative and credits positive", () => {
  const byRef = new Map(statements[0]!.transactions.map((tx) => [tx.acctSvcrRef, tx]));

  const debit = byRef.get("18162000EW0LLG0K")!;
  assert.equal(debit.direction, "DBIT");
  assert.equal(debit.amount, 90.25);
  assert.equal(debit.signedAmount, -90.25);

  const credit = byRef.get("18163000980001111")!;
  assert.equal(credit.direction, "CRDT");
  assert.equal(credit.signedAmount, 1200);
});

test("takes the counterparty from the side that is not the account holder", () => {
  const byRef = new Map(statements[0]!.transactions.map((tx) => [tx.acctSvcrRef, tx]));

  // On a debit the counterparty is the creditor we paid.
  assert.equal(byRef.get("18162000EW0LLG0K")!.counterpartyRaw, "Example Telecom SA");
  // On a credit it is the debtor who paid us.
  assert.equal(byRef.get("18163000980001111")!.counterpartyRaw, "Beispiel Hotel GmbH");
});

test("recovers the merchant from card entries, which carry no structured party", () => {
  const byRef = new Map(statements[0]!.transactions.map((tx) => [tx.acctSvcrRef, tx]));

  assert.equal(byRef.get("18163000956905140")!.counterpartyRaw, "EXAMPLE TELECOM SA");
  assert.equal(byRef.get("18163000974199630")!.counterpartyRaw, "EXAMPLE CAMERA AG ZÜRICH");
});

test("keeps the QR reference as a string", () => {
  const debit = statements[0]!.transactions.find((tx) => tx.acctSvcrRef === "18162000EW0LLG0K")!;
  // Numeric parsing would destroy the leading zeros this reference depends on.
  assert.equal(debit.qrReference, "000000000000000009604749054");
});

test("captures unstructured remittance text", () => {
  const credit = statements[0]!.transactions.find((tx) => tx.acctSvcrRef === "18163000980001111")!;
  assert.equal(credit.remittanceInfo, "Rechnung 189 Fotoshooting Juni");
});

test("classifies entries by bank transaction code", () => {
  const kinds = Object.fromEntries(
    statements[0]!.transactions.map((tx) => [tx.acctSvcrRef, tx.kind]),
  );

  assert.equal(kinds["18162000EW0LLG0K"], "direct_debit");
  assert.equal(kinds["18163000956905140"], "card");
  assert.equal(kinds["18163000980001111"], "transfer");
});

test("rejects a document that is not camt.053", () => {
  assert.throws(() => parseCamt053("<Document><Something/></Document>"), /camt\.053/);
});

test("two identical charges on one day are two transactions", () => {
  // Same amount, same day, same payee, same QR reference — distinguished only
  // by AcctSvcrRef. Deduping on the visible fields would silently lose one.
  const sameAmount = statements[0]!.transactions.filter((tx) => tx.amount === 90.25);
  assert.equal(sameAmount.length, 2);
  assert.notEqual(sameAmount[0]!.acctSvcrRef, sameAmount[1]!.acctSvcrRef);
  assert.equal(sameAmount[0]!.qrReference, sameAmount[1]!.qrReference);
});

test("re-importing the same file inserts nothing further", () => {
  const db = openDatabase(":memory:");

  const first = importCamtFile(db, fixture);
  assert.equal(first.inserted, 6);
  assert.equal(first.skipped, 0);

  const second = importCamtFile(db, fixture);
  assert.equal(second.inserted, 0);
  assert.equal(second.skipped, 6);

  const count = db.prepare("SELECT COUNT(*) AS n FROM bank_transaction").get() as { n: number };
  assert.equal(count.n, 6);

  db.close();
});

test("import stores the normalized grouping key alongside the raw name", () => {
  const db = openDatabase(":memory:");
  importCamtFile(db, fixture);

  const row = db
    .prepare("SELECT counterparty_raw, counterparty_key FROM bank_transaction WHERE acct_svcr_ref = ?")
    .get("18162000EW0LLG0K") as { counterparty_raw: string; counterparty_key: string };

  assert.equal(row.counterparty_raw, "Example Telecom SA");
  // Legal form dropped, so the card entry and the direct debit group together.
  assert.equal(row.counterparty_key, "EXAMPLE TELECOM");

  db.close();
});

test("reports gaps in the statement sequence", () => {
  const db = openDatabase(":memory:");
  const insert = db.prepare(
    "INSERT INTO bank_statement (statement_id, iban, electronic_seq_nb) VALUES (?, 'CH99', ?)",
  );
  for (const seq of [10, 11, 14, 15]) insert.run(`s${seq}`, seq);

  assert.deepEqual(missingStatementSequences(db, "CH99"), [12, 13]);
  assert.deepEqual(missingStatementSequences(db, "CH00"), []);

  db.close();
});

test("counterpartyKey folds case, accents and legal forms", () => {
  assert.equal(counterpartyKey("Salt Mobile SA"), "SALT MOBILE");
  assert.equal(counterpartyKey("GRAPHICART AG ZÜRICH"), "GRAPHICART ZURICH");
  assert.equal(counterpartyKey("  "), null);
  assert.equal(counterpartyKey(null), null);
  // Dots and slashes survive, so domain-style merchants stay intact.
  assert.equal(counterpartyKey("APPLE.COM/BILL"), "APPLE.COM/BILL");
});

test("merchantFromCardText stops at the trailing reference noise", () => {
  assert.equal(
    merchantFromCardText("KAUF/ONLINE-SHOPPING VOM 29.06.2026 KARTEN NR. XXXX8247 SALT MOBILE SA N/A PAYMENT ID 260629131800613492"),
    "SALT MOBILE SA",
  );
  assert.equal(
    merchantFromCardText("APPLE PAY KAUF/DIENSTLEISTUNG VOM 30.06.2026 KARTEN NR. XXXX8247 GRAPHICART AG ZÜRICH (CH)"),
    "GRAPHICART AG ZÜRICH",
  );
  // Not a card entry: return null rather than guessing at a merchant.
  assert.equal(merchantFromCardText("LASTSCHRIFT UBS SWITZERLAND AG SALT MOBILE SA"), null);
  assert.equal(merchantFromCardText(null), null);
});

test("nameSimilarity scores against the shorter side", () => {
  // A receipt naming only the brand still matches the bank's noisier string.
  assert.equal(nameSimilarity("APPLE.COM/BILL CORK", "Apple"), 1);
  assert.equal(nameSimilarity("Salt Mobile SA", "Salt Mobile"), 1);
  assert.equal(nameSimilarity("Salt Mobile SA", "Migros"), 0);
  assert.equal(nameSimilarity(null, "Migros"), 0);
});
