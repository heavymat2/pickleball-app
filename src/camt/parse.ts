import { XMLParser } from "fast-xml-parser";
import type { BankTransaction, Direction, Statement, StatementBalance, TxKind } from "./types.ts";
import { merchantFromCardText } from "./normalize.ts";

/**
 * Parser for ISO 20022 camt.053 bank-to-customer statements as PostFinance
 * delivers them (one file per booking day, `camt.053.001.08`).
 *
 * The format nests everything and makes almost every element optional and
 * repeatable, so the helpers below flatten "element | element[] | undefined"
 * into plain arrays and strings before any real logic runs.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Amounts and references must stay strings: `parseFloat` on a QR reference
  // like "000000000000000009604749054" would destroy it.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // Strip the camt namespace prefix if a sender uses one; PostFinance does not,
  // but other banks emit <ns:Document>.
  removeNSPrefix: true,
});

/** Normalize fast-xml-parser's "one or many" shape into an array. */
function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Read a leaf as text, tolerating both `<Cd>X</Cd>` and attribute-bearing nodes. */
function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (typeof value === "object" && "#text" in (value as Record<string, unknown>)) {
    return text((value as Record<string, unknown>)["#text"]);
  }
  return null;
}

function num(value: unknown): number | null {
  const raw = text(value);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** camt dates come as `<Dt><Dt>2026-06-30</Dt></Dt>` or `<Dt><DtTm>…</DtTm></Dt>`. */
function dateOf(node: unknown): string | null {
  if (!node || typeof node !== "object") return text(node);
  const record = node as Record<string, unknown>;
  const plain = text(record["Dt"]);
  if (plain) return plain.slice(0, 10);
  const stamp = text(record["DtTm"]);
  return stamp ? stamp.slice(0, 10) : null;
}

/**
 * Classify an entry from its bank transaction code.
 *
 * `CCRD` is card activity, `IDDT`/`RDDT` are direct debits and `ICDT`/`RCDT`
 * are credit transfers. Note that the subfamily `DMCT` is "Domestic Credit
 * Transfer", not a direct debit — it appears under both directions.
 *
 * PostFinance books LSV/SEPA direct debits under the credit-transfer family
 * anyway and marks them only in the free text, so that text is the fallback.
 * Anything unrecognized stays "other" rather than being forced into a bucket.
 */
function classify(family: string | null, subFamily: string | null, additionalInfo: string | null): TxKind {
  if (family === "CCRD") return "card";
  if (family === "IDDT" || family === "RDDT") return "direct_debit";
  if (additionalInfo !== null && /\bLASTSCHRIFT\b/i.test(additionalInfo)) return "direct_debit";
  if (family === "ICDT" || family === "RCDT") return "transfer";
  if (family === "NTAV" || subFamily === "CHRG" || family === "CHRG") return "fee";
  return "other";
}

/** Read a party's name, tolerating both the `<Pty>` wrapper and an inline name. */
function partyName(party: unknown): string | null {
  if (!party || typeof party !== "object") return null;
  const record = party as Record<string, unknown>;
  const inner = (record["Pty"] as Record<string, unknown> | undefined) ?? record;
  return text(inner["Nm"]);
}

/**
 * The counterparty of an entry is whichever party is not the account holder:
 * on a debit we paid a creditor, on a credit a debtor paid us.
 *
 * The *ultimate* party wins when present. Payments routed through a processor
 * name the processor as debtor and the actual customer as ultimate debtor — so
 * without this, a client payment arriving via Revolut or Stripe would be filed
 * against the processor instead of the client.
 */
function counterpartyOf(
  txDetails: Record<string, unknown> | undefined,
  direction: Direction,
): { name: string | null; iban: string | null } {
  if (!txDetails) return { name: null, iban: null };

  const parties = txDetails["RltdPties"] as Record<string, unknown> | undefined;
  if (!parties) return { name: null, iban: null };

  const isDebit = direction === "DBIT";
  const ultimateKey = isDebit ? "UltmtCdtr" : "UltmtDbtr";
  const partyKey = isDebit ? "Cdtr" : "Dbtr";
  const acctKey = isDebit ? "CdtrAcct" : "DbtrAcct";

  const name = partyName(parties[ultimateKey]) ?? partyName(parties[partyKey]);

  // The account always belongs to the direct party, never the ultimate one.
  const account = parties[acctKey] as Record<string, unknown> | undefined;
  const id = account?.["Id"] as Record<string, unknown> | undefined;
  const iban = text(id?.["IBAN"]);

  return { name, iban };
}

/**
 * PostFinance emits status markers as additional remittance lines. They are not
 * payer text and must not end up in the remittance we show or search.
 */
const CONTROL_MARKER = /^\?[A-Z]+\?/;

/**
 * Structured creditor reference (Swiss QR or SCOR reference) plus payer text.
 *
 * Both `Ustrd` and the structured `AddtlRmtInf` are collected: an invoice
 * number often appears only in the latter ("Rechnung: 0000000175"), and that is
 * the strongest signal for tying an incoming payment to a project.
 */
function remittanceOf(txDetails: Record<string, unknown> | undefined): {
  qrReference: string | null;
  info: string | null;
} {
  const rmtInf = txDetails?.["RmtInf"] as Record<string, unknown> | undefined;
  if (!rmtInf) return { qrReference: null, info: null };

  const parts: string[] = [];
  const add = (value: unknown): void => {
    const part = text(value);
    if (part !== null && !CONTROL_MARKER.test(part) && !parts.includes(part)) parts.push(part);
  };

  for (const line of asArray(rmtInf["Ustrd"] as unknown)) add(line);

  let qrReference: string | null = null;
  for (const structured of asArray(rmtInf["Strd"] as unknown)) {
    const record = structured as Record<string, unknown>;

    if (qrReference === null) {
      const refInfo = record["CdtrRefInf"] as Record<string, unknown> | undefined;
      qrReference = text(refInfo?.["Ref"]);
    }

    for (const line of asArray(record["AddtlRmtInf"] as unknown)) add(line);
  }

  return { qrReference, info: parts.length > 0 ? parts.join(" · ") : null };
}

/** Flatten one `<Ntry>` into a `BankTransaction`. */
function parseEntry(entry: Record<string, unknown>, iban: string): BankTransaction | null {
  const acctSvcrRef = text(entry["AcctSvcrRef"]);
  const amount = num(entry["Amt"]);
  const direction = text(entry["CdtDbtInd"]) as Direction | null;
  const bookingDate = dateOf(entry["BookgDt"]);

  // Without a reference we cannot dedupe, and without amount/direction/date the
  // row is not bookkeeping. Skip rather than invent values.
  if (!acctSvcrRef || amount === null || !direction || !bookingDate) return null;

  const amountNode = entry["Amt"] as Record<string, unknown> | string;
  const currency =
    (typeof amountNode === "object" ? text(amountNode["@_Ccy"]) : null) ?? "CHF";

  const bkTxCd = entry["BkTxCd"] as Record<string, unknown> | undefined;
  const domain = bkTxCd?.["Domn"] as Record<string, unknown> | undefined;
  const family = domain?.["Fmly"] as Record<string, unknown> | undefined;
  const domainCode = text(domain?.["Cd"]);
  const familyCode = text(family?.["Cd"]);
  const subFamilyCode = text(family?.["SubFmlyCd"]);

  const additionalInfo = text(entry["AddtlNtryInf"]);
  const kind = classify(familyCode, subFamilyCode, additionalInfo);

  const entryDetails = entry["NtryDtls"] as Record<string, unknown> | undefined;
  // A single entry can batch several transactions; we take the first for the
  // counterparty and keep the total from the entry itself.
  const txDetails = asArray(entryDetails?.["TxDtls"] as unknown)[0] as
    | Record<string, unknown>
    | undefined;

  const structured = counterpartyOf(txDetails, direction);
  const { qrReference, info } = remittanceOf(txDetails);

  // Card entries carry no structured party, so fall back to the free text.
  const counterpartyRaw = structured.name ?? merchantFromCardText(additionalInfo);

  return {
    acctSvcrRef,
    iban,
    bookingDate,
    valueDate: dateOf(entry["ValDt"]),
    amount,
    signedAmount: direction === "DBIT" ? -amount : amount,
    currency,
    direction,
    status: text((entry["Sts"] as Record<string, unknown> | undefined)?.["Cd"]) ?? text(entry["Sts"]),
    reversal: text(entry["RvslInd"]) === "true",
    counterpartyRaw,
    counterpartyIban: structured.iban,
    qrReference,
    remittanceInfo: info,
    additionalInfo,
    domainCode,
    familyCode,
    subFamilyCode,
    kind,
  };
}

/**
 * Parse one camt.053 document into its statements.
 *
 * A file normally holds a single `<Stmt>`, but the schema allows several, so
 * all of them are returned.
 */
export function parseCamt053(xml: string): Statement[] {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const document = (doc["Document"] ?? doc) as Record<string, unknown>;
  const root = document["BkToCstmrStmt"] as Record<string, unknown> | undefined;
  if (!root) throw new Error("Not a camt.053 document: missing BkToCstmrStmt");

  return asArray(root["Stmt"] as unknown).map((raw) => {
    const stmt = raw as Record<string, unknown>;

    const account = stmt["Acct"] as Record<string, unknown> | undefined;
    const accountId = account?.["Id"] as Record<string, unknown> | undefined;
    const iban = text(accountId?.["IBAN"]) ?? "";
    const owner = (account?.["Ownr"] as Record<string, unknown> | undefined)?.["Nm"];

    const period = stmt["FrToDt"] as Record<string, unknown> | undefined;

    const balances: StatementBalance[] = asArray(stmt["Bal"] as unknown).flatMap((rawBal) => {
      const bal = rawBal as Record<string, unknown>;
      const type = bal["Tp"] as Record<string, unknown> | undefined;
      const code = type?.["CdOrPrtry"] as Record<string, unknown> | undefined;
      const amount = num(bal["Amt"]);
      const direction = text(bal["CdtDbtInd"]) as Direction | null;
      const date = dateOf(bal["Dt"]);
      if (amount === null || !direction || !date) return [];

      const amountNode = bal["Amt"] as Record<string, unknown> | string;
      return [{
        type: text(code?.["Cd"]) ?? text(code?.["Prtry"]) ?? "UNKNOWN",
        amount,
        currency: (typeof amountNode === "object" ? text(amountNode["@_Ccy"]) : null) ?? "CHF",
        direction,
        date,
      }];
    });

    const transactions = asArray(stmt["Ntry"] as unknown)
      .map((entry) => parseEntry(entry as Record<string, unknown>, iban))
      .filter((tx): tx is BankTransaction => tx !== null);

    return {
      id: text(stmt["Id"]) ?? "",
      iban,
      currency: text(account?.["Ccy"]),
      owner: text(owner),
      electronicSequenceNumber: num(stmt["ElctrncSeqNb"]),
      createdAt: text(stmt["CreDtTm"]),
      fromDate: dateOf(period?.["FrDtTm"] ? { DtTm: period["FrDtTm"] } : undefined),
      toDate: dateOf(period?.["ToDtTm"] ? { DtTm: period["ToDtTm"] } : undefined),
      balances,
      transactions,
    };
  });
}
