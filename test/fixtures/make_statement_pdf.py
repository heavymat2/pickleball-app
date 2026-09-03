#!/usr/bin/env python3
"""Generate a synthetic PostFinance-style PDF statement for testing.

The real statements cannot be committed — they are personal financial records.
This reproduces the property the extractor depends on: right-aligned Gutschrift
and Lastschrift columns whose position, not their text, carries the sign.

It also reproduces the two hazards the extractor exists to survive:
  - amounts using a space as the thousands separator ("1 065.28")
  - descriptions that wrap across several lines
"""

from __future__ import annotations

import argparse
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

# Right edges of the right-aligned columns, in points from the left margin.
COL_TEXT_LEFT = 60
COL_GUTSCHRIFT = 330
COL_LASTSCHRIFT = 410
COL_VALUTA = 470
COL_SALDO = 545

LINE_HEIGHT = 14


def draw_right(pdf: canvas.Canvas, x: float, y: float, text: str) -> None:
    pdf.drawRightString(x, y, text)


def build(path: Path, *, broken: bool = False) -> None:
    pdf = canvas.Canvas(str(path), pagesize=A4)
    width, height = A4
    y = height - 60

    pdf.setFont("Helvetica", 9)
    pdf.drawString(COL_TEXT_LEFT, y, "PostFinance AG   Privatkonto")
    y -= LINE_HEIGHT
    pdf.drawString(COL_TEXT_LEFT, y, "Kontoauszug 01.06.2026 - 30.06.2026")
    y -= LINE_HEIGHT
    pdf.drawString(COL_TEXT_LEFT, y, "IBAN CH26 0900 0000 3067 9011 4 CHF   Kontonummer 30-679011-4")
    y -= LINE_HEIGHT * 2

    # Header row. The extractor reads the column positions from exactly this.
    pdf.setFont("Helvetica-Bold", 9)
    pdf.drawString(COL_TEXT_LEFT, y, "Datum")
    pdf.drawString(COL_TEXT_LEFT + 55, y, "Text")
    draw_right(pdf, COL_GUTSCHRIFT, y, "Gutschrift")
    draw_right(pdf, COL_LASTSCHRIFT, y, "Lastschrift")
    draw_right(pdf, COL_VALUTA, y, "Valuta")
    draw_right(pdf, COL_SALDO, y, "Saldo")
    y -= LINE_HEIGHT
    pdf.setFont("Helvetica", 9)

    pdf.drawString(COL_TEXT_LEFT, y, "31.05.26")
    pdf.drawString(COL_TEXT_LEFT + 55, y, "Kontostand")
    draw_right(pdf, COL_SALDO, y, "1 953.55")
    y -= LINE_HEIGHT

    # (date, description lines, credit, debit, valuta, balance)
    bookings = [
        (
            "01.06.26",
            ["LASTSCHRIFT DAUERAUFTRAG: 90-30803372", "STADT ZUERICH SOZIALE DIENSTE"],
            None,
            "123.00",
            "01.06.26",
            "1 830.55",
        ),
        (
            # Long references wrap onto a continuation line, as the real
            # statements do; left on one line the text would physically
            # overrun the right-aligned amount column.
            "05.06.26",
            ["KONTOUEBERTRAG VON", "CH7809000000167097053"],
            "2 000.00",
            None,
            "05.06.26",
            "3 830.55",
        ),
        (
            # A four-digit debit: the space thousands separator is the hazard.
            "06.06.26",
            ["APPLE PAY KAUF/DIENSTLEISTUNG VOM 05.06.2026", "KARTEN NR. XXXX3907 DATA QUEST AG THUN (CH)"],
            None,
            "1 065.28",
            "05.06.26",
            "2 765.27",
        ),
        (
            "11.06.26",
            ["TWINT GELD EMPFANGEN VOM 11.06.2026"],
            "40.55",
            None,
            "11.06.26",
            "2 805.82",
        ),
        (
            "29.06.26",
            ["AUFTRAG CH-DD-BASISLASTSCHRIFT", "ZAHLUNGSEMPFAENGER: SALT MOBILE SA"],
            None,
            "90.25",
            "29.06.26",
            "2 715.57",
        ),
    ]

    for date, lines, credit, debit, valuta, balance in bookings:
        pdf.drawString(COL_TEXT_LEFT, y, date)
        pdf.drawString(COL_TEXT_LEFT + 55, y, lines[0])
        if credit:
            draw_right(pdf, COL_GUTSCHRIFT, y, credit)
        if debit:
            draw_right(pdf, COL_LASTSCHRIFT, y, debit)
        draw_right(pdf, COL_VALUTA, y, valuta)
        draw_right(pdf, COL_SALDO, y, balance)
        y -= LINE_HEIGHT

        # Continuation lines carry description only, no amounts.
        for continuation in lines[1:]:
            pdf.drawString(COL_TEXT_LEFT + 55, y, continuation)
            y -= LINE_HEIGHT

    y -= LINE_HEIGHT
    pdf.drawString(COL_TEXT_LEFT, y, "Total")
    # 2000.00 + 40.55 credits; 123.00 + 1065.28 + 90.25 debits.
    draw_right(pdf, COL_GUTSCHRIFT, y, "2 040.55")
    # A broken variant misstates the debit total, so reconciliation must fail.
    draw_right(pdf, COL_LASTSCHRIFT, y, "1 178.53" if broken else "1 278.53")
    y -= LINE_HEIGHT

    pdf.drawString(COL_TEXT_LEFT, y, "30.06.26")
    pdf.drawString(COL_TEXT_LEFT + 55, y, "Kontostand")
    draw_right(pdf, COL_SALDO, y, "2 715.57")

    pdf.showPage()
    pdf.save()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out", type=Path)
    parser.add_argument("--broken", action="store_true", help="emit a statement that does not reconcile")
    args = parser.parse_args()
    build(args.out, broken=args.broken)


if __name__ == "__main__":
    main()
