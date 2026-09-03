# Feelgood OS

Bookkeeping and CRM for Feelgood Kurmann — a Swiss Einzelunternehmen.

This implements the system specified in `CLAUDE.md` in the Buchhaltung project
folder. That spec is the authority; this repo is the code that runs it. Where
the two disagree, the spec wins and the code is wrong.

## Status

Built and tested (60 tests):

- **camt.053 parser** — PostFinance business-account statements
- **PDF statement extractor** — the private account, which offers no CSV export
- **Two-account logic** — the Privatentnahme / Privateinlage matrix
- **Kontoplan** — `kontoplan.csv` as the authority; accounts are never invented
- **Kontierung rules** — `kontierung-regeln.json`, append-only, hits counted
- **Year ledger** — append-only CSV, Storno instead of edits, strict year separation
- **Reconciliation** — receipt ↔ booking matching at exact amount, date ±3 days
- **Fixed-cost detection** — recurring charges and a monthly run rate

Not built yet: Notion mirror, RF-reference income matching, receipt amount
extraction, invoice generation hand-off, voice capture.

## Setup

Node 22.5+ (uses the built-in `node:sqlite`, no native deps) and Python 3.11+
with `pdfplumber` for the PDF path.

```bash
npm install
pip install pdfplumber
npm test
```

## The two-account matrix

The core principle, and the thing most easily got wrong. Account membership is
a property of the **booking**, not of the receipt:

| Booked on | Content | Becomes |
|---|---|---|
| Geschäftskonto | business | expense or income on its account |
| Geschäftskonto | private | **Privatentnahme** on 2850 |
| Privatkonto | business | the expense account, funded as **Privateinlage** |
| Privatkonto | purely private | **ignored** — never reaches the ledger |

Why this matters in figures: of CHF 22'464 total business expense in 2025,
CHF 18'303 was paid privately or by credit card. A bank-only import sees under
a fifth of the picture.

Health-insurance premiums are private wherever they are paid from — from the
business account they are a withdrawal, never an expense. The rules engine
derives this from content plus source account rather than from the rule's label,
so it holds on either account.

## The two bank sources

**Business account** — camt.053 XML, one file per booking day. Import is
idempotent on the bank's `AcctSvcrRef`, so re-running the folder is always safe,
and a gap in the statement sequence is reported: it means a day was never
downloaded and the books are quietly incomplete.

**Private account** — PDF only. This is the harder path, and two properties of
these PDFs make naive text extraction actively unsafe:

- **Reading order is scrambled.** Flattening the text layer interleaves
  descriptions and amounts from different bookings.
- **Credit and debit differ only by column position**, which flat text loses.
  The resulting sign errors are invisible.

So `scripts/extract_pdf_statement.py` works from word coordinates: it locates
the `Gutschrift` / `Lastschrift` / `Saldo` columns from the header row and
assigns every amount by position.

It also rejoins numbers split on the thousands separator. `1 065.28` arrives
from the extractor as two words, `1` and `065.28`; left alone it parses as
65.28 and CHF 1'000 vanishes. This is the *Tausender-Leerzeichen-Bug* recorded
in `kontierung-regeln.json`, and it is nastier than it looks — when every figure
on a page is truncated the same way, the balance arithmetic still reconciles
perfectly while being wrong by thousands. There are therefore two independent
checks, and a statement failing either is **rejected, not guessed at**:

1. Opening + credits − debits must equal the closing balance, *and* the
   extracted bookings must sum to the printed totals.
2. The coordinate-derived totals must agree with the totals read from the flat
   text layer — a separate code path, so agreement rules out a shared
   tokenization error.

`--allow-unreconciled` exists for inspection and must never be used to book.

## Categorization

Order is: rule file, then automatic assignment on a hit, otherwise **"zu
entscheiden"**. Never a guess. Only accounts present in `kontoplan.csv` are
used, and a rule naming an account outside it is reported as a defect.

Rules may branch on the receipt text — a photo lab bills both development
(4400 Drittdienstleister) and film (4200 Material). When the payee matches but
no branch does, the result is "zu entscheiden" rather than a coin flip, because
picking a branch is exactly what the branching exists to prevent.

The rule file is memory: entries are added and `treffer_anzahl` incremented,
never removed.

## The ledger

`buchhaltung-<jahr>.csv`, append-only, one file per tax year. Columns:

```
Datum | Betrag | Waehrung | Empfaenger | Konto-Quelle | Konto-Nr | Konto-Name
      | Typ | MwSt-Betrag | Beleg-Dateiname | Rechnungs-Nr | Periode | Notiz
```

Rows are never edited or deleted. A correction is a Storno row plus a fresh
row, so what was booked and when it was fixed both survive. The receipt date
decides the tax year; a row for another year is rejected rather than filed
under the wrong one. MWST is always 0 — the business is not MWST-pflichtig.

Dedupe is on date + amount + payee + source account, not on a bank reference,
because the private account arrives as PDF and has no reference to key on.

## Use

```bash
npm run fgos -- import statements/*.xml     # business account, camt.053
python3 scripts/extract_pdf_statement.py \
  statements/privat.pdf --out privat.json   # private account, PDF
npm run fgos -- receipts listing.json       # register receipt files
npm run fgos -- match --save                # propose receipt ↔ booking matches
npm run fgos -- gaps                        # unexplained on either side
npm run fgos -- fixed-costs --save          # recurring charges + run rate
npm run fgos -- stats
```

The working database is at `data/feelgood.db` (override with `FEELGOOD_DB`).
It is gitignored, as are statements and receipts — no financial data in the repo.

## Approval gates

Per the spec, nothing irreversible happens without an explicit go: renaming
receipt files, writing the ledger, pushing to Notion, sending an invoice,
saving a receipt out of email. The matcher proposes; a human confirms. Amounts,
account numbers and invoice numbers are never invented, and tax questions
(activation, Privatanteile) get a recommendation, not a decision.

## Layout

```
src/
  camt/         camt.053 parsing and counterparty normalization
  kontoplan/    chart of accounts
  kontierung/   rule engine and the two-account matrix
  ledger/       append-only year ledger and summaries
  money.ts      Swiss amount parsing — the thousands separators
  db/           working database schema
  ingest/       statement and receipt intake
  match/        receipt ↔ booking reconciliation
  analyze/      fixed-cost detection
scripts/
  extract_pdf_statement.py   private-account PDF extraction
test/
  fixtures/     synthetic camt.053, Kontoplan, and a PDF generator
```

Fixtures are synthetic. They mirror the structure of the real documents,
including the failure cases, without committing personal financial records.
