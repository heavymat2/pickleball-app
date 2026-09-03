#!/usr/bin/env python3
"""Extract bookings from a PostFinance PDF account statement.

The private account only offers PDF, so this is the only way its bookings
reach the ledger. Two properties of these PDFs make naive text extraction
actively dangerous, and this script is shaped around both:

1. Reading order is scrambled. Pulling the text layer flat interleaves
   descriptions and amounts from different bookings, so amounts get attached
   to the wrong line. Everything here works from word coordinates instead.

2. Credit and debit are distinguished ONLY by which column the number sits
   in. Flat text loses that, and the resulting sign errors are invisible.
   Columns are located from the header row and amounts assigned by position.

Output is JSON on stdout. A statement whose balances do not reconcile is
reported as `"reconciled": false` and should not be booked: guessing is worse
than stopping, because a wrong number in a tax return looks like a right one.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, asdict
from pathlib import Path

try:
    import pdfplumber
except ImportError:  # pragma: no cover - environment problem, not logic
    sys.exit("pdfplumber is required: pip install pdfplumber")


# Thousands separators PostFinance uses: plain space, narrow/no-break spaces,
# and apostrophe. Reading "4 669.45" as 669.45 silently loses CHF 4'000, a bug
# this project has hit before.
THOUSANDS = "    '"
AMOUNT_RE = re.compile(r"^\d{1,3}(?:[" + THOUSANDS + r"]\d{3})*[.,]\d{2}$|^\d+[.,]\d{2}$")
DATE_RE = re.compile(r"^(\d{2})\.(\d{2})\.(\d{2}|\d{4})$")

# Column headers, in the order PostFinance prints them. Their x-positions on
# the page define the bands every amount is assigned to.
HEADERS = ("Datum", "Text", "Gutschrift", "Lastschrift", "Valuta", "Saldo")

# Vertical tolerance, in points, for treating words as being on one line.
ROW_TOLERANCE = 2.5

# Horizontal gap, in points, below which two fragments may be one number.
# The PDF draws "1 065.28" as a single string, but the extractor splits on the
# space, so the halves must be rejoined before any amount is parsed. Columns
# sit tens of points apart, so this stays well clear of merging across them.
MAX_FRAGMENT_GAP = 6.0


def parse_amount(text: str) -> float | None:
    """Parse a Swiss-formatted amount, or None when the text is not one."""
    if not AMOUNT_RE.match(text):
        return None
    cleaned = text
    for separator in THOUSANDS:
        cleaned = cleaned.replace(separator, "")
    try:
        return round(float(cleaned.replace(",", ".")), 2)
    except ValueError:
        return None


def parse_date(text: str, default_century: int = 2000) -> str | None:
    """Parse dd.mm.yy or dd.mm.yyyy into an ISO date."""
    match = DATE_RE.match(text)
    if not match:
        return None
    day, month, year = match.groups()
    full_year = int(year) if len(year) == 4 else default_century + int(year)
    if not (1 <= int(month) <= 12 and 1 <= int(day) <= 31):
        return None
    return f"{full_year:04d}-{int(month):02d}-{int(day):02d}"


@dataclass
class Booking:
    date: str
    value_date: str | None
    amount: float
    """Negative for a debit, positive for a credit."""
    signed_amount: float
    direction: str
    description: str
    balance_after: float | None
    page: int


@dataclass
class Statement:
    iban: str | None
    account_number: str | None
    currency: str
    period_from: str | None
    period_to: str | None
    opening_balance: float | None
    closing_balance: float | None
    total_credits: float | None
    total_debits: float | None
    reconciled: bool
    reconciliation_note: str
    bookings: list[Booking]


# Page furniture and print-control marks that repeat on every page and land in
# the middle of booking descriptions. They matter because categorization rules
# match on the payee, and "ED 65600 SBB CFF FFS" is harder to match than
# "SBB CFF FFS".
FURNITURE_TOKENS = frozenset({"ED", "P", "O", "C", "Y", "A-PRIORITY", "P.P."})
FURNITURE_PATTERNS = (
    re.compile(r"^Seite$", re.I),
    re.compile(r"^\d{5}$"),           # print job code, e.g. 65600
    re.compile(r"^00\.\d{6}$"),       # despatch code, e.g. 00.630000
    re.compile(r"^/$"),
)


def is_furniture(token: str) -> bool:
    """Whether a token is print furniture rather than booking text."""
    if token in FURNITURE_TOKENS:
        return True
    return any(pattern.match(token) for pattern in FURNITURE_PATTERNS)


def clean_description(tokens: list[str]) -> str:
    """Drop page furniture from a description, keeping the payee intact.

    Conservative by design: only exact known artifacts are removed, since a
    payee wrongly stripped is worse than one left slightly noisy.
    """
    kept = [token for token in tokens if not is_furniture(token)]
    # "Seite 2 / 15" leaves a bare page number behind once "Seite" and "/" go.
    while kept and kept[-1].isdigit() and len(kept[-1]) <= 2:
        kept.pop()
    return " ".join(kept).strip()


def find_iban(text: str) -> str | None:
    """Read the account's own IBAN, tolerating the COPY watermark.

    Statement copies carry a diagonal "COPY" whose letters land inside the text
    stream, so the IBAN can arrive as "CH41 0900 0000 15 O 45 7065 4". Digits
    after the country code are therefore taken and everything else discarded,
    and the result is only accepted if it is a well-formed Swiss IBAN.

    Anchored on the literal "IBAN" label so a counterparty's IBAN quoted in a
    booking description is never mistaken for the account's own.
    """
    best: str | None = None

    for candidate in re.findall(r"IBAN\s+(CH[0-9A-Z\s]{18,34})", text):
        cleaned = "CH" + re.sub(r"\D", "", candidate[2:])
        if re.fullmatch(r"CH\d{19}", cleaned):
            # Later pages repeat the IBAN without the watermark over it, so a
            # clean match is preferred, but any valid one beats none.
            if best is None or "O" not in candidate:
                best = cleaned
    return best


def find_period(text: str) -> tuple[str | None, str | None]:
    """Read the statement period, tolerating watermark letters inside dates.

    "Kontoauszug 01.08.2026 - 31.P08.2026" is a real example: the P belongs to
    the watermark, not the date.
    """
    match = re.search(r"Kontoauszug\s+([0-9.A-Z]+)\s*-\s*([0-9.A-Z]+)", text)
    if not match:
        return None, None

    def clean(part: str) -> str | None:
        return parse_date(re.sub(r"[^\d.]", "", part))

    return clean(match.group(1)), clean(match.group(2))


def merge_amount_fragments(row: list[dict]) -> list[dict]:
    """Rejoin number fragments split on the thousands separator.

    "1 065.28" reaches us as the words "1" and "065.28". Left alone, the first
    is swept into the description and the second parses as 65.28 — a silent
    loss of CHF 1'000 that the balance check cannot see, because every figure
    on the page is truncated the same way and the arithmetic still agrees.

    Fragments are joined only when they are horizontally adjacent AND the
    result is a well-formed amount, so ordinary neighbouring words are safe.
    """
    merged: list[dict] = []
    index = 0

    while index < len(row):
        current = dict(row[index])
        next_index = index + 1

        while next_index < len(row):
            candidate_text = f"{current['text']} {row[next_index]['text']}"
            gap = row[next_index]["x0"] - current["x1"]
            if gap > MAX_FRAGMENT_GAP or not AMOUNT_RE.match(candidate_text):
                break
            current["text"] = candidate_text
            current["x1"] = row[next_index]["x1"]
            next_index += 1

        merged.append(current)
        index = next_index

    return merged


def group_rows(words: list[dict]) -> list[list[dict]]:
    """Group words into visual rows by their vertical position."""
    rows: list[list[dict]] = []
    for word in sorted(words, key=lambda w: (round(w["top"], 1), w["x0"])):
        if rows and abs(rows[-1][0]["top"] - word["top"]) <= ROW_TOLERANCE:
            rows[-1].append(word)
        else:
            rows.append([word])
    return [merge_amount_fragments(sorted(row, key=lambda w: w["x0"])) for row in rows]


def find_column_bands(rows: list[list[dict]]) -> dict[str, float] | None:
    """Locate the amount columns from the header row.

    Returns the right edge of each header, because these columns are
    right-aligned. Reading positions off the header rather than hardcoding
    them keeps this working if the layout shifts.
    """
    for row in rows:
        labels = {word["text"]: word for word in row}
        if not {"Gutschrift", "Lastschrift"}.issubset(labels):
            continue
        bands = {
            name: labels[name]["x1"]
            for name in HEADERS
            if name in labels
        }
        if "Gutschrift" in bands and "Lastschrift" in bands:
            return bands
    return None


def overruns_amount_column(row: list[dict], bands: dict[str, float]) -> bool:
    """Whether non-numeric text runs into the Gutschrift column.

    When a description is wide enough to reach the right-aligned amount, the
    glyphs overlap and the extractor merges them into an unparseable token —
    the amount is then simply gone. Detecting the overlap turns a bare
    "totals do not match" into a pointer at the offending line.
    """
    left_edge = bands.get("Gutschrift")
    if left_edge is None:
        return False

    for word in row:
        if parse_amount(word["text"]) is not None or parse_date(word["text"]) is not None:
            continue
        # Right edge past where the Gutschrift column's digits begin.
        if word["x1"] > left_edge - 40 and word["x0"] < left_edge:
            return True
    return False


def column_of(word: dict, bands: dict[str, float]) -> str:
    """Assign a word to the nearest amount column by its right edge."""
    candidates = [name for name in ("Gutschrift", "Lastschrift", "Saldo") if name in bands]
    return min(candidates, key=lambda name: abs(word["x1"] - bands[name]))


def extract(path: Path) -> Statement:
    iban: str | None = None
    account_number: str | None = None
    period_from: str | None = None
    period_to: str | None = None
    opening: float | None = None
    closing: float | None = None
    total_credits: float | None = None
    total_debits: float | None = None

    bookings: list[Booking] = []
    bands: dict[str, float] | None = None
    collisions: list[str] = []

    with pdfplumber.open(path) as pdf:
        full_text = "\n".join(page.extract_text() or "" for page in pdf.pages)

        iban = find_iban(full_text)

        account_match = re.search(r"Kontonummer\s+([\d-]+)", full_text)
        if account_match:
            account_number = account_match.group(1)

        period_from, period_to = find_period(full_text)

        for page_number, page in enumerate(pdf.pages, start=1):
            rows = group_rows(page.extract_words(use_text_flow=False, keep_blank_chars=False))

            if bands is None:
                bands = find_column_bands(rows)
            if bands is None:
                continue

            for row in rows:
                texts = [word["text"] for word in row]
                joined = " ".join(texts)

                # Opening and closing balances both print as "Kontostand".
                if "Kontostand" in texts:
                    amounts = [parse_amount(t) for t in texts]
                    values = [a for a in amounts if a is not None]
                    if values:
                        if opening is None:
                            opening = values[-1]
                        else:
                            closing = values[-1]
                    continue

                # The totals row carries credits then debits.
                if texts and texts[0] == "Total":
                    values = [parse_amount(t) for t in texts[1:]]
                    values = [v for v in values if v is not None]
                    if len(values) >= 2:
                        total_credits, total_debits = values[0], values[1]
                    continue

                dates = [parse_date(t) for t in texts]
                booking_date = next((d for d in dates if d), None)

                if booking_date is None:
                    # A wrapped description line: no date, no amount, just the
                    # rest of the sentence. Attach it to the booking above so
                    # the payee survives, since categorization matches on it.
                    if bookings and not any(parse_amount(t) for t in texts):
                        extra = clean_description(texts)
                        if extra:
                            bookings[-1].description = f"{bookings[-1].description} {extra}".strip()
                    continue

                credit = debit = balance = None
                for word in row:
                    value = parse_amount(word["text"])
                    if value is None:
                        continue
                    column = column_of(word, bands)
                    if column == "Gutschrift":
                        credit = value
                    elif column == "Lastschrift":
                        debit = value
                    else:
                        balance = value

                if credit is None and debit is None:
                    # A row with a date but no amount is usually a continuation
                    # line. If its text overruns an amount column, though, the
                    # glyphs have collided and an amount may have been
                    # destroyed — worth naming, since the balance check will
                    # fail later without saying why.
                    if overruns_amount_column(row, bands):
                        collisions.append(f"Seite {page_number}: {joined[:70]}")
                    continue

                text_words = [
                    word["text"]
                    for word in row
                    if parse_amount(word["text"]) is None and parse_date(word["text"]) is None
                ]
                value_dates = [d for d in dates if d and d != booking_date]

                amount = credit if credit is not None else debit
                assert amount is not None
                is_credit = credit is not None

                bookings.append(
                    Booking(
                        date=booking_date,
                        value_date=value_dates[0] if value_dates else None,
                        amount=amount,
                        signed_amount=amount if is_credit else -amount,
                        direction="CRDT" if is_credit else "DBIT",
                        description=clean_description(text_words),
                        balance_after=balance,
                        page=page_number,
                    )
                )

    reconciled, note = reconcile(opening, closing, total_credits, total_debits, bookings)

    # Independent cross-check against the flat text layer, where the thousands
    # space survives intact. Coordinate extraction and text extraction are two
    # different code paths, so agreement between them rules out a systematic
    # tokenization error — which plain balance arithmetic cannot, because
    # uniformly truncated figures still reconcile with each other.
    if reconciled:
        agreed, mismatch = cross_check_totals(full_text, total_credits, total_debits)
        if not agreed:
            reconciled, note = False, mismatch

    if not reconciled and collisions:
        note += (
            f" | Text ueberlappt die Betragsspalte in {len(collisions)} Zeile(n), "
            f"dort ging vermutlich ein Betrag verloren: {collisions[0]}"
        )

    return Statement(
        iban=iban,
        account_number=account_number,
        currency="CHF",
        period_from=period_from,
        period_to=period_to,
        opening_balance=opening,
        closing_balance=closing,
        total_credits=total_credits,
        total_debits=total_debits,
        reconciled=reconciled,
        reconciliation_note=note,
        bookings=bookings,
    )


#. Amounts as they appear in the flat text layer, thousands separator included.
TEXT_AMOUNT_RE = re.compile(r"\d{1,3}(?:[" + THOUSANDS + r"]\d{3})*[.,]\d{2}")


def cross_check_totals(
    full_text: str,
    total_credits: float | None,
    total_debits: float | None,
) -> tuple[bool, str]:
    """Compare the coordinate-derived totals against the text layer.

    The statement's "Total" line prints credits then debits. Reading it from
    flat text uses none of the coordinate machinery, so a disagreement means
    one of the two paths mis-tokenized — most likely a number split on its
    thousands separator.
    """
    match = re.search(r"Total\b(.{0,80})", full_text, re.DOTALL)
    if not match:
        return True, ""

    found = [parse_amount(text) for text in TEXT_AMOUNT_RE.findall(match.group(1))]
    found = [value for value in found if value is not None]
    if len(found) < 2:
        return True, ""

    text_credits, text_debits = found[0], found[1]

    if total_credits is None or total_debits is None:
        return False, "Total-Zeile nur im Textlayer gefunden, nicht in den Spalten"

    if abs(text_credits - total_credits) >= 0.01 or abs(text_debits - total_debits) >= 0.01:
        return False, (
            f"Spalten und Textlayer widersprechen sich (moeglicher Tausender-Trennzeichen-Fehler): "
            f"Gutschrift {total_credits} vs {text_credits}, Lastschrift {total_debits} vs {text_debits}"
        )

    return True, ""


def reconcile(
    opening: float | None,
    closing: float | None,
    total_credits: float | None,
    total_debits: float | None,
    bookings: list[Booking],
) -> tuple[bool, str]:
    """Check the extraction against the statement's own totals.

    Two independent checks: the printed totals must move the opening balance to
    the closing balance, and the bookings we extracted must sum to those same
    totals. The second is what catches a missed or double-counted line, and it
    is the reason this is safe to automate at all.
    """
    if opening is None or closing is None:
        return False, "Anfangs- oder Schlusssaldo nicht gefunden"
    if total_credits is None or total_debits is None:
        return False, "Total-Zeile nicht gefunden"

    expected = round(opening + total_credits - total_debits, 2)
    if abs(expected - closing) >= 0.01:
        return False, (
            f"Saldo geht nicht auf: {opening} + {total_credits} - {total_debits} "
            f"= {expected}, Auszug sagt {closing}"
        )

    credits = round(sum(b.amount for b in bookings if b.direction == "CRDT"), 2)
    debits = round(sum(b.amount for b in bookings if b.direction == "DBIT"), 2)

    if abs(credits - total_credits) >= 0.01 or abs(debits - total_debits) >= 0.01:
        return False, (
            f"Extrahierte Buchungen stimmen nicht mit der Total-Zeile überein: "
            f"Gutschrift {credits} vs {total_credits}, Lastschrift {debits} vs {total_debits}"
        )

    return True, "Saldo und Buchungssummen stimmen"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path, help="PostFinance PDF statement")
    parser.add_argument("--out", type=Path, help="write JSON here instead of stdout")
    parser.add_argument(
        "--allow-unreconciled",
        action="store_true",
        help="emit output even when the statement does not reconcile (inspection only, never for booking)",
    )
    args = parser.parse_args()

    statement = extract(args.pdf)
    payload = asdict(statement)
    payload["source_file"] = args.pdf.name

    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.out:
        args.out.write_text(text, encoding="utf-8")
    else:
        print(text)

    if not statement.reconciled:
        print(f"NICHT ABGEGLICHEN: {statement.reconciliation_note}", file=sys.stderr)
        return 0 if args.allow_unreconciled else 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
