import { readFileSync } from "node:fs";

/**
 * The chart of accounts.
 *
 * `kontoplan.csv` is the authority — accounts are never invented, and a
 * categorization naming an account that is not in this file is a bug, not a
 * new account. Both the master spec and the rules file state this outright.
 */

export type Kontoart = "Vermögen" | "Eigenkapital" | "Einnahme" | "Aufwand";

export interface Konto {
  nummer: string;
  art: Kontoart;
  bezeichnung: string;
}

/**
 * The owner's capital account. Business spending paid privately, and private
 * spending paid from the business account, both post here as the counter-entry.
 */
export const KONTO_PRIVAT = "2850";

export class Kontoplan {
  readonly #byNumber: Map<string, Konto>;

  private constructor(konten: Konto[]) {
    this.#byNumber = new Map(konten.map((konto) => [konto.nummer, konto]));
  }

  /** Parse a `Kontonummer,Kontoart,Kontobezeichnung` CSV. */
  static parse(csv: string): Kontoplan {
    const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== "");
    const konten: Konto[] = [];

    for (const [index, line] of lines.entries()) {
      // Skip the header wherever it sits, rather than assuming line 0.
      if (/^\s*Kontonummer\s*,/i.test(line)) continue;

      // Bezeichnung can contain commas, e.g. "Privat (Kapitalkonto Inhaber -
      // Privatentnahmen/-einlagen)", so only split the first two fields.
      const firstComma = line.indexOf(",");
      const secondComma = line.indexOf(",", firstComma + 1);
      if (firstComma === -1 || secondComma === -1) {
        throw new Error(`kontoplan.csv line ${index + 1}: expected three columns`);
      }

      const nummer = line.slice(0, firstComma).trim();
      const art = line.slice(firstComma + 1, secondComma).trim() as Kontoart;
      const bezeichnung = line.slice(secondComma + 1).trim();

      if (!/^\d{3,4}$/.test(nummer)) {
        throw new Error(`kontoplan.csv line ${index + 1}: "${nummer}" is not an account number`);
      }
      konten.push({ nummer, art, bezeichnung });
    }

    if (konten.length === 0) throw new Error("kontoplan.csv contains no accounts");
    return new Kontoplan(konten);
  }

  static load(path: string): Kontoplan {
    return Kontoplan.parse(readFileSync(path, "utf8"));
  }

  get(nummer: string): Konto | undefined {
    return this.#byNumber.get(nummer);
  }

  has(nummer: string): boolean {
    return this.#byNumber.has(nummer);
  }

  /**
   * Resolve an account, throwing if it does not exist.
   *
   * Used at every point where a categorization is applied, so an account that
   * drifted out of the chart fails loudly instead of reaching the ledger.
   */
  require(nummer: string, context: string): Konto {
    const konto = this.#byNumber.get(nummer);
    if (!konto) {
      throw new Error(`${context}: account ${nummer} is not in the Kontoplan`);
    }
    return konto;
  }

  /** True when the Privatkonto exists; the spec flags its absence as a gap. */
  hasPrivatkonto(): boolean {
    return this.#byNumber.has(KONTO_PRIVAT);
  }

  all(): Konto[] {
    return [...this.#byNumber.values()];
  }
}
