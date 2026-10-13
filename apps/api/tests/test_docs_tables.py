"""Markdown tables in the README and docs stay well formed.

A row with the wrong cell count, or a literal ``\\n`` that glues two rows together, renders as a broken table on
GitHub without any other check noticing (docs/architecture.md shipped one).
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
DOCS = sorted([ROOT / "README.md", *(ROOT / "docs").rglob("*.md")])
SEPARATOR = re.compile(r"^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$")


def _cells(row: str) -> int:
    body = row.strip()
    body = body[1:] if body.startswith("|") else body
    body = body[:-1] if body.endswith("|") and not body.endswith("\\|") else body
    return len(re.split(r"(?<!\\)\|", body))


def _tables(text: str) -> list[list[tuple[int, str]]]:
    """Contiguous GFM tables (header + separator + rows), outside fenced code blocks."""
    lines = text.splitlines()
    tables: list[list[tuple[int, str]]] = []
    fenced = False
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.lstrip().startswith("```"):
            fenced = not fenced
        elif (
            not fenced
            and "|" in line
            and i + 1 < len(lines)
            and SEPARATOR.match(lines[i + 1].strip())
        ):
            table = [(i + 1, line), (i + 2, lines[i + 1])]
            i += 2
            while i < len(lines) and lines[i].strip().startswith("|"):
                table.append((i + 1, lines[i]))
                i += 1
            tables.append(table)
            continue
        i += 1
    return tables


def test_docs_are_found():
    assert ROOT / "docs" / "architecture.md" in DOCS


@pytest.mark.parametrize("path", DOCS, ids=lambda p: p.relative_to(ROOT).as_posix())
def test_markdown_table_rows_match_their_header(path: Path):
    problems = []
    for table in _tables(path.read_text(encoding="utf-8")):
        width = _cells(table[0][1])
        for number, row in table:
            if "|\\n|" in row.replace(" ", ""):
                problems.append(f"line {number}: literal \\n joins two rows")
            elif _cells(row) != width:
                problems.append(f"line {number}: {_cells(row)} cells, header has {width}")
    assert not problems, f"{path.relative_to(ROOT)}: " + "; ".join(problems)


def test_the_check_catches_a_glued_row():
    text = "| A | B |\n| --- | --- |\n| x | y |\\n| z | w |\n"
    (table,) = _tables(text)
    assert "|\\n|" in table[2][1].replace(" ", "")
    assert _cells(table[2][1]) != _cells(table[0][1])
