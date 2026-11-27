#!/usr/bin/env python3
"""Fixed local smoke test for DSH's pinned Office Python environment."""

from __future__ import annotations

import base64
import importlib.metadata
import json
import tempfile
from pathlib import Path

from office_tools import (
    docx_fill,
    excel_combine,
    excel_compare_by_key,
    excel_dedupe,
    excel_split_sheets,
    pdf_extract_pages,
    pdf_extract_text,
    pdf_merge,
    pdf_rotate,
    pdf_split,
    pptx_fill,
)


EXPECTED = {
    "python-docx": "1.2.0",
    "openpyxl": "3.1.5",
    "python-pptx": "1.0.2",
    "pandas": "3.0.1",
    "pypdf": "7.1.0",
}

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
    "+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def verify_versions() -> dict[str, str]:
    actual: dict[str, str] = {}
    for distribution, expected in EXPECTED.items():
        version = importlib.metadata.version(distribution)
        if version != expected:
            raise RuntimeError(
                f"{distribution} version {version} does not match fixed {expected}"
            )
        actual[distribution] = version
    return actual


def verify_all_operations(root: Path) -> dict[str, int]:
    from docx import Document
    from openpyxl import Workbook, load_workbook
    from pptx import Presentation
    from pypdf import PdfReader, PdfWriter

    input_dir = root / "input"
    output_dir = root / "output"
    input_dir.mkdir()
    output_dir.mkdir()

    pdf_a = input_dir / "a.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    with pdf_a.open("wb") as handle:
        writer.write(handle)
    pdf_b = input_dir / "b.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    with pdf_b.open("wb") as handle:
        writer.write(handle)
    merged = output_dir / "merged.pdf"
    pdf_merge([str(pdf_a), str(pdf_b)], str(merged))
    if len(PdfReader(str(merged)).pages) != 2:
        raise RuntimeError("PDF merge did not produce two pages")
    extracted = output_dir / "extracted.pdf"
    pdf_extract_pages(str(merged), str(extracted), "2")
    rotated = output_dir / "rotated.pdf"
    pdf_rotate(str(extracted), str(rotated), "1", 90)
    split_dir = output_dir / "split"
    pdf_split(str(merged), str(split_dir))
    pdf_extract_text(str(merged), str(output_dir / "text.txt"))

    data = input_dir / "data.json"
    data.write_text(json.dumps({"name": "DSH", "team": "Office"}), encoding="utf-8")
    docx_template = input_dir / "template.docx"
    document = Document()
    document.add_paragraph("Hello {{name}}")
    table = document.add_table(rows=1, cols=1)
    table.cell(0, 0).text = "{{team}}"
    document.sections[0].header.paragraphs[0].text = "{{name}}"
    document.sections[0].footer.paragraphs[0].text = "{{team}}"
    document.save(docx_template)
    docx_fill(str(docx_template), str(output_dir / "filled.docx"), str(data))

    left = input_dir / "left.xlsx"
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Data"
    sheet.append(["key", "name", "amount"])
    sheet.append(["A", "Alpha", 10])
    sheet.append(["A", "Alpha duplicate", 10])
    sheet.append(["B", "Beta", 20])
    workbook.save(left)
    right = input_dir / "right.xlsx"
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Data"
    sheet.append(["key", "name", "amount"])
    sheet.append(["A", "Alpha", 10])
    sheet.append(["B", "Beta", 25])
    workbook.save(right)
    excel_dedupe(
        str(left),
        str(output_dir / "deduped.xlsx"),
        "key",
        "values",
        "Data",
        False,
    )
    deduped = output_dir / "deduped.xlsx"
    excel_compare_by_key(
        str(deduped),
        str(right),
        str(output_dir / "comparison.xlsx"),
        "key",
        "values",
        "Deduplicated",
        "Data",
    )
    excel_combine(
        [str(left), str(right)],
        str(output_dir / "combined.xlsx"),
        "values",
        "Data",
        False,
    )
    excel_split_sheets(
        str(left),
        str(output_dir / "sheets"),
        "Data",
        "formulas",
    )
    combined_book = load_workbook(output_dir / "combined.xlsx", read_only=True)
    try:
        combined_rows = combined_book.active.max_row
    finally:
        combined_book.close()
    if combined_rows != 6:
        raise RuntimeError("XLSX combine did not retain expected rows")

    image = input_dir / "pixel.png"
    image.write_bytes(PNG)
    pptx_data = input_dir / "pptx.json"
    pptx_data.write_text(
        json.dumps({"title": "DSH", "logo": {"image": str(image)}}),
        encoding="utf-8",
    )
    template = input_dir / "template.pptx"
    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    textbox = slide.shapes.add_textbox(0, 0, 2_000_000, 500_000)
    textbox.text = "{{title}}"
    imagebox = slide.shapes.add_textbox(0, 600_000, 2_000_000, 2_000_000)
    imagebox.text = "{{logo}}"
    presentation.save(template)
    pptx_fill(str(template), str(output_dir / "filled.pptx"), str(pptx_data))
    if len(Presentation(str(output_dir / "filled.pptx")).slides) != 1:
        raise RuntimeError("PPTX operation did not preserve slide count")

    comparison_book = load_workbook(output_dir / "comparison.xlsx", read_only=True)
    try:
        comparison_rows = comparison_book.active.max_row
        if comparison_rows < 2:
            raise RuntimeError("XLSX comparison produced no meaningful difference")
    finally:
        comparison_book.close()
    summary = {
        "pdfPages": len(PdfReader(str(merged)).pages),
        "docxParagraphs": len(Document(str(output_dir / "filled.docx")).paragraphs),
        "xlsxDiffRows": comparison_rows,
        "pptxSlides": len(Presentation(str(output_dir / "filled.pptx")).slides),
    }
    return summary


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="dsh-office-smoke-") as temporary:
        result = {
            "packages": verify_versions(),
            "operations": verify_all_operations(Path(temporary)),
        }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
