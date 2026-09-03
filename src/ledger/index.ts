import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Behandlung, KontoQuelle } from "../kontierung/rules.ts";
import { toRappen } from "../money.ts";

/**
 * The year ledger — `buchhaltung-<jahr>.csv`.
 *
 * Append-only and one file per tax year. Rows are never edited or deleted: a
 * correction is a Storno row plus a fresh row, so the history of what was
 * booked, and when it was fixed, survives. 2025 is a closed year.
 */

export const LEDGER_COLUMNS = [
  "Datum",
  "Betrag",
  "Waehrung",
  "Empfaenger",
  "Konto-Quelle",
  "Konto-Nr",
  "Konto-Name",
  "Typ",
  "MwSt-Betrag",
  "Beleg-Dateiname",
  "Rechnungs-Nr",
  "Periode",
  "Notiz",
] as const;

/** Ledger `Typ`. "ignorieren" never reaches the ledger, so it is not a Typ. */
export type LedgerTyp = Exclude<Behandlung, "ignorieren">;

export interface LedgerRow {
  datum: string;
  betrag: number;
  waehrung: string;
  empfaenger: string;
  kontoQuelle: KontoQuelle;
  kontoNr: string;
  kontoName: string;
  typ: LedgerTyp;
  /** Always 0 here: the business is not MWST-pflichtig. */
  mwstBetrag: number;
  belegDateiname: string;
  rechnungsNr: string;
  periode: string;
  notiz: string;
}

/** Quote a field for CSV; payee names and notes routinely contain commas. */
function encodeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function encodeRow(row: LedgerRow): string {
  return [
    row.datum,
    toRappen(row.betrag).toFixed(2),
    row.waehrung,
    row.empfaenger,
    row.kontoQuelle,
    row.kontoNr,
    row.kontoName,
    row.typ,
    toRappen(row.mwstBetrag).toFixed(2),
    row.belegDateiname,
    row.rechnungsNr,
    row.periode,
    row.notiz,
  ]
    .map((field) => encodeField(String(field)))
    .join(",");
}

/** Split one CSV line, honouring quoted fields. */
function splitLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * The dedupe key from the spec: date, amount, payee and source account.
 *
 * Deliberately not the bank's own reference: the private account arrives as
 * PDF and carries no reference at all, so the key has to work for both sources.
 * Two genuinely identical bookings on one day therefore collapse — which is
 * why `appendRows` reports what it skipped instead of staying silent.
 */
export function dedupeKey(row: Pick<LedgerRow, "datum" | "betrag" | "empfaenger" | "kontoQuelle">): string {
  return [row.datum, toRappen(row.betrag).toFixed(2), row.empfaenger.trim().toLowerCase(), row.kontoQuelle].join("|");
}

export class Ledger {
  readonly #path: string;
  readonly #year: number;
  readonly #keys: Set<string>;
  #rowCount: number;

  private constructor(path: string, year: number, keys: Set<string>, rowCount: number) {
    this.#path = path;
    this.#year = year;
    this.#keys = keys;
    this.#rowCount = rowCount;
  }

  /** Open the ledger for a tax year, creating it with a header if absent. */
  static open(path: string, year: number): Ledger {
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${LEDGER_COLUMNS.join(",")}\n`, "utf8");
      return new Ledger(path, year, new Set(), 0);
    }

    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.trim() !== "");
    const keys = new Set<string>();
    let rowCount = 0;

    for (const line of lines.slice(1)) {
      const fields = splitLine(line);
      const datum = fields[0];
      const betrag = fields[1];
      const empfaenger = fields[3];
      const quelle = fields[4];
      if (datum === undefined || betrag === undefined || empfaenger === undefined || quelle === undefined) {
        continue;
      }
      keys.add(dedupeKey({
        datum,
        betrag: Number(betrag),
        empfaenger,
        kontoQuelle: quelle as KontoQuelle,
      }));
      rowCount += 1;
    }

    return new Ledger(path, year, keys, rowCount);
  }

  get year(): number {
    return this.#year;
  }

  get rowCount(): number {
    return this.#rowCount;
  }

  has(row: Pick<LedgerRow, "datum" | "betrag" | "empfaenger" | "kontoQuelle">): boolean {
    return this.#keys.has(dedupeKey(row));
  }

  /**
   * Append rows, skipping any already present and rejecting any whose date
   * falls outside this ledger's tax year.
   *
   * The receipt date decides the year, so a December purchase settling in
   * January belongs to the earlier book — mixing years is the one thing the
   * spec calls out as strictly forbidden.
   */
  appendRows(rows: LedgerRow[]): { appended: number; skipped: LedgerRow[]; wrongYear: LedgerRow[] } {
    const skipped: LedgerRow[] = [];
    const wrongYear: LedgerRow[] = [];
    const lines: string[] = [];

    for (const row of rows) {
      if (Number(row.datum.slice(0, 4)) !== this.#year) {
        wrongYear.push(row);
        continue;
      }
      const key = dedupeKey(row);
      if (this.#keys.has(key)) {
        skipped.push(row);
        continue;
      }
      this.#keys.add(key);
      lines.push(encodeRow(row));
    }

    if (lines.length > 0) {
      appendFileSync(this.#path, `${lines.join("\n")}\n`, "utf8");
      this.#rowCount += lines.length;
    }

    return { appended: lines.length, skipped, wrongYear };
  }

  /**
   * Reverse a row by appending its negation plus a note.
   *
   * The original stays exactly as booked; this is how corrections are made in
   * an append-only ledger.
   */
  storno(row: LedgerRow, grund: string): void {
    const reversal: LedgerRow = {
      ...row,
      betrag: -row.betrag,
      mwstBetrag: -row.mwstBetrag,
      notiz: `Storno: ${grund}`.trim(),
    };
    appendFileSync(this.#path, `${encodeRow(reversal)}\n`, "utf8");
    this.#rowCount += 1;
  }
}

/** Per-account totals, the basis for the Erfolgsrechnung. */
export interface Zusammenfassung {
  aufwand: { kontoNr: string; kontoName: string; summe: number }[];
  ertrag: { kontoNr: string; kontoName: string; summe: number }[];
  totalAufwand: number;
  totalErtrag: number;
  totalPrivatentnahmen: number;
  totalPrivateinlagen: number;
}

/**
 * Summarize a ledger by account.
 *
 * Rows funded privately (`privateinlage`) count as business expense — that is
 * the whole point of booking them — and are additionally totalled as capital
 * put into the business.
 */
export function summarize(path: string, kontoartOf: (kontoNr: string) => string | undefined): Zusammenfassung {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.trim() !== "");

  const byKonto = new Map<string, { kontoName: string; summe: number; art: string }>();
  let totalPrivatentnahmen = 0;
  let totalPrivateinlagen = 0;

  for (const line of lines.slice(1)) {
    const fields = splitLine(line);
    const betrag = Number(fields[1]);
    const kontoNr = fields[5] ?? "";
    const kontoName = fields[6] ?? "";
    const typ = fields[7] ?? "";
    if (!Number.isFinite(betrag) || kontoNr === "") continue;

    if (typ === "privatentnahme") totalPrivatentnahmen += betrag;
    if (typ === "privateinlage") totalPrivateinlagen += betrag;

    const art = kontoartOf(kontoNr) ?? "Aufwand";
    const existing = byKonto.get(kontoNr);
    if (existing) existing.summe += betrag;
    else byKonto.set(kontoNr, { kontoName, summe: betrag, art });
  }

  const aufwand: Zusammenfassung["aufwand"] = [];
  const ertrag: Zusammenfassung["ertrag"] = [];

  for (const [kontoNr, entry] of [...byKonto].sort(([a], [b]) => a.localeCompare(b))) {
    const row = { kontoNr, kontoName: entry.kontoName, summe: toRappen(entry.summe) };
    if (entry.art === "Einnahme") ertrag.push(row);
    else if (entry.art === "Aufwand") aufwand.push(row);
  }

  return {
    aufwand,
    ertrag,
    totalAufwand: toRappen(aufwand.reduce((sum, row) => sum + row.summe, 0)),
    totalErtrag: toRappen(ertrag.reduce((sum, row) => sum + row.summe, 0)),
    totalPrivatentnahmen: toRappen(totalPrivatentnahmen),
    totalPrivateinlagen: toRappen(totalPrivateinlagen),
  };
}
