-- Feelgood OS bookkeeping schema.
--
-- The app owns this data; Notion is a downstream view that gets written back.
-- Money is stored in the account currency as REAL, matching what the bank
-- reports, with `signed_amount` negative for debits so sums work directly.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Bank
-- ---------------------------------------------------------------------------

-- One booked entry from a camt.053 statement.
CREATE TABLE IF NOT EXISTS bank_transaction (
  id                INTEGER PRIMARY KEY,
  -- The bank's reference for the booking. Stable across re-downloads, so it is
  -- the idempotency key: re-importing a statement must not duplicate rows.
  -- Deduping on (date, amount, counterparty) would be wrong — PostFinance does
  -- book two identical charges on one day.
  acct_svcr_ref     TEXT    NOT NULL UNIQUE,
  iban              TEXT    NOT NULL,
  booking_date      TEXT    NOT NULL,
  value_date        TEXT,
  amount            REAL    NOT NULL,
  signed_amount     REAL    NOT NULL,
  currency          TEXT    NOT NULL DEFAULT 'CHF',
  direction         TEXT    NOT NULL CHECK (direction IN ('DBIT', 'CRDT')),
  status            TEXT,
  reversal          INTEGER NOT NULL DEFAULT 0,
  counterparty_raw  TEXT,
  -- Normalized grouping key; recurring-cost detection groups on this.
  counterparty_key  TEXT,
  counterparty_iban TEXT,
  qr_reference      TEXT,
  remittance_info   TEXT,
  additional_info   TEXT,
  domain_code       TEXT,
  family_code       TEXT,
  sub_family_code   TEXT,
  kind              TEXT    NOT NULL DEFAULT 'other',
  source_file       TEXT,
  imported_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tx_booking_date ON bank_transaction (booking_date);
CREATE INDEX IF NOT EXISTS idx_tx_counterparty ON bank_transaction (counterparty_key);
CREATE INDEX IF NOT EXISTS idx_tx_direction    ON bank_transaction (direction, booking_date);

-- Statement-level record, kept so gaps in the daily sequence are detectable:
-- a missing electronic_seq_nb means a statement was never downloaded.
CREATE TABLE IF NOT EXISTS bank_statement (
  id                INTEGER PRIMARY KEY,
  statement_id      TEXT    NOT NULL UNIQUE,
  iban              TEXT    NOT NULL,
  electronic_seq_nb INTEGER,
  from_date         TEXT,
  to_date           TEXT,
  opening_balance   REAL,
  closing_balance   REAL,
  currency          TEXT,
  source_file       TEXT,
  imported_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stmt_seq ON bank_statement (iban, electronic_seq_nb);

-- ---------------------------------------------------------------------------
-- Receipts
-- ---------------------------------------------------------------------------

-- A receipt file in Drive. Amount and date may be null until the file is read:
-- most receipts are photos with no text layer and need OCR or a vision pass.
CREATE TABLE IF NOT EXISTS receipt (
  id             INTEGER PRIMARY KEY,
  drive_file_id  TEXT    UNIQUE,
  filename       TEXT    NOT NULL,
  folder_id      TEXT,
  receipt_date   TEXT,
  amount         REAL,
  currency       TEXT    NOT NULL DEFAULT 'CHF',
  vendor         TEXT,
  vendor_key     TEXT,
  -- Set from a "nicht verrechnen" marker in the filename; these are excluded
  -- from client invoices, matching the feelgood-rechnung convention.
  do_not_invoice INTEGER NOT NULL DEFAULT 0,
  -- 'pending' until amount and date are extracted, then 'parsed' or 'failed'.
  extract_status TEXT    NOT NULL DEFAULT 'pending',
  notes          TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_receipt_date   ON receipt (receipt_date);
CREATE INDEX IF NOT EXISTS idx_receipt_amount ON receipt (amount);

-- ---------------------------------------------------------------------------
-- Reconciliation
-- ---------------------------------------------------------------------------

-- A proposed or confirmed link between a bank line and a receipt.
--
-- Suggestions are written by the matcher and never auto-confirmed: the point of
-- the exercise is that a human agrees the receipt explains the charge.
CREATE TABLE IF NOT EXISTS tx_receipt_match (
  id             INTEGER PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES bank_transaction (id) ON DELETE CASCADE,
  receipt_id     INTEGER NOT NULL REFERENCES receipt (id) ON DELETE CASCADE,
  confidence     REAL    NOT NULL,
  -- How the pair was found, e.g. 'amount+date+name'. Kept for tuning.
  method         TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'suggested'
                 CHECK (status IN ('suggested', 'confirmed', 'rejected')),
  decided_at     TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (transaction_id, receipt_id)
);

CREATE INDEX IF NOT EXISTS idx_match_tx     ON tx_receipt_match (transaction_id, status);
CREATE INDEX IF NOT EXISTS idx_match_status ON tx_receipt_match (status, confidence DESC);

-- ---------------------------------------------------------------------------
-- Fixed costs
-- ---------------------------------------------------------------------------

-- A recurring charge inferred from the transaction history.
--
-- Detected, not declared: the detector groups debits by counterparty and looks
-- for a regular cadence. `confirmed` records that a human agreed.
CREATE TABLE IF NOT EXISTS fixed_cost (
  id               INTEGER PRIMARY KEY,
  counterparty_key TEXT    NOT NULL UNIQUE,
  display_name     TEXT    NOT NULL,
  cadence          TEXT    NOT NULL CHECK (cadence IN ('monthly', 'quarterly', 'yearly')),
  typical_amount   REAL    NOT NULL,
  min_amount       REAL    NOT NULL,
  max_amount       REAL    NOT NULL,
  occurrences      INTEGER NOT NULL,
  first_seen       TEXT    NOT NULL,
  last_seen        TEXT    NOT NULL,
  -- Mirrors the Notion Ausgaben tags: Software/Tools, Equipment, Marketing,
  -- Miete, Transport, Versicherung, Sonstiges.
  category         TEXT,
  confirmed        INTEGER NOT NULL DEFAULT 0,
  -- Cleared when a charge stops appearing; kept rather than deleted so the
  -- history of what used to be a fixed cost survives.
  active           INTEGER NOT NULL DEFAULT 1,
  detected_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- CRM — mirrored from Notion, app-owned going forward
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS client (
  id             INTEGER PRIMARY KEY,
  notion_page_id TEXT    UNIQUE,
  name           TEXT    NOT NULL,
  contact_person TEXT,
  email          TEXT,
  phone          TEXT,
  address        TEXT,
  website        TEXT,
  type           TEXT,
  status         TEXT    NOT NULL DEFAULT 'Lead'
                 CHECK (status IN ('Aktiv', 'Lead', 'Inaktiv')),
  notes          TEXT,
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project (
  id             INTEGER PRIMARY KEY,
  notion_page_id TEXT    UNIQUE,
  client_id      INTEGER REFERENCES client (id) ON DELETE SET NULL,
  name           TEXT    NOT NULL,
  phase          TEXT,
  status         TEXT,
  payment_status TEXT CHECK (payment_status IN ('Unpaid', 'Invoiced', 'Paid') OR payment_status IS NULL),
  revenue        REAL,
  invoice_no     TEXT,
  invoice_amount REAL,
  invoice_url    TEXT,
  due_date       TEXT,
  start_date     TEXT,
  end_date       TEXT,
  notes          TEXT,
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_project_client ON project (client_id);

-- Links an incoming payment to the project it settles, so `Payment` in Notion
-- can be driven by the bank rather than by hand.
CREATE TABLE IF NOT EXISTS project_payment (
  id             INTEGER PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  transaction_id INTEGER NOT NULL REFERENCES bank_transaction (id) ON DELETE CASCADE,
  confidence     REAL    NOT NULL,
  method         TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'suggested'
                 CHECK (status IN ('suggested', 'confirmed', 'rejected')),
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, transaction_id)
);
