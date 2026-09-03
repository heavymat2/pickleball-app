import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { amountsEqual, formatChf, parseSwissAmount, toRappen } from "../src/money.ts";
import { Kontoplan, KONTO_PRIVAT } from "../src/kontoplan/index.ts";
import { behandlungFor, Regelwerk } from "../src/kontierung/rules.ts";
import { Ledger, summarize, type LedgerRow } from "../src/ledger/index.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const kontoplan = Kontoplan.load(join(fixtures, "kontoplan.csv"));

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "fgos-"));
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

test("parses the thousands separators PostFinance actually emits", () => {
  // A plain space, in PDF statements. Reading this as 669.45 loses CHF 4'000,
  // which is the bug recorded against the vehicle Privatanteil.
  assert.equal(parseSwissAmount("4 669.45"), 4669.45);
  // An apostrophe, in invoices and exports.
  assert.equal(parseSwissAmount("4'669.45"), 4669.45);
  // A narrow no-break space, which some PDF text layers use.
  assert.equal(parseSwissAmount("1 953.55"), 1953.55);
  // No separator at all, as in camt.053 XML.
  assert.equal(parseSwissAmount("4669.45"), 4669.45);
  assert.equal(parseSwissAmount("1'234'567.89"), 1234567.89);
});

test("rejects text that is not cleanly an amount", () => {
  // Returning null beats returning a partial number: a wrong amount looks
  // exactly like a right one once it is in the ledger.
  assert.equal(parseSwissAmount("4 669.45 CHF"), null);
  assert.equal(parseSwissAmount("KARTEN NR. XXXX8247"), null);
  assert.equal(parseSwissAmount("30.06.2026"), null);
  assert.equal(parseSwissAmount(""), null);
  assert.equal(parseSwissAmount(null), null);
});

test("handles signs and comma decimals", () => {
  assert.equal(parseSwissAmount("-90.25"), -90.25);
  assert.equal(parseSwissAmount("1 065,28"), 1065.28);
});

test("formats amounts in Swiss convention", () => {
  assert.equal(formatChf(1234.5), "1'234.50");
  assert.equal(formatChf(-90.25), "-90.25");
  assert.equal(formatChf(0), "0.00");
  assert.equal(formatChf(1234567.891), "1'234'567.89");
});

test("rounds to rappen only at the boundary", () => {
  assert.equal(toRappen(0.1 + 0.2), 0.3);
  assert.ok(amountsEqual(0.1 + 0.2, 0.3));
  assert.ok(!amountsEqual(1.0, 1.02));
});

// ---------------------------------------------------------------------------
// Kontoplan
// ---------------------------------------------------------------------------

test("loads the chart of accounts including the Privatkonto", () => {
  assert.equal(kontoplan.all().length, 32);
  assert.equal(kontoplan.get("6570")?.bezeichnung, "Informatikaufwand");
  assert.equal(kontoplan.get("3400")?.art, "Einnahme");
  // The master spec flags a missing 2850 as a gap to raise with the Treuhänder.
  assert.ok(kontoplan.hasPrivatkonto());
});

test("keeps commas inside an account name", () => {
  // "Privat (Kapitalkonto Inhaber - Privatentnahmen/-einlagen)" survives intact.
  assert.match(kontoplan.get(KONTO_PRIVAT)!.bezeichnung, /^Privat \(Kapitalkonto/);
});

test("refuses an account that is not in the chart", () => {
  assert.throws(() => kontoplan.require("9999", "test"), /9999 is not in the Kontoplan/);
  assert.equal(kontoplan.require("6200", "test").bezeichnung, "Fahrzeugaufwand");
});

// ---------------------------------------------------------------------------
// Two-account matrix
// ---------------------------------------------------------------------------

test("the two-account matrix covers all four cases", () => {
  assert.equal(behandlungFor("geschaeft", "geschaeftlich"), "aufwand");
  // Something private paid from the business account is a withdrawal.
  assert.equal(behandlungFor("geschaeft", "privat"), "privatentnahme");
  // Something for the business paid privately is an expense funded by a deposit.
  assert.equal(behandlungFor("privat", "geschaeftlich"), "privateinlage");
  // Purely private on the private account never enters the books at all.
  assert.equal(behandlungFor("privat", "privat"), "ignorieren");
});

// ---------------------------------------------------------------------------
// Kontierung rules
// ---------------------------------------------------------------------------

const RULES = JSON.stringify({
  version: 2,
  regeln: [
    {
      id: "salt-mobile",
      geltung: "geschaeft",
      match: { feld: "empfaenger", enthaelt: "Salt" },
      beleg_match: null,
      konto_nr: "6570",
      konto_name: "Informatikaufwand",
      bezeichnung_default: "Salt Telefon/Internet-Abo",
      konfidenz: "hoch",
      quelle: "Jahresanalyse 2025",
      treffer_anzahl: 6,
    },
    {
      id: "krankenkasse",
      geltung: "privatentnahme",
      match: { feld: "empfaenger", enthaelt: "Assura" },
      beleg_match: null,
      konto_nr: "2850",
      konto_name: "Privat",
      bezeichnung_default: "Assura Krankenkasse (privat)",
      konfidenz: "hoch",
      quelle: "Grundsatz: Krankenkasse nie Geschaeftsaufwand",
      treffer_anzahl: 0,
    },
    {
      id: "fotolabor",
      geltung: "geschaeft",
      match: { feld: "empfaenger", enthaelt: "Jannis Hafner" },
      beleg_match: [
        { enthaelt_eines: ["Entwicklung", "Scan"], konto_nr: "4400", konto_name: "Drittdienstleister" },
        { enthaelt_eines: ["Film", "Rolle"], konto_nr: "4200", konto_name: "Material- und Wareneinkauf" },
      ],
      konto_nr: null,
      konto_name: null,
      bezeichnung_default: "Analogfilm",
      konfidenz: "hoch",
      quelle: "manuell",
      treffer_anzahl: 0,
    },
  ],
});

test("categorizes a business payee on the business account", () => {
  const result = Regelwerk.parse(RULES).apply({
    empfaenger: "SALT MOBILE SA",
    konto_quelle: "geschaeft",
  });

  assert.equal(result.behandlung, "aufwand");
  assert.equal(result.kontoNr, "6570");
  assert.equal(result.zuEntscheiden, false);
  assert.equal(result.ruleId, "salt-mobile");
});

test("the same payee paid privately becomes a Privateinlage on the same account", () => {
  const result = Regelwerk.parse(RULES).apply({
    empfaenger: "SALT MOBILE SA",
    konto_quelle: "privat",
  });

  // Still a business expense on 6570 — the difference is who funded it.
  assert.equal(result.behandlung, "privateinlage");
  assert.equal(result.kontoNr, "6570");
});

test("health insurance is private wherever it is paid from", () => {
  const rules = Regelwerk.parse(RULES);

  // From the business account it is a withdrawal, booked to 2850.
  const fromBusiness = rules.apply({ empfaenger: "Assura-Basis SA", konto_quelle: "geschaeft" });
  assert.equal(fromBusiness.behandlung, "privatentnahme");
  assert.equal(fromBusiness.kontoNr, KONTO_PRIVAT);

  // From the private account it is simply not a business matter.
  const fromPrivate = rules.apply({ empfaenger: "Assura-Basis SA", konto_quelle: "privat" });
  assert.equal(fromPrivate.behandlung, "ignorieren");
  assert.equal(fromPrivate.kontoNr, null);
});

test("the receipt text picks the account when a rule branches", () => {
  const rules = Regelwerk.parse(RULES);

  const development = rules.apply({
    empfaenger: "Jannis Hafner",
    konto_quelle: "geschaeft",
    beleg_text: "Entwicklung 3 Filme",
  });
  assert.equal(development.kontoNr, "4400");

  const material = rules.apply({
    empfaenger: "Jannis Hafner",
    konto_quelle: "geschaeft",
    beleg_text: "5 Rolle Portra 400",
  });
  assert.equal(material.kontoNr, "4200");
});

test("a branching rule without a usable receipt stops rather than guessing", () => {
  const rules = Regelwerk.parse(RULES);

  const noReceipt = rules.apply({ empfaenger: "Jannis Hafner", konto_quelle: "geschaeft" });
  assert.equal(noReceipt.zuEntscheiden, true);
  assert.equal(noReceipt.kontoNr, null);
  assert.match(noReceipt.grund, /fehlt der Beleg/);

  const unmatchedReceipt = rules.apply({
    empfaenger: "Jannis Hafner",
    konto_quelle: "geschaeft",
    beleg_text: "Passfotos",
  });
  assert.equal(unmatchedReceipt.zuEntscheiden, true);
  assert.match(unmatchedReceipt.grund, /kein Belegtext-Zweig/);
});

test("an unknown payee is never guessed at", () => {
  const result = Regelwerk.parse(RULES).apply({
    empfaenger: "Irgendein Neuer Laden GmbH",
    konto_quelle: "geschaeft",
  });

  assert.equal(result.zuEntscheiden, true);
  assert.equal(result.kontoNr, null);
  assert.equal(result.konfidenz, "unsicher");
});

test("rule matching ignores case and diacritics in the payee", () => {
  const result = Regelwerk.parse(RULES).apply({
    empfaenger: "salt mobile sa renens vd",
    konto_quelle: "geschaeft",
  });
  assert.equal(result.kontoNr, "6570");
});

test("validation catches rules pointing outside the Kontoplan", () => {
  const broken = Regelwerk.parse(JSON.stringify({
    version: 2,
    regeln: [
      {
        id: "bad-account",
        geltung: "geschaeft",
        match: { feld: "empfaenger", enthaelt: "Foo" },
        beleg_match: null,
        konto_nr: "9999",
        konto_name: "Erfunden",
        bezeichnung_default: "x",
        konfidenz: "hoch",
        quelle: "test",
        treffer_anzahl: 0,
      },
      {
        id: "placeholder",
        geltung: "geschaeft",
        match: { feld: "empfaenger", enthaelt: "<Labor-Name>" },
        beleg_match: null,
        konto_nr: "4400",
        konto_name: "Drittdienstleister",
        bezeichnung_default: "x",
        konfidenz: "hoch",
        quelle: "test",
        treffer_anzahl: 0,
      },
    ],
  }));

  const problems = broken.validate(kontoplan);
  assert.equal(problems.length, 2);
  assert.match(problems[0]!, /9999 is not in the Kontoplan/);
  assert.match(problems[1]!, /placeholder/);
});

test("hits accumulate onto treffer_anzahl without dropping rules", () => {
  const rules = Regelwerk.parse(RULES);
  rules.apply({ empfaenger: "Salt Mobile SA", konto_quelle: "geschaeft" });
  rules.apply({ empfaenger: "Salt Mobile SA", konto_quelle: "geschaeft" });

  const saved = JSON.parse(rules.serialize()) as { regeln: { id: string; treffer_anzahl: number }[] };
  const salt = saved.regeln.find((rule) => rule.id === "salt-mobile")!;

  // Six from the file plus two this run; nothing removed.
  assert.equal(salt.treffer_anzahl, 8);
  assert.equal(saved.regeln.length, 3);
});

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    datum: "2026-06-29",
    betrag: 90.25,
    waehrung: "CHF",
    empfaenger: "Salt Mobile SA",
    kontoQuelle: "geschaeft",
    kontoNr: "6570",
    kontoName: "Informatikaufwand",
    typ: "aufwand",
    mwstBetrag: 0,
    belegDateiname: "",
    rechnungsNr: "",
    periode: "2026-06",
    notiz: "",
    ...overrides,
  };
}

test("writes a header and appends rows", () => {
  const path = join(scratch(), "buchhaltung-2026.csv");
  const ledger = Ledger.open(path, 2026);

  assert.deepEqual(ledger.appendRows([row()]), { appended: 1, skipped: [], wrongYear: [] });

  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.match(lines[0]!, /^Datum,Betrag,Waehrung,Empfaenger,Konto-Quelle/);
  assert.equal(lines[1], "2026-06-29,90.25,CHF,Salt Mobile SA,geschaeft,6570,Informatikaufwand,aufwand,0.00,,,2026-06,");
});

test("re-running does not duplicate rows", () => {
  const path = join(scratch(), "buchhaltung-2026.csv");
  Ledger.open(path, 2026).appendRows([row()]);

  // A second run, as if the same statement were imported again.
  const second = Ledger.open(path, 2026);
  const result = second.appendRows([row()]);

  assert.equal(result.appended, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(second.rowCount, 1);
});

test("rejects a row belonging to another tax year", () => {
  const path = join(scratch(), "buchhaltung-2026.csv");
  const ledger = Ledger.open(path, 2026);

  // A December 2025 purchase belongs in the 2025 book even if it settled later.
  const result = ledger.appendRows([row({ datum: "2025-12-29" }), row()]);

  assert.equal(result.appended, 1);
  assert.equal(result.wrongYear.length, 1);
  assert.equal(result.wrongYear[0]!.datum, "2025-12-29");
});

test("quotes fields containing commas", () => {
  const path = join(scratch(), "buchhaltung-2026.csv");
  const ledger = Ledger.open(path, 2026);
  ledger.appendRows([row({ empfaenger: "Pascal Vogel, derReparateur.ch", notiz: 'Beleg "RTM90"' })]);

  const written = readFileSync(path, "utf8");
  assert.match(written, /"Pascal Vogel, derReparateur\.ch"/);
  assert.match(written, /"Beleg ""RTM90"""/);

  // And it reads back as one row, not several.
  assert.equal(Ledger.open(path, 2026).rowCount, 1);
});

test("a correction is a reversal plus a new row, never an edit", () => {
  const path = join(scratch(), "buchhaltung-2026.csv");
  const ledger = Ledger.open(path, 2026);
  const original = row();
  ledger.appendRows([original]);

  ledger.storno(original, "falsches Konto");
  ledger.appendRows([row({ kontoNr: "6510", kontoName: "Telefon / Internet / Porti", datum: "2026-06-30" })]);

  const lines = readFileSync(path, "utf8").trim().split("\n").slice(1);
  assert.equal(lines.length, 3);
  // The original is untouched.
  assert.match(lines[0]!, /,90\.25,.*,6570,/);
  assert.match(lines[1]!, /,-90\.25,.*Storno: falsches Konto/);
  assert.match(lines[2]!, /,6510,/);
});

test("summarizes by account, splitting income from expense", () => {
  const path = join(scratch(), "buchhaltung-2026.csv");
  const ledger = Ledger.open(path, 2026);

  ledger.appendRows([
    row({ betrag: 90.25, kontoNr: "6570", typ: "aufwand" }),
    row({ datum: "2026-05-15", betrag: 40.0, kontoNr: "6570", typ: "privateinlage", kontoQuelle: "privat" }),
    row({ datum: "2026-04-02", betrag: 200.0, kontoNr: "6200", kontoName: "Fahrzeugaufwand", typ: "aufwand" }),
    row({ datum: "2026-03-01", betrag: 5160.0, kontoNr: "3400", kontoName: "Dienstleistungsertrag", typ: "ertrag" }),
    row({ datum: "2026-02-01", betrag: 300.0, kontoNr: "2850", kontoName: "Privat", typ: "privatentnahme" }),
  ]);

  const summary = summarize(path, (nr) => kontoplan.get(nr)?.art);

  // Privately funded spending still counts as business expense on 6570.
  assert.deepEqual(
    summary.aufwand.map((entry) => [entry.kontoNr, entry.summe]),
    [["6200", 200], ["6570", 130.25]],
  );
  assert.deepEqual(summary.ertrag.map((entry) => [entry.kontoNr, entry.summe]), [["3400", 5160]]);
  assert.equal(summary.totalAufwand, 330.25);
  assert.equal(summary.totalErtrag, 5160);
  assert.equal(summary.totalPrivateinlagen, 40);
  assert.equal(summary.totalPrivatentnahmen, 300);
});
