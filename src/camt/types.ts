/** Direction of a booked entry, as ISO 20022 reports it. */
export type Direction = "DBIT" | "CRDT";

/**
 * How the money actually moved. Derived from the bank transaction code
 * (`BkTxCd`), because the shape of the entry differs per kind: card entries
 * carry no structured counterparty at all, direct debits and transfers do.
 */
export type TxKind = "card" | "direct_debit" | "transfer" | "fee" | "other";

/** One booked entry (`Ntry`) flattened into the fields we actually store. */
export interface BankTransaction {
  /**
   * The bank's own reference for the entry. Unique per booking and stable
   * across re-downloads of the same statement, so this is the idempotency key
   * for imports. It is NOT safe to dedupe on (date, amount, counterparty):
   * PostFinance legitimately books two identical charges on one day.
   */
  acctSvcrRef: string;
  iban: string;
  bookingDate: string;
  valueDate: string | null;
  /** Always positive. Use `signedAmount` for arithmetic. */
  amount: number;
  /** Negative for DBIT, positive for CRDT. */
  signedAmount: number;
  currency: string;
  direction: Direction;
  /** `BOOK` for booked entries; pending entries are not in camt.053. */
  status: string | null;
  reversal: boolean;
  /** Counterparty exactly as the file spells it, before normalization. */
  counterpartyRaw: string | null;
  counterpartyIban: string | null;
  /** Swiss QR reference (`QRR`) or creditor reference, when present. */
  qrReference: string | null;
  /** Unstructured remittance text, when present. */
  remittanceInfo: string | null;
  /** The free-text summary line. For card entries this is the only source. */
  additionalInfo: string | null;
  domainCode: string | null;
  familyCode: string | null;
  subFamilyCode: string | null;
  kind: TxKind;
}

/** Account balances reported alongside the entries. */
export interface StatementBalance {
  /** `OPBD` opening, `CLBD` closing, `CLAV` closing available. */
  type: string;
  amount: number;
  currency: string;
  direction: Direction;
  date: string;
}

/** One `Stmt` block: a single day's statement for a single account. */
export interface Statement {
  id: string;
  iban: string;
  currency: string | null;
  owner: string | null;
  /** Sequence number; gaps here mean a statement was never downloaded. */
  electronicSequenceNumber: number | null;
  createdAt: string | null;
  fromDate: string | null;
  toDate: string | null;
  balances: StatementBalance[];
  transactions: BankTransaction[];
}
