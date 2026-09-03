# Feelgood OS

Bookkeeping and CRM for Feelgood Kurmann. Replaces the parts of the Notion
setup that Notion is bad at — reconciling a bank account against a folder of
receipts, and knowing what the fixed costs actually are.

The app owns the bookkeeping data. Notion stays as the visual layer and is
written back to, rather than being the source of truth. That split exists
because the Notion databases disagree with each other: `Einnahmen` carries
CHF 15'133 across 9 rows while `Projekte` carries CHF 54'429, and neither is
reconciled against the bank.

## Status

Built and tested:

- **camt.053 parser** — PostFinance daily statements (`camt.053.001.08`)
- **Idempotent import** — re-running a folder never duplicates
- **Receipt registry** — receipts from Drive, with amounts filled in later
- **Reconciliation** — proposes receipt ↔ charge matches, lists both gap sides
- **Fixed-cost detection** — infers recurring charges and a monthly run rate

Not built yet: Notion sync, project-payment matching, receipt amount
extraction (OCR/vision), invoice generation hand-off, voice capture.

## Setup

Needs Node 22.5+ (for the built-in `node:sqlite` — there are no native
dependencies).

```bash
npm install
npm test
```

## Use

```bash
npm run fgos -- import statements/*.xml   # import camt.053 files
npm run fgos -- receipts listing.json     # register receipt files
npm run fgos -- match --save              # propose receipt ↔ charge matches
npm run fgos -- gaps                      # what is unexplained on either side
npm run fgos -- fixed-costs --save        # recurring charges + monthly run rate
npm run fgos -- stats                     # overview
```

The database lives at `data/feelgood.db`; override with `FEELGOOD_DB`. It is
gitignored, as are statements and receipts — no financial data in the repo.

### Getting statements in

PostFinance already delivers camt.053 files daily to Drive (one file per
booking day). Download the folder locally and point `import` at it. Import is
keyed on the bank's own `AcctSvcrRef`, so re-importing the whole folder is
always safe, and `import` warns when a statement sequence number is missing —
meaning a day was never downloaded and the books are silently incomplete.

### Getting receipts in

Receipts live in Drive ("2026 Belege"), reached through MCP in a Claude
session rather than from this process. So `receipts` takes a JSON listing:

```json
[
  { "driveFileId": "1abc…", "filename": "2026-06-30_Graphicart_Stativ.pdf",
    "amount": 85.00, "vendor": "Graphicart" },
  { "driveFileId": "1def…", "filename": "IMG_9931.jpg" }
]
```

`amount` and `receiptDate` are optional — most receipts are photos with no text
layer. Re-running the listing with amounts filled in updates rather than
duplicates, and never overwrites a known value with a null.

A filename containing "nicht verrechnen" is flagged `do_not_invoice`, matching
the convention the `feelgood-rechnung` skill already uses. Those still count as
business expenses; they are only excluded from client invoices.

## How it works

### Dedupe

Imports key on `AcctSvcrRef`, the bank's own reference. Deduping on
(date, amount, payee) would be wrong: PostFinance genuinely books two identical
charges on the same day with the same QR reference, and one would be lost.

### Counterparty

On a debit the counterparty is the creditor; on a credit, the debtor. Where an
*ultimate* party is present it wins — payments through a processor name the
processor as debtor and the actual client as ultimate debtor, so without this a
client payment arriving via a processor would be filed against the processor.

Card entries carry no structured party at all; the merchant is recovered from
the free-text line, which is the only place it appears.

### Fixed costs

Charges are bucketed per calendar month and summed before any cadence
reasoning, because a subscription can post as two lines on one day. A payee
qualifies on three counts: it appears in enough distinct months, its per-month
total stays within a 2.5x spread, and it covers enough of the expected periods.
Quarterly and yearly charges are normalized to a monthly equivalent so the run
rate is comparable. A charge that stops posting is marked lapsed rather than
deleted.

### Matching

Amount is a hard gate, not a weighted term: a receipt for a different sum is
not the receipt, however well the date and vendor line up. A small relative
difference is tolerated for card charges settled in a foreign currency, and
recorded as approximate. Candidates are ranked globally and taken greedily, so
each receipt and each charge is used at most once.

Nothing is auto-confirmed. The matcher proposes; a human confirms. The point of
the exercise is that someone agrees the receipt explains the charge.

## Layout

```
src/
  camt/       camt.053 parsing and counterparty normalization
  db/         schema and connection
  ingest/     bank statement and receipt intake
  match/      receipt ↔ charge reconciliation
  analyze/    fixed-cost detection
  cli.ts      command line entry point
test/
  fixtures/   synthetic camt.053 mirroring real PostFinance structure
```

## Notes on the data model

`client` and `project` mirror the Notion `Kunden` and `Projekte` databases so a
sync has somewhere to land. `project_payment` exists so Notion's `Payment`
field can eventually be driven by the bank rather than by hand.

The schema is applied with `IF NOT EXISTS` on every open, which is additive-only
migration. Once the shape settles and there is data worth protecting, this wants
real versioned migrations.
