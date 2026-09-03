#!/usr/bin/env python3
"""Tests for the PDF statement extractor.

Run with: python3 -m unittest discover -s test -p 'test_*.py'

Fixtures are generated on the fly rather than committed, since a real
statement is a personal financial record. They reproduce the three hazards
found in the actual documents:

  - amounts split on a space thousands separator
  - credit vs debit carried only by column position
  - a "COPY" watermark whose letters land inside the text stream
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "test" / "fixtures"))

from extract_pdf_statement import (  # noqa: E402
    clean_description,
    extract,
    find_iban,
    find_period,
    parse_amount,
    parse_date,
)
from make_statement_pdf import build  # noqa: E402


class ParseAmountTest(unittest.TestCase):
    def test_thousands_separators(self) -> None:
        # A plain space, as PDF statements use. Read as 669.45 this silently
        # loses CHF 4'000 — the bug recorded in kontierung-regeln.json.
        self.assertEqual(parse_amount("4 669.45"), 4669.45)
        self.assertEqual(parse_amount("1 953.55"), 1953.55)
        self.assertEqual(parse_amount("4'669.45"), 4669.45)
        self.assertEqual(parse_amount("90.25"), 90.25)

    def test_rejects_non_amounts(self) -> None:
        for text in ("KARTEN", "30.06.2026", "XXXX3907", "", "1 06"):
            self.assertIsNone(parse_amount(text), text)


class ParseDateTest(unittest.TestCase):
    def test_two_and_four_digit_years(self) -> None:
        self.assertEqual(parse_date("29.06.26"), "2026-06-29")
        self.assertEqual(parse_date("29.06.2026"), "2026-06-29")

    def test_rejects_impossible_dates(self) -> None:
        self.assertIsNone(parse_date("45.13.26"))
        self.assertIsNone(parse_date("1 065.28"))


class WatermarkTest(unittest.TestCase):
    """Statement copies carry a COPY watermark that lands inside the text."""

    def test_iban_survives_a_letter_injected_mid_number(self) -> None:
        # Real example from an August 2026 statement.
        text = "IBAN CH41 0900 0000 15 O 45 7065 4 CHF"
        self.assertEqual(find_iban(text), "CH4109000000154570654")

    def test_clean_iban_still_reads(self) -> None:
        self.assertEqual(
            find_iban("IBAN CH26 0900 0000 3067 9011 4 CHF"),
            "CH2609000000306790114",
        )

    def test_counterparty_iban_is_not_mistaken_for_the_account(self) -> None:
        # An IBAN quoted inside a booking description has no "IBAN" label.
        text = "KONTOÜBERTRAG AUF CH2609000000306790114\nIBAN CH41 0900 0000 1545 7065 4"
        self.assertEqual(find_iban(text), "CH4109000000154570654")

    def test_period_survives_a_letter_injected_into_the_date(self) -> None:
        # Real example: the P belongs to the watermark, not to the date.
        self.assertEqual(
            find_period("Kontoauszug 01.08.2026 - 31.P08.2026"),
            ("2026-08-01", "2026-08-31"),
        )


class CleanDescriptionTest(unittest.TestCase):
    """Page furniture repeats on every page and lands inside descriptions."""

    def test_strips_print_furniture(self) -> None:
        # Real tokens from a June statement: despatch code, print job code,
        # a stray watermark letter, and a page footer.
        tokens = ["ED", "TWINT", "KAUF/DIENSTLEISTUNG", "65600", "SBB", "EASYRIDE", "BERN", "(CH)", "Seite", "2"]
        self.assertEqual(
            clean_description(tokens),
            "TWINT KAUF/DIENSTLEISTUNG SBB EASYRIDE BERN (CH)",
        )

    def test_keeps_the_payee_intact(self) -> None:
        # Categorization matches on the payee, so it must survive untouched.
        tokens = ["KARTEN", "NR.", "XXXX3907", "ANTHROPIC*", "CLAUDE", "SUB", "SAN", "FRANCISCO"]
        self.assertIn("ANTHROPIC* CLAUDE SUB SAN FRANCISCO", clean_description(tokens))

    def test_does_not_strip_digits_that_are_part_of_a_name(self) -> None:
        # "COOP-1910" must not lose its number.
        self.assertEqual(clean_description(["COOP-1910", "ZH", "WOLLISHOFEN"]), "COOP-1910 ZH WOLLISHOFEN")


class ExtractStatementTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "stmt.pdf"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_extracts_every_booking_with_the_right_sign(self) -> None:
        build(self.path)
        statement = extract(self.path)

        self.assertTrue(statement.reconciled, statement.reconciliation_note)
        self.assertEqual(len(statement.bookings), 5)

        by_amount = {b.signed_amount: b for b in statement.bookings}
        # Column position, not text, decides the sign.
        self.assertIn(2000.00, by_amount)
        self.assertEqual(by_amount[2000.00].direction, "CRDT")
        self.assertIn(-123.00, by_amount)
        self.assertEqual(by_amount[-123.00].direction, "DBIT")

    def test_four_digit_amount_is_not_truncated(self) -> None:
        build(self.path)
        statement = extract(self.path)

        # "1 065.28" must not become 65.28. Nastier than it looks: when every
        # figure truncates the same way the balances still reconcile, so this
        # needs asserting directly rather than trusting the checksum.
        self.assertIn(-1065.28, [b.signed_amount for b in statement.bookings])
        self.assertEqual(statement.opening_balance, 1953.55)
        self.assertEqual(statement.total_credits, 2040.55)
        self.assertEqual(statement.total_debits, 1278.53)

    def test_wrapped_descriptions_are_attached_to_their_booking(self) -> None:
        build(self.path)
        statement = extract(self.path)

        salt = next(b for b in statement.bookings if b.signed_amount == -90.25)
        # The payee is on a continuation line, and categorization needs it.
        self.assertIn("SALT MOBILE SA", salt.description)

    def test_a_statement_that_does_not_reconcile_is_rejected(self) -> None:
        build(self.path, broken=True)
        statement = extract(self.path)

        self.assertFalse(statement.reconciled)
        self.assertIn("Saldo geht nicht auf", statement.reconciliation_note)

    def test_cli_exit_code_signals_reconciliation(self) -> None:
        script = ROOT / "scripts" / "extract_pdf_statement.py"

        build(self.path)
        self.assertEqual(subprocess.run([sys.executable, script, self.path], capture_output=True).returncode, 0)

        build(self.path, broken=True)
        # Non-zero so a pipeline cannot book an unreconciled statement by accident.
        self.assertEqual(subprocess.run([sys.executable, script, self.path], capture_output=True).returncode, 2)


if __name__ == "__main__":
    unittest.main()
