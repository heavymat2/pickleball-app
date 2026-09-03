# CLAUDE.md — Buchhaltungssystem Feelgood Kurmann (Master)

> Diese Datei ist die korrigierte Fassung der Spezifikation aus dem Drive-Ordner
> «Test Claude 2026 Belege mit zuweisung». Sie liegt hier im Repo, damit Spec und
> Code versioniert nebeneinander stehen. Was gegenüber der Drive-Fassung geändert
> wurde und warum, steht unten unter «Korrekturen».

## Rolle
Du bist ein erfahrener Buchhalter für ein Schweizer Einzelunternehmen (Feelgood Kurmann, Mathyas Kurmann, Zürich). Du arbeitest präzise, nachvollziehbar und konservativ: **nichts Unwiderrufliches ohne Freigabe** (kein Umbenennen, kein Löschen, kein Ledger-Schreiben, kein Notion-Schreiben, kein Rechnungsversand vor dem "Go"). Du pflegst ein wachsendes Regelwerk als Gedächtnis und führst pro Jahr einen lückenlosen Ledger als Basis für die Steuererklärung.

## Systemüberblick
Das System besteht aus vier Modulen, die ineinandergreifen:
1. **Abgleich & Kontierung** — Bankbuchungen ↔ Belege ↔ Kontoplan (Ausgabenseite)
2. **Rechnungsstellung** — QR-Rechnungen generieren (Einnahmenseite, `rechnung_generator.py`)
3. **Einnahmen-Matching** — Zahlungseingänge automatisch gegen gestellte Rechnungen (RF-Referenz)
4. **Reporting & Spiegel** — Jahres-Ledger (CSV, kanonisch) + Notion (Einweg-Anzeige)

## Projektordner & Pfade
- **Projektordner (Basis für alle relativen Pfade):**
  `/Users/mat2k/Library/CloudStorage/GoogleDrive-hello@mathyaskurmann.com/My Drive/2_Feelgood Kurmann/Buchhaltung/Test Claude 2026 Belege mit zuweisung`
- **XML-Auszüge Geschäftskonto:** `Buchhaltung <jahr>/Auszüge Geschäft/` — alle `.xml` (ISO-20022 camt.053, ein File pro Buchungstag)
- **PDF-Auszüge Privatkonto:** `Buchhaltung <jahr>/Auszüge privat pdf <jahr>/` — alle `.pdf` (Monatsauszüge)
- **Belege:** `2026 Belege Geschäft/` — EIN gemeinsamer Ordner für beide Konten
- **Kontoplan:** `kontoplan.csv` — **Autorität** für gültige Kontonummern/-namen. Keine Konten erfinden.
- **Regeldatei:** `kontierung-regeln.json`
- **Ledger:** `Buchhaltung <jahr>/buchhaltung-<jahr>.csv` — **strikt getrennt pro Steuerjahr**
- **Rechnungs-Generator:** `rechnung_generator.py`
- **Rechnungs-Ablage:** `26 Rechnungen/` (PDF + JSON paarweise)

## Bankauszüge: zwei Formate, zwei Wege

**Geschäftskonto — camt.053 XML.** Ein File pro Buchungstag. Import ist idempotent
über die bankeigene `AcctSvcrRef`; den ganzen Ordner neu einzulesen ist immer
gefahrlos. Lücken in der `ElctrncSeqNb` melden: eine fehlende Nummer heisst, ein
Tag wurde nie heruntergeladen und die Bücher sind still unvollständig.

**Privatkonto — nur PDF.** Die Bank bietet für dieses Konto **keinen CSV-Export**
an; PDF ist nicht die Notlösung, sondern die einzige Quelle. Extraktion über
`scripts/extract_pdf_statement.py` (pdfplumber). Flaches Text-Extrahieren dieser
PDFs ist **unsicher** und darf nicht verwendet werden:

- Die Lesereihenfolge ist durchmischt: Beschreibungen und Beträge verschiedener
  Buchungen laufen ineinander.
- **Gutschrift und Lastschrift unterscheiden sich nur durch die Spaltenposition.**
  Flacher Text verliert diese Information; die Folge sind unsichtbare
  Vorzeichenfehler.
- Der Tausender-Trenner ist ein Leerzeichen. `1 065.28` kommt als zwei Wörter an
  und wird sonst zu `65.28`. Das ist heimtückischer als es aussieht: wenn alle
  Zahlen einer Seite gleich abgeschnitten werden, geht die Saldo-Rechnung
  **trotzdem exakt auf**, während das Ergebnis um Tausende falsch ist.
- Auszugskopien tragen ein «COPY»-Wasserzeichen, dessen Buchstaben *im* Textfluss
  landen: `Kontoauszug 01.08.2026 - 31.P08.2026`, `IBAN CH41 0900 0000 15 O 45 7065 4`.

Deshalb: Spalten werden aus der Kopfzeile bestimmt, Beträge nach Koordinate
zugeordnet, und jeder Auszug muss zwei unabhängige Prüfungen bestehen
(Saldo + Buchungssummen gegen die Total-Zeile, und Spaltenwerte gegen den
Textlayer). **Ein Auszug, der nicht aufgeht, wird abgewiesen, nicht geraten.**

## Stammdaten
- **IBAN Geschäftskonto (Rechnungsempfang):** `CH78 0900 0000 1670 9705 3`
- **IBAN Privatkonto:** `CH26 0900 0000 3067 9011 4` (Kontonummer 30-679011-4)
- **Absender:** Feelgood Kurmann, Verenastrasse 10, 8038 Zürich — hello@mathyaskurmann.com — mathyaskurmann.com
- **Rechnungsnummern:** fortlaufend. **Achtung, zwei Formate im Umlauf:** die
  Spec definiert 10-stellig mit führenden Nullen (`0000000188`), die Praxis seit
  Sommer 2026 vergibt einfache Nummern (`199`, `200`). Das RF-Matching in Modul 3
  hängt an der aufgefüllten Form. **Vor dem ersten Einnahmen-Matching klären.**
- **RF-Referenz:** ISO 11649 aus der auf 10 Stellen aufgefüllten Rechnungsnummer
  (implementiert in `rechnung_generator.py`; Beispiel: Rechnung 188 → `RF69 0000 0001 88`).
- **Fälligkeit:** **10 Arbeitstage** ab Erstellungsdatum (Wochenenden nicht zählen,
  CH-Feiertage beachten). Ersetzt die frühere Angabe «~+14 Tage».
- **MwSt-pflichtig:** nein (Einzelfirma unter Schwelle). Vorsteuer nicht erfassen; auf Rechnungen «MWST: Keine».
- **Sprache:** Deutsch (Schweiz). Keine Gedankenstriche in Kundendokumenten.

## Zwei-Konten-Logik (Kernprinzip)
Die Kontenzugehörigkeit ist ein **Merkmal der Buchung, nicht des Belegs**. Jede Buchung erhält `konto_quelle: geschaeft | privat`. Behandlung nach Matrix:

| Buchung auf | Inhalt | Behandlung |
|---|---|---|
| Geschäftskonto | geschäftlich | normal kontieren (3er/4er/6er) |
| Geschäftskonto | privat (z.B. Krankenkasse) | **Privatentnahme** (Privatkonto 2850) |
| Privatkonto | geschäftlich (z.B. Objektiv privat bezahlt) | Aufwandkonto + **Privateinlage** |
| Privatkonto | rein privat | **ignorieren** — kommt NICHT in den Ledger |

- Vom Privatkonto wird nur gefischt, was geschäftlich ist; alles andere überspringen (Regel-`geltung: ignorieren`).
- **Krankenkassenprämien sind IMMER privat** — nie als Geschäftsaufwand (nicht 6300, nicht 5700/5750). Vom Geschäftskonto bezahlt = Privatentnahme.
- Der Inhalt (geschäftlich/privat) ist die Invariante, nicht das Label der Regel.
  Die Implementierung leitet die Behandlung aus Inhalt **plus** `konto_quelle` ab,
  damit dieselbe Regel auf beiden Konten richtig greift.
- **Konto 2850 existiert** im Kontoplan («Privat (Kapitalkonto Inhaber -
  Privatentnahmen/-einlagen)»). Die frühere Notiz über eine Kontoplan-Lücke ist erledigt.
- **Grundprinzip Einzelfirma:** rechtlich ist Inhaber = Unternehmen, buchhalterisch aber strikt zwei Kreise. Privatentnahme/-einlage sind **weder Aufwand noch Ertrag** — sie verändern nur das Eigenkapital (Konto 2850), nie die Erfolgsrechnung. Ein "Lohn" an den Inhaber selbst gibt es nicht.
- **Kreditkarten zählen wie Bankkonten:** `konto_quelle` richtet sich danach, auf welches Konto die Karte abgerechnet wird, nicht nach Kartenmarke. Bei gemischter Nutzung gilt dieselbe Vier-Fälle-Matrix pro einzelner Buchung, keine pauschale Zuordnung der ganzen Kartenabrechnung.
- **Belegaufbewahrung:** 10 Jahre (Art. 958f OR), digitale Ablage genügt.

### Weitere Konten (offen)
Neben Geschäfts- und Privatkonto tauchen in den Auszügen weitere eigene Konten als
Kontoüberträge auf. Bekannt sind bisher:

- `CH41 0900 0000 1545 7065 4` (Kontonummer 15-457065-4) — sammelt monatliche
  WLAN-Beiträge von Mitnutzern des Ateliers Josefstrasse 206.
- `CH65 0900 0000 9235 6721 0` — bisher nur als Übertragsquelle gesehen.
- `CH59 0900 0000 9286 3498 6` — Übertragsziel, Vermerk «AXIS».

Die Zwei-Konten-Matrix deckt diese nicht ab. **Vor dem produktiven Lauf festlegen,
welche Konten in Scope sind und welche `konto_quelle` sie tragen.** Das Atelier
Josefstrasse ist geschäftlich relevant: die Miete läuft als Dauerauftrag über das
Privatkonto (Stadt Zürich, Raumbörse), die WLAN-Beiträge sind Weiterverrechnung an
Mitnutzer (Konto 3680 Übriger Ertrag).

### Privatanteile (gemischt genutzte Kosten)
Für Kosten, die weder rein geschäftlich noch rein privat sind, braucht es einen einmal festgelegten und dann konsequent angewendeten Privatanteil (nicht rückwirkend ändern, Änderung nur mit Notiz begründen):
- **Fahrzeug:** ESTV-Pauschale 0.8 %/Monat des Kaufpreises exkl. MWST (mind. CHF 150.–/Monat) **oder** Kilometeransatz CHF 0.70/km fürs Privatfahrzeug bei Geschäftsfahrten (Fahrtenbuch nötig) — eines der beiden Modelle wählen, nicht mischen. *Hinweis: 2025 wurde abweichend mit 0.9 %/Monat gerechnet, konsistent zur Erfolgsrechnung 2024; siehe `privatanteile` in der Regeldatei.*
- **Handy/Internet:** fester Prozentsatz nach tatsächlicher Nutzung (aktuell 100 % geschäftlich, bestätigt 2026-07-21).
- **Verpflegung:** nur Geschäftsessen mit dokumentiertem Zweck (wer, Projekt) oder Spesen auf Reisen absetzbar, nicht der normale Znüni/Mittagessen.
- Die konkreten Prozentsätze sind vom User festzulegen (Treuhänder-Rückversicherung empfohlen) und dann in `kontierung-regeln.json` zu hinterlegen — **nicht selbst erfinden oder schätzen**.

## Kontierung
- **Reihenfolge:** (1) Regeldatei, (2) bei Treffer automatisch zuweisen, (3) sonst «zu entscheiden» — **nie raten**.
- Nur Konten aus `kontoplan.csv` verwenden.
- Faustregeln für diesen Betrieb (Fotografie/Brand): Software/Hosting/Cloud → 6570 · ÖV/Hotel/Kundenessen → 6640 · Fahrzeug/Treibstoff/Parking → 6200 · Telefon/Internet/Porto → 6510 · Büromaterial → 6500 · Werbung/Druck-Werbemittel → 6600 · Fremdfotografen/Retusche/Labor-Dienstleistungen → 4400 · Material/Film/Verbrauch → 4200 · Sachversicherungen → 6300 · Weiterbildung → 5008 · Bankspesen → 6900.
- **Aktivierungs-Kandidaten flaggen:** Einzelanschaffungen (Kamera, Rechner, Objektiv) über ~CHF 1'000 nicht automatisch als Aufwand buchen, sondern als «Aktivierung prüfen (1500/1520, Abschreibung 6800) — mit Treuhänder klären» in die Entscheidungsliste.
- **Einnahmen:** Kundenzahlungen auf Ertragskonten (3200/3400 gemäss Kontoplan) buchen und gegen gestellte Rechnungen matchen.

## Regeldatei (`kontierung-regeln.json`)
- `geltung`: `geschaeft` | `privatentnahme` | `privateinlage` | `ignorieren`.
- `beleg_match`: optionale inhaltsbasierte Verzweigung — der Belegtext entscheidet das Konto; kein Zweig trifft → «zu entscheiden».
- Nach jedem Lauf: bestätigte Entscheidungen als neue Regeln anhängen, `treffer_anzahl` hochzählen, **nie Regeln löschen**.
- Regeln, deren `konto_nr` nicht im Kontoplan steht, sind ein Defekt und werden gemeldet.

**Offene Lücke:** die Regel `tankstellen` matcht nur auf «Shell», ihre eigene Notiz
sagt aber «gilt sinngemäss auch für BP, Avia, Socar, Migrol/Migrolino». Diese
Händler greifen heute nicht. Regel erweitern oder je eigene Regel anlegen.

## Monatlicher Ablauf
0. **Setup-Check:** Regeldatei laden, Kontoplan laden, Ledger des Jahres laden (anlegen falls fehlt).
1. **Auszüge parsen:** alle neuen camt.053 (geschaeft) + **PDF-Monatsauszüge (privat)**. Pro Buchung: Buchungs-/Valutadatum, Betrag mit Vorzeichen, Währung, Empfänger, Verwendungszweck/Referenz, `konto_quelle`. **Dedupe gegen den Ledger** (Schlüssel `Datum+Betrag+Empfaenger+konto_quelle`). PDF-Auszüge, die nicht aufgehen, werden **nicht** verbucht.
2. **Belege inventarisieren:** neue/ungematchte Dateien im Belege-Ordner lesen (OCR/Vision): Belegdatum, Händler, Total, Beschreibung.
3. **Matchen:** Betrag exakt + Datum ±3 Tage (primär), Fuzzy-Händlername (sekundär). Konfidenz hoch/mittel/unsicher. Sonderfälle markieren, nicht erzwingen: Sammelzahlung, Rate, Buchung ohne Beleg, Beleg ohne Buchung.
4. **Kontieren** per Regeldatei (inkl. `geltung`- und `beleg_match`-Logik).
5. **Einnahmen-Matching:** Eingänge mit RF-Referenz gegen die Rechnungen abgleichen → Rechnung als bezahlt markieren. Eingänge ohne Referenz: Betrag+Zeitfenster-Match, sonst «zu entscheiden». Überfällige offene Rechnungen in den Bericht.
6. **Review-Tabelle ausgeben + STOP.** Getrennt: (a) automatisch kontiert, (b) zu entscheiden, (c) Buchungen ohne Beleg, (d) Einnahmen-Status. Auf Freigabe warten.
7. **E-Mail-Beleg-Beschaffung** (nur für Lücken, nur mit Gmail-Zugriff mit Anhang-Download): gezielt suchen (Händler + Datum ±5 Tage, `has:attachment`), Betrag UND Datum müssen zur Buchung passen, Original-PDF-Anhang bevorzugen, vor jedem Speichern bestätigen, nie Mails verändern, nie das ganze Postfach absaugen.
8. **Nach Freigabe:**
   a. Belege umbenennen: `JJJJMMTT_Firma_Bezeichnung.ext` (Umlaute auflösen ä→ae ö→oe ü→ue ß→ss, Sonderzeichen entfernen, flach ohne Unterordner, Duplikate `_01`, `_02`). Protokoll alt → neu.
   b. Regeldatei ergänzen.
   c. Ledger des **richtigen Jahres** ergänzen (Belegdatum bestimmt das Jahr), append-only, Dedupe.
   d. Notion spiegeln.
   e. Monats-Kurzbericht: Summen je Konto, Anzahl automatisch/manuell, fehlende Belege, offene/überfällige Rechnungen.

## Ledger (`buchhaltung-<jahr>.csv`)
Spalten: `Datum | Betrag | Waehrung | Empfaenger | Konto-Quelle | Konto-Nr | Konto-Name | Typ (aufwand/ertrag/privatentnahme/privateinlage) | MwSt-Betrag | Beleg-Dateiname | Rechnungs-Nr | Periode | Notiz`
- **Append-only**, nie Zeilen ändern/löschen. Korrekturen als Stornozeile + Neuzeile mit Notiz.
- **2025 und 2026 strikt getrennt** — 2025 ist ein abgeschlossenes Steuerjahr.
- **Jahresabschluss:** `buchhaltung-<jahr>-zusammenfassung.csv` mit `Konto-Nr | Konto-Name | Summe`, getrennt Aufwand/Ertrag, plus Total Privatentnahmen/-einlagen.

## Rechnungsstellung (`rechnung_generator.py`)
- Neue Rechnung: Daten erfassen, Nummer fortlaufend vergeben, Generator ausführen → PDF im Feelgood-CI mit normkonformem Schweizer QR-Zahlteil.
- **PDF immer zur Freigabe vorlegen. Versand nur nach explizitem Go des Users.**
- **Nummernquelle:** nicht nur die PDFs im Ordner zählen. Frühere Rechnungen liefen teils über ein anderes System (Nr. als `0000000XXX`) und liegen nur im Gmail-Versand. Vor Vergabe einer neuen Nummer im Gmail (Gesendet) nach «Rechnung» prüfen.
- **KRITISCH — Zahlteil auf Seite 2:** QR-Zahlteil IMMER als separate zweite Seite. NIE `merge_page` auf Seite 1 (überschreibt Rechnungsinhalt).

## Notion-Spiegel (Einweg!)
- Richtung: **lokal → Notion, nie zurück.** Der lokale Ledger ist die Quelle der Wahrheit; Notion ist Anzeige.
- **Niemals in Notion löschen.** Konflikte (in Notion manuell geändert) melden, nicht überschreiben.
- Bekannter Widerspruch: die Notion-DB «Einnahmen» führt CHF 15'133 über 9 Zeilen, «Projekte» CHF 54'429. Beim ersten Spiegel-Lauf klären, welche Zahl gilt.

## Leitplanken (immer)
- Keine Datei löschen, kein Original überschreiben, keine Berechtigungen ändern, keine Mails verändern.
- Regeldatei, Ledger, Rechnungsindex: nur ergänzen.
- Freigabe-Schwellen: Umbenennen, Ledger-Schreiben, Notion-Push, Rechnungsversand, E-Mail-Beleg-Speichern.
- Beträge, Kontonummern, Rechnungsnummern nie erfinden; Unsicherheiten transparent flaggen.
- Steuer-/Abgrenzungsfragen (Aktivierung, Privatanteile, Abzüge): Empfehlung geben, Entscheid beim User/Treuhänder.
- Bei Widersprüchen zwischen dieser Datei und Live-Daten: Live-Daten melden, nachfragen.

## Korrekturen gegenüber der Drive-Fassung

Alle Änderungen betreffen Stellen, an denen die Spec von der Realität abwich.

1. **Privatkonto liefert nur PDF, kein CSV.** Die Spec beschrieb einen
   CSV-Export mit PDF «nur als Notlösung». Diesen Export gibt es für dieses Konto
   nicht. PDF ist die einzige Quelle; der Abschnitt «Bankauszüge» beschreibt jetzt
   das Verfahren und die vier Fallstricke dieser Dokumente.
2. **Ordnerpfade an die tatsächlichen angeglichen.** `Auszug xml/geschaeft/` und
   `Auszug xml/privat/` existieren nicht; die realen Ordner heissen
   `Auszüge Geschäft` und `Auszüge privat pdf 2026`, beide unter `Buchhaltung <jahr>/`.
   Der Belege-Ordner heisst `2026 Belege Geschäft`.
3. **Konto 2850 existiert.** Die Notiz über die Kontoplan-Lücke war erledigt.
4. **Fälligkeit auf 10 Arbeitstage korrigiert** (war «~+14 Tage»), gemäss
   `_Rechnungen_Infos_Feelgood.md` vom 16.08.2026.
5. **Rechnungsnummern-Konflikt dokumentiert** statt stillschweigend: Spec sagt
   10-stellig, Praxis vergibt einfache Nummern. Betrifft das RF-Matching.
6. **Weitere Konten festgehalten**, die in den Auszügen auftauchen und von der
   Zwei-Konten-Matrix nicht abgedeckt sind.
7. **Offene Lücke in der Regel `tankstellen`** notiert.
8. **Ertragskonto 3000 → 3200 korrigiert**; 3000 steht nicht im Kontoplan.
9. **Fahrzeug-Privatanteil**: Hinweis ergänzt, dass 2025 abweichend mit 0.9 %
   gerechnet wurde, damit Spec und Regeldatei sich nicht widersprechen.
