import { readFileSync } from "node:fs";
import type { Kontoplan } from "../kontoplan/index.ts";
import { KONTO_PRIVAT } from "../kontoplan/index.ts";

/**
 * Categorization rules — the system's memory.
 *
 * `kontierung-regeln.json` grows as decisions are confirmed and is never
 * pruned. A booking is categorized by rule or it is "zu entscheiden"; there is
 * no guessing in between, because a wrong account reaches the tax return
 * looking exactly like a right one.
 */

/** Which account the booking was made on. A property of the booking, not the receipt. */
export type KontoQuelle = "geschaeft" | "privat";

/** Whether the money was spent on the business or privately. */
export type Inhalt = "geschaeftlich" | "privat";

/**
 * What the booking becomes in the ledger, per the two-account matrix:
 *
 *   business account + business content -> aufwand (or ertrag)
 *   business account + private content  -> privatentnahme (2850)
 *   private account  + business content -> the expense account, funded as privateinlage
 *   private account  + private content  -> ignorieren, never reaches the ledger
 */
export type Behandlung = "aufwand" | "ertrag" | "privatentnahme" | "privateinlage" | "ignorieren";

export type Konfidenz = "hoch" | "mittel" | "unsicher";

/** A rule's `geltung`, as spelled in the rules file. */
export type Geltung = "geschaeft" | "privatentnahme" | "privateinlage" | "ignorieren";

interface BelegBranch {
  enthaelt_eines: string[];
  konto_nr: string;
  konto_name: string;
}

interface RawRule {
  id: string;
  geltung: Geltung;
  match: { feld: string; enthaelt: string };
  beleg_match: BelegBranch[] | null;
  konto_nr: string | null;
  konto_name: string | null;
  bezeichnung_default: string;
  konfidenz: Konfidenz;
  quelle: string;
  treffer_anzahl: number;
}

interface RawRuleFile {
  _schema?: string;
  version: number;
  privatanteile?: Record<string, unknown>;
  regeln: RawRule[];
}

/** The booking fields a rule can be matched against. */
export interface Buchung {
  empfaenger: string | null;
  /** Free text from the statement line. */
  text?: string | null;
  konto_quelle: KontoQuelle;
  /** Text read off the matched receipt, when one is available. */
  beleg_text?: string | null;
}

export interface Kontierung {
  behandlung: Behandlung;
  kontoNr: string | null;
  kontoName: string | null;
  bezeichnung: string | null;
  konfidenz: Konfidenz;
  ruleId: string | null;
  /** Set when no rule matched, or a rule matched but its receipt branch did not. */
  zuEntscheiden: boolean;
  /** Why the result is what it is, for the review table. */
  grund: string;
}

/**
 * What a rule's `geltung` says about the *content* of the spending.
 *
 * The geltung values are named for the treatment they produce on the account
 * they usually appear on, but the content is the invariant: health-insurance
 * premiums are private wherever they are paid from, so pairing content with
 * `konto_quelle` gives the right answer on either account rather than only on
 * the expected one.
 */
function inhaltOf(geltung: Geltung): Inhalt {
  switch (geltung) {
    case "geschaeft":
    case "privateinlage":
      return "geschaeftlich";
    case "privatentnahme":
    case "ignorieren":
      return "privat";
  }
}

/** Apply the two-account matrix. */
export function behandlungFor(quelle: KontoQuelle, inhalt: Inhalt): Behandlung {
  if (quelle === "geschaeft") {
    return inhalt === "geschaeftlich" ? "aufwand" : "privatentnahme";
  }
  return inhalt === "geschaeftlich" ? "privateinlage" : "ignorieren";
}

function contains(haystack: string | null | undefined, needle: string): boolean {
  if (!haystack) return false;
  return haystack.toLocaleLowerCase("de-CH").includes(needle.toLocaleLowerCase("de-CH"));
}

export class Regelwerk {
  readonly #rules: RawRule[];
  readonly #raw: RawRuleFile;
  /** Hits accumulated this run, merged into `treffer_anzahl` when saved. */
  readonly #hits = new Map<string, number>();

  private constructor(raw: RawRuleFile) {
    this.#raw = raw;
    this.#rules = raw.regeln;
  }

  static parse(json: string): Regelwerk {
    const raw = JSON.parse(json) as RawRuleFile;
    if (!Array.isArray(raw.regeln)) throw new Error("kontierung-regeln.json: missing 'regeln' array");
    return new Regelwerk(raw);
  }

  static load(path: string): Regelwerk {
    return Regelwerk.parse(readFileSync(path, "utf8"));
  }

  get rules(): readonly { id: string; geltung: Geltung; kontoNr: string | null }[] {
    return this.#rules.map((rule) => ({
      id: rule.id,
      geltung: rule.geltung,
      kontoNr: rule.konto_nr,
    }));
  }

  /**
   * Validate every rule against the chart of accounts.
   *
   * Returns the problems rather than throwing, so a single stale rule does not
   * block a run — but they must be surfaced, not swallowed.
   */
  validate(kontoplan: Kontoplan): string[] {
    const problems: string[] = [];

    for (const rule of this.#rules) {
      if (rule.konto_nr !== null && !kontoplan.has(rule.konto_nr)) {
        problems.push(`rule "${rule.id}": account ${rule.konto_nr} is not in the Kontoplan`);
      }
      for (const branch of rule.beleg_match ?? []) {
        if (!kontoplan.has(branch.konto_nr)) {
          problems.push(`rule "${rule.id}": receipt branch account ${branch.konto_nr} is not in the Kontoplan`);
        }
      }
      // A rule with neither a direct account nor branches can never categorize.
      if (rule.konto_nr === null && (rule.beleg_match ?? []).length === 0 && rule.geltung !== "ignorieren") {
        problems.push(`rule "${rule.id}": has no account and no receipt branches`);
      }
      // Placeholders left in from the seed file would match nothing.
      if (/^<.*>$/.test(rule.match.enthaelt)) {
        problems.push(`rule "${rule.id}": match text is still the placeholder ${rule.match.enthaelt}`);
      }
    }

    return problems;
  }

  /**
   * Categorize one booking.
   *
   * Rules are tried in file order and the first match wins, so a specific rule
   * must precede a general one — the same convention the file already follows.
   */
  apply(buchung: Buchung): Kontierung {
    for (const rule of this.#rules) {
      const field = rule.match.feld === "text" ? buchung.text : buchung.empfaenger;
      if (!contains(field, rule.match.enthaelt)) continue;

      this.#hits.set(rule.id, (this.#hits.get(rule.id) ?? 0) + 1);

      const inhalt = inhaltOf(rule.geltung);
      const behandlung = behandlungFor(buchung.konto_quelle, inhalt);

      // Purely private spending on the private account never enters the ledger.
      if (behandlung === "ignorieren") {
        return {
          behandlung,
          kontoNr: null,
          kontoName: null,
          bezeichnung: rule.bezeichnung_default,
          konfidenz: rule.konfidenz,
          ruleId: rule.id,
          zuEntscheiden: false,
          grund: `Regel "${rule.id}": privat auf Privatkonto, nicht buchungsrelevant`,
        };
      }

      // Money moving between the owner and the business books to 2850,
      // whatever the rule's own expense account would have been.
      if (behandlung === "privatentnahme") {
        return {
          behandlung,
          kontoNr: KONTO_PRIVAT,
          kontoName: "Privat",
          bezeichnung: rule.bezeichnung_default,
          konfidenz: rule.konfidenz,
          ruleId: rule.id,
          zuEntscheiden: false,
          grund: `Regel "${rule.id}": privater Aufwand ab Geschäftskonto`,
        };
      }

      // Receipt-driven branching: the receipt text picks the account.
      if (rule.beleg_match && rule.beleg_match.length > 0) {
        for (const branch of rule.beleg_match) {
          const hit = branch.enthaelt_eines.some((token) => contains(buchung.beleg_text, token));
          if (!hit) continue;

          return {
            behandlung,
            kontoNr: branch.konto_nr,
            kontoName: branch.konto_name,
            bezeichnung: rule.bezeichnung_default,
            konfidenz: rule.konfidenz,
            ruleId: rule.id,
            zuEntscheiden: false,
            grund: `Regel "${rule.id}", Belegtext-Zweig ${branch.konto_nr}`,
          };
        }

        // The payee matched but nothing in the receipt decided the account.
        // Guessing a branch here is exactly the error the branching prevents.
        return {
          behandlung,
          kontoNr: null,
          kontoName: null,
          bezeichnung: rule.bezeichnung_default,
          konfidenz: "unsicher",
          ruleId: rule.id,
          zuEntscheiden: true,
          grund: buchung.beleg_text
            ? `Regel "${rule.id}" trifft, aber kein Belegtext-Zweig passt`
            : `Regel "${rule.id}" trifft, aber es fehlt der Beleg zur Kontowahl`,
        };
      }

      if (rule.konto_nr === null) {
        return {
          behandlung,
          kontoNr: null,
          kontoName: null,
          bezeichnung: rule.bezeichnung_default,
          konfidenz: "unsicher",
          ruleId: rule.id,
          zuEntscheiden: true,
          grund: `Regel "${rule.id}" hat kein Konto hinterlegt`,
        };
      }

      return {
        behandlung,
        kontoNr: rule.konto_nr,
        kontoName: rule.konto_name,
        bezeichnung: rule.bezeichnung_default,
        konfidenz: rule.konfidenz,
        ruleId: rule.id,
        zuEntscheiden: false,
        grund: `Regel "${rule.id}"`,
      };
    }

    return {
      behandlung: buchung.konto_quelle === "geschaeft" ? "aufwand" : "privateinlage",
      kontoNr: null,
      kontoName: null,
      bezeichnung: null,
      konfidenz: "unsicher",
      ruleId: null,
      zuEntscheiden: true,
      grund: "keine Regel trifft",
    };
  }

  /** Hit counts accumulated since load, keyed by rule id. */
  hits(): Map<string, number> {
    return new Map(this.#hits);
  }

  /**
   * Serialize with this run's hits folded into `treffer_anzahl`.
   *
   * Rules are only ever added or incremented — never removed — so the file
   * stays a record of every decision ever confirmed.
   */
  serialize(): string {
    const merged: RawRuleFile = {
      ...this.#raw,
      regeln: this.#rules.map((rule) => ({
        ...rule,
        treffer_anzahl: rule.treffer_anzahl + (this.#hits.get(rule.id) ?? 0),
      })),
    };
    return `${JSON.stringify(merged, null, 2)}\n`;
  }
}
