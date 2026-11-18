#!/usr/bin/env python3
"""Reusable, local-only Office file operations for the DSH office skill."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Callable, Iterable


class OfficeToolError(RuntimeError):
    """A user-facing validation or operation error."""


PLACEHOLDER = re.compile(r"{{\s*([^{}]+?)\s*}}")


class FormulaValue(str):
    """An actual spreadsheet formula, distinct from literal text beginning with '='."""


def require_file(path: str | Path, label: str) -> Path:
    value = Path(path).expanduser().resolve()
    if not value.is_file():
        raise OfficeToolError(f"{label} does not exist or is not a file: {value}")
    return value


def require_output(output: str | Path, inputs: Iterable[str | Path]) -> Path:
    target = Path(output).expanduser().resolve()
    for source in inputs:
        if target == Path(source).expanduser().resolve():
            raise OfficeToolError(f"output must differ from every input: {target}")
    if os.path.lexists(target):
        raise OfficeToolError(f"refusing to overwrite existing output: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def atomic_target(target: Path, writer: Callable[[Path], None], suffix: str = "") -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if os.path.lexists(target):
        raise OfficeToolError(f"refusing to overwrite existing output: {target}")
    descriptor, temporary_name = tempfile.mkstemp(
        dir=target.parent,
        prefix=f".{target.name}.",
        suffix=suffix,
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        writer(temporary)
        try:
            os.link(temporary, target)
        except FileExistsError as error:
            raise OfficeToolError(
                f"refusing to overwrite existing output: {target}"
            ) from error
        except OSError:
            try:
                destination = os.open(
                    target,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o666,
                )
            except FileExistsError as error:
                raise OfficeToolError(
                    f"refusing to overwrite existing output: {target}"
                ) from error
            try:
                with os.fdopen(destination, "wb") as output, temporary.open("rb") as source:
                    while chunk := source.read(1024 * 1024):
                        output.write(chunk)
                    output.flush()
                    os.fsync(output.fileno())
            except Exception:
                target.unlink(missing_ok=True)
                raise
        finally:
            temporary.unlink(missing_ok=True)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def parse_page_spec(value: str, page_count: int) -> list[int]:
    if page_count < 1:
        raise OfficeToolError("input document contains no pages")
    if value.strip().lower() == "all":
        return list(range(page_count))
    result: list[int] = []
    for token in value.split(","):
        part = token.strip()
        if not part:
            continue
        match = re.fullmatch(r"(\d+)(?:-(\d+))?", part)
        if match is None:
            raise OfficeToolError(f"invalid page range: {part}")
        start = int(match.group(1))
        end = int(match.group(2) or start)
        if start < 1 or end < 1 or start > end or end > page_count:
            raise OfficeToolError(
                f"page range {part} is outside 1-{page_count}"
            )
        result.extend(range(start - 1, end))
    if not result:
        raise OfficeToolError("at least one page is required")
    return result


def pdf_merge(inputs: list[str], output: str) -> dict[str, Any]:
    from pypdf import PdfReader, PdfWriter

    sources = [require_file(path, "PDF input") for path in inputs]
    if len(sources) < 2:
        raise OfficeToolError("merge requires at least two PDF inputs")
    target = require_output(output, sources)
    writer = PdfWriter()
    page_count = 0
    for source in sources:
        reader = PdfReader(str(source))
        if reader.is_encrypted:
            raise OfficeToolError(f"encrypted PDF is not supported: {source}")
        for page in reader.pages:
            writer.add_page(page)
            page_count += 1
    if page_count < 1:
        raise OfficeToolError("merged PDF contains no pages")

    def write(path: Path) -> None:
        with path.open("wb") as handle:
            writer.write(handle)

    atomic_target(target, write, ".pdf")
    return {"operation": "pdf-merge", "pages": page_count, "output": str(target)}


def pdf_split(input_path: str, output_dir: str) -> dict[str, Any]:
    from pypdf import PdfReader, PdfWriter

    source = require_file(input_path, "PDF input")
    reader = PdfReader(str(source))
    destination = Path(output_dir).expanduser().resolve()
    destination.mkdir(parents=True, exist_ok=True)
    outputs = [
        destination / f"{source.stem}-page-{index:03d}.pdf"
        for index in range(1, len(reader.pages) + 1)
    ]
    for output in outputs:
        if output == source:
            raise OfficeToolError("split output must differ from the input")
        if os.path.lexists(output):
            raise OfficeToolError(f"refusing to overwrite existing output: {output}")
    for page_number, (page, output) in enumerate(zip(reader.pages, outputs), 1):
        writer = PdfWriter()
        writer.add_page(page)

        def write(path: Path, current_writer: PdfWriter = writer) -> None:
            with path.open("wb") as handle:
                current_writer.write(handle)

        atomic_target(output, write, ".pdf")
    return {
        "operation": "pdf-split",
        "pages": len(outputs),
        "outputs": [str(path) for path in outputs],
    }


def pdf_extract_pages(input_path: str, output: str, pages: str) -> dict[str, Any]:
    from pypdf import PdfReader, PdfWriter

    source = require_file(input_path, "PDF input")
    target = require_output(output, [source])
    reader = PdfReader(str(source))
    selected = parse_page_spec(pages, len(reader.pages))
    writer = PdfWriter()
    for index in selected:
        writer.add_page(reader.pages[index])

    def write(path: Path) -> None:
        with path.open("wb") as handle:
            writer.write(handle)

    atomic_target(target, write, ".pdf")
    return {
        "operation": "pdf-extract-pages",
        "pages": [index + 1 for index in selected],
        "output": str(target),
    }


def pdf_rotate(input_path: str, output: str, pages: str, degrees: int) -> dict[str, Any]:
    from pypdf import PdfReader, PdfWriter

    if degrees not in {90, 180, 270}:
        raise OfficeToolError("rotation must be 90, 180, or 270 degrees")
    source = require_file(input_path, "PDF input")
    target = require_output(output, [source])
    reader = PdfReader(str(source))
    selected = set(parse_page_spec(pages, len(reader.pages)))
    writer = PdfWriter()
    for index, page in enumerate(reader.pages):
        if index in selected:
            page.rotate(degrees)
        writer.add_page(page)

    def write(path: Path) -> None:
        with path.open("wb") as handle:
            writer.write(handle)

    atomic_target(target, write, ".pdf")
    return {
        "operation": "pdf-rotate",
        "degrees": degrees,
        "pages": sorted(index + 1 for index in selected),
        "output": str(target),
    }


def pdf_extract_text(input_path: str, output: str) -> dict[str, Any]:
    from pypdf import PdfReader

    source = require_file(input_path, "PDF input")
    target = require_output(output, [source])
    reader = PdfReader(str(source))
    pages = [page.extract_text() or "" for page in reader.pages]
    text = "\n\n".join(pages)
    atomic_target(
        target,
        lambda path: path.write_text(text, encoding="utf-8"),
        ".txt",
    )
    return {
        "operation": "pdf-extract-text",
        "pages": len(pages),
        "characters": len(text),
        "output": str(target),
    }


def replace_in_paragraph(paragraph: Any, old: str, new: str) -> int:
    if not old:
        raise OfficeToolError("replacement search text cannot be empty")
    replacements = 0
    while True:
        runs = list(paragraph.runs)
        full = "".join(run.text for run in runs)
        start = full.find(old)
        if start < 0:
            return replacements
        end = start + len(old)
        position = 0
        for run in runs:
            run_start = position
            run_end = run_start + len(run.text)
            position = run_end
            if run_end <= start or run_start >= end:
                continue
            before = run.text[: max(0, start - run_start)]
            after = run.text[max(0, end - run_start) :]
            if run_start <= start < run_end:
                run.text = before + new + (after if end <= run_end else "")
            else:
                run.text = after
        replacements += 1


def _iter_table_paragraphs(table: Any) -> Iterable[Any]:
    for row in table.rows:
        for cell in row.cells:
            yield from cell.paragraphs
            for nested in cell.tables:
                yield from _iter_table_paragraphs(nested)


def iter_docx_paragraphs(document: Any) -> Iterable[Any]:
    yield from document.paragraphs
    for table in document.tables:
        yield from _iter_table_paragraphs(table)
    seen: set[int] = set()
    for section in document.sections:
        for part in (section.header, section.footer):
            identity = id(part._element)
            if identity in seen:
                continue
            seen.add(identity)
            yield from part.paragraphs
            for table in part.tables:
                yield from _iter_table_paragraphs(table)


def docx_replace(input_path: str, output: str, old: str, new: str) -> dict[str, Any]:
    from docx import Document

    source = require_file(input_path, "DOCX input")
    target = require_output(output, [source])
    document = Document(str(source))
    count = sum(
        replace_in_paragraph(paragraph, old, new)
        for paragraph in iter_docx_paragraphs(document)
    )

    def write(path: Path) -> None:
        document.save(str(path))

    atomic_target(target, write, ".docx")
    return {
        "operation": "docx-replace",
        "replacements": count,
        "status": "replaced" if count else "unchanged",
        "output": str(target),
    }


def docx_fill(template: str, output: str, data_path: str) -> dict[str, Any]:
    from docx import Document

    source = require_file(template, "DOCX template")
    data_file = require_file(data_path, "data JSON")
    target = require_output(output, [source, data_file])
    values = json.loads(data_file.read_text(encoding="utf-8"))
    if not isinstance(values, dict):
        raise OfficeToolError("data JSON must be an object")
    plain_values = {str(key): "" if value is None else str(value) for key, value in values.items()}
    document = Document(str(source))
    replaced: dict[str, int] = {}
    for paragraph in iter_docx_paragraphs(document):
        for key, value in plain_values.items():
            token = "{{" + key + "}}"
            count = replace_in_paragraph(paragraph, token, value)
            if count:
                replaced[key] = replaced.get(key, 0) + count
    replacements = sum(replaced.values())
    if replacements == 0:
        raise OfficeToolError(
            "DOCX template has no placeholder matching the supplied data"
        )
    unresolved = sorted({
        match.group(1).strip()
        for paragraph in iter_docx_paragraphs(document)
        for match in PLACEHOLDER.finditer(paragraph.text)
    })
    unused = sorted(set(plain_values) - set(replaced))

    def write(path: Path) -> None:
        document.save(str(path))

    atomic_target(target, write, ".docx")
    return {
        "operation": "docx-fill",
        "replacements": replaced,
        "unresolvedPlaceholders": unresolved,
        "unusedKeys": unused,
        "status": "complete" if not unresolved else "partial",
        "output": str(target),
    }


def _load_workbook(path: Path, mode: str, read_only: bool = True) -> Any:
    from openpyxl import load_workbook

    return load_workbook(path, data_only=mode == "values", read_only=read_only)


def _typed_cell_value(cell: Any, mode: str) -> Any:
    value = cell.value
    if mode == "formulas" and cell.data_type == "f" and isinstance(value, str):
        return FormulaValue(value)
    return value


def _table_rows(
    path: Path,
    mode: str,
    sheet: str | None = None,
) -> tuple[list[str], list[list[Any]]]:
    workbook = _load_workbook(path, mode)
    try:
        if sheet is not None:
            if sheet not in workbook.sheetnames:
                raise OfficeToolError(f"sheet does not exist: {sheet}")
            worksheet = workbook[sheet]
        else:
            worksheet = workbook[workbook.sheetnames[0]]
        values = [
            [_typed_cell_value(cell, mode) for cell in row]
            for row in worksheet.iter_rows()
        ]
        if not values:
            raise OfficeToolError(f"sheet contains no rows: {path}")
        headers = [str(value).strip() if value is not None else "" for value in values[0]]
        if not headers or any(not header for header in headers):
            raise OfficeToolError(f"first row must contain non-empty column names: {path}")
        if len(set(headers)) != len(headers):
            raise OfficeToolError(f"column names must be unique: {path}")
        rows = [
            list(row[: len(headers)])
            for row in values[1:]
            if any(value is not None for value in row)
        ]
        return headers, rows
    finally:
        workbook.close()


def _write_table(
    target: Path,
    headers: Iterable[Any],
    rows: Iterable[Iterable[Any]],
    mode: str,
    sheet_title: str = "Result",
    formula_literals: bool = False,
) -> None:
    from openpyxl import Workbook

    def assign(cell: Any, value: Any, *, header: bool = False) -> None:
        is_formula = isinstance(value, FormulaValue)
        cell.value = str(value) if is_formula else value
        if is_formula:
            cell.data_type = "f" if mode == "formulas" and not formula_literals and not header else "s"
        elif isinstance(value, str) and value.startswith("="):
            cell.data_type = "s"

    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = sheet_title[:31] or "Result"
    header_values = list(headers)
    for column, value in enumerate(header_values, 1):
        assign(worksheet.cell(1, column), value, header=True)
    materialized = list(rows)
    for row_number, row in enumerate(materialized, 2):
        for column, value in enumerate(row, 1):
            assign(worksheet.cell(row_number, column), value)
    worksheet.freeze_panes = "A2"

    def write(path: Path) -> None:
        workbook.save(str(path))

    try:
        atomic_target(target, write, ".xlsx")
    finally:
        workbook.close()


def excel_combine(
    inputs: list[str],
    output: str,
    mode: str,
    sheet: str | None,
    allow_formula_shift: bool,
) -> dict[str, Any]:
    sources = [require_file(path, "XLSX input") for path in inputs]
    if len(sources) < 2:
        raise OfficeToolError("combine requires at least two XLSX inputs")
    if mode == "formulas" and not allow_formula_shift:
        raise OfficeToolError(
            "formula-mode combine moves rows; pass --allow-formula-shift only "
            "after confirming relative formula references may need correction"
        )
    target = require_output(output, sources)
    columns: list[str] = []
    combined: list[list[Any]] = []
    for source in sources:
        headers, rows = _table_rows(source, mode, sheet)
        for column in headers:
            if column not in columns:
                columns.append(column)
        for row in rows:
            record = dict(zip(headers, row))
            combined.append([record.get(column) for column in columns])
    _write_table(target, columns, combined, mode, "Combined")
    return {
        "operation": "xlsx-combine",
        "mode": mode,
        "rows": len(combined),
        "output": str(target),
    }


def _records(path: Path, mode: str, sheet: str | None) -> tuple[list[str], list[dict[str, Any]]]:
    headers, raw_rows = _table_rows(path, mode, sheet)
    return headers, [dict(zip(headers, row)) for row in raw_rows]


def _key(value: Any) -> str:
    if isinstance(value, FormulaValue):
        return json.dumps({"formula": str(value)}, ensure_ascii=False, sort_keys=True)
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def excel_compare_by_key(
    left_path: str,
    right_path: str,
    output: str,
    keys: str,
    mode: str,
    left_sheet: str | None,
    right_sheet: str | None,
) -> dict[str, Any]:
    left = require_file(left_path, "left XLSX input")
    right = require_file(right_path, "right XLSX input")
    target = require_output(output, [left, right])
    key_columns = [value.strip() for value in keys.split(",") if value.strip()]
    if not key_columns:
        raise OfficeToolError("at least one key column is required")
    left_headers, left_rows = _records(left, mode, left_sheet)
    right_headers, right_rows = _records(right, mode, right_sheet)
    for header in key_columns:
        if header not in left_headers or header not in right_headers:
            raise OfficeToolError(f"key column is missing from an input: {header}")

    def index(rows_by_key: list[dict[str, Any]], label: str) -> dict[str, dict[str, Any]]:
        result: dict[str, dict[str, Any]] = {}
        for row in rows_by_key:
            current = _key([row.get(column) for column in key_columns])
            if current in result:
                raise OfficeToolError(f"duplicate key in {label}: {current}")
            result[current] = row
        return result

    left_index = index(left_rows, "left input")
    right_index = index(right_rows, "right input")
    report: list[list[Any]] = []
    all_columns = list(dict.fromkeys(left_headers + right_headers))
    for current in sorted(left_index.keys() | right_index.keys()):
        left_row = left_index.get(current)
        right_row = right_index.get(current)
        key_value = _key(
            [((left_row or right_row) or {}).get(column) for column in key_columns]
        )
        if left_row is None:
            report.append(["added", key_value, "", "", ""])
            continue
        if right_row is None:
            report.append(["removed", key_value, "", "", ""])
            continue
        for column in all_columns:
            if column in key_columns:
                continue
            if _key(left_row.get(column)) != _key(right_row.get(column)):
                report.append([
                    "changed",
                    key_value,
                    column,
                    left_row.get(column),
                    right_row.get(column),
                ])
    _write_table(
        target,
        ["change", "key", "field", "left", "right"],
        report,
        mode,
        "Comparison",
        formula_literals=True,
    )
    return {
        "operation": "xlsx-compare-by-key",
        "mode": mode,
        "differences": len(report),
        "output": str(target),
    }


def excel_dedupe(
    input_path: str,
    output: str,
    keys: str | None,
    mode: str,
    sheet: str | None,
    allow_formula_shift: bool,
) -> dict[str, Any]:
    source = require_file(input_path, "XLSX input")
    if mode == "formulas" and not allow_formula_shift:
        raise OfficeToolError(
            "formula-mode dedupe moves rows; pass --allow-formula-shift only "
            "after confirming relative formula references may need correction"
        )
    target = require_output(output, [source])
    headers, rows = _table_rows(source, mode, sheet)
    key_columns = (
        [value.strip() for value in keys.split(",") if value.strip()]
        if keys
        else headers
    )
    if not key_columns or any(column not in headers for column in key_columns):
        raise OfficeToolError("dedupe key columns must exist in the first row")
    seen: set[str] = set()
    kept: list[list[Any]] = []
    for row in rows:
        record = dict(zip(headers, row))
        identity = _key([record.get(column) for column in key_columns])
        if identity in seen:
            continue
        seen.add(identity)
        kept.append(row)
    _write_table(target, headers, kept, mode, "Deduplicated")
    return {
        "operation": "xlsx-dedupe",
        "mode": mode,
        "inputRows": len(rows),
        "removedRows": len(rows) - len(kept),
        "output": str(target),
    }


def _safe_sheet_filename(name: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")
    return (cleaned or "sheet")[:80]


def excel_split_sheets(
    input_path: str,
    output_dir: str,
    sheets: str | None,
    mode: str,
) -> dict[str, Any]:
    source = require_file(input_path, "XLSX input")
    workbook = _load_workbook(source, mode)
    try:
        selected = (
            [value.strip() for value in sheets.split(",") if value.strip()]
            if sheets
            else list(workbook.sheetnames)
        )
        missing = [value for value in selected if value not in workbook.sheetnames]
        if missing:
            raise OfficeToolError(f"sheet does not exist: {', '.join(missing)}")
        destination = Path(output_dir).expanduser().resolve()
        outputs = [
            destination / f"{source.stem}-{_safe_sheet_filename(sheet_name)}.xlsx"
            for sheet_name in selected
        ]
        if len({path.resolve() for path in outputs}) != len(outputs):
            raise OfficeToolError("split output names contain a conflict")
        for output in outputs:
            if output == source:
                raise OfficeToolError("split output must differ from the input")
            if os.path.lexists(output):
                raise OfficeToolError(
                    f"refusing to overwrite existing output: {output}"
                )
        destination.mkdir(parents=True, exist_ok=True)
        for sheet_name, output in zip(selected, outputs):
            worksheet = workbook[sheet_name]
            values = [
                [_typed_cell_value(cell, mode) for cell in row]
                for row in worksheet.iter_rows()
            ]
            _write_table(
                output,
                values[0] if values else [],
                values[1:] if values else [],
                mode,
                sheet_name,
            )
    finally:
        workbook.close()
    return {
        "operation": "xlsx-split-sheets",
        "mode": mode,
        "outputs": [str(path) for path in outputs],
    }


def _iter_shapes(shapes: Iterable[Any]) -> Iterable[Any]:
    for shape in shapes:
        yield shape
        if getattr(shape, "shape_type", None) == 6:
            yield from _iter_shapes(shape.shapes)


def _replace_shape_text(shape: Any, values: dict[str, Any]) -> int:
    if not getattr(shape, "has_text_frame", False):
        return 0
    count = 0
    for paragraph in shape.text_frame.paragraphs:
        text = paragraph.text
        for key, value in values.items():
            token = "{{" + key + "}}"
            if token not in text:
                continue
            text = text.replace(token, "" if value is None else str(value))
            count += 1
        if text != paragraph.text:
            paragraph.text = text
    return count


def pptx_fill(template: str, output: str, data_path: str) -> dict[str, Any]:
    from pptx import Presentation
    from pptx.util import Inches

    source = require_file(template, "PPTX template")
    data_file = require_file(data_path, "data JSON")
    values = json.loads(data_file.read_text(encoding="utf-8"))
    if not isinstance(values, dict):
        raise OfficeToolError("data JSON must be an object")
    image_paths = [
        value.get("image")
        for value in values.values()
        if isinstance(value, dict) and isinstance(value.get("image"), str)
    ]
    checked_images = [require_file(path, "image") for path in image_paths]
    target = require_output(output, [source, data_file, *checked_images])
    presentation = Presentation(str(source))
    text_replacements = 0
    image_replacements = 0
    for slide in presentation.slides:
        for shape in _iter_shapes(slide.shapes):
            if getattr(shape, "has_text_frame", False):
                for paragraph in shape.text_frame.paragraphs:
                    token = paragraph.text.strip()
                    if not (token.startswith("{{") and token.endswith("}}")):
                        continue
                    key = token[2:-2]
                    value = values.get(key)
                    if not isinstance(value, dict) or not isinstance(value.get("image"), str):
                        continue
                    image = require_file(value["image"], "image")
                    shape.text_frame.clear()
                    slide.shapes.add_picture(
                        str(image),
                        shape.left,
                        shape.top,
                        width=shape.width or Inches(4),
                        height=shape.height or Inches(3),
                    )
                    image_replacements += 1
            text_values = {
                key: value
                for key, value in values.items()
                if not isinstance(value, dict)
            }
            text_replacements += _replace_shape_text(shape, text_values)
            if getattr(shape, "has_table", False):
                for row in shape.table.rows:
                    for cell in row.cells:
                        for paragraph in cell.text_frame.paragraphs:
                            text = paragraph.text
                            for key, value in text_values.items():
                                text = text.replace(
                                    "{{" + key + "}}",
                                    "" if value is None else str(value),
                                )
                            if text != paragraph.text:
                                paragraph.text = text
                                text_replacements += 1
    replacements = text_replacements + image_replacements
    if replacements == 0:
        raise OfficeToolError(
            "PPTX template has no placeholder matching the supplied data"
        )
    unresolved: set[str] = set()
    for slide in presentation.slides:
        for shape in _iter_shapes(slide.shapes):
            if getattr(shape, "has_text_frame", False):
                unresolved.update(
                    match.group(1).strip()
                    for match in PLACEHOLDER.finditer(shape.text)
                )
            if getattr(shape, "has_table", False):
                for row in shape.table.rows:
                    for cell in row.cells:
                        unresolved.update(
                            match.group(1).strip()
                            for match in PLACEHOLDER.finditer(cell.text)
                        )

    def write(path: Path) -> None:
        presentation.save(str(path))

    atomic_target(target, write, ".pptx")
    with zipfile.ZipFile(target) as archive:
        if "ppt/presentation.xml" not in archive.namelist():
            raise OfficeToolError("generated PPTX is not a valid presentation")
    return {
        "operation": "pptx-fill",
        "textReplacements": text_replacements,
        "imageReplacements": image_replacements,
        "unresolvedPlaceholders": sorted(unresolved),
        "status": "complete" if not unresolved else "partial",
        "slides": len(presentation.slides),
        "output": str(target),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Perform validated local Office operations without overwriting inputs."
    )
    groups = parser.add_subparsers(dest="group", required=True)

    pdf = groups.add_parser("pdf")
    pdf_commands = pdf.add_subparsers(dest="command", required=True)
    merge = pdf_commands.add_parser("merge")
    merge.add_argument("--output", required=True)
    merge.add_argument("inputs", nargs="+")
    split = pdf_commands.add_parser("split")
    split.add_argument("--input", required=True)
    split.add_argument("--output-dir", required=True)
    extract = pdf_commands.add_parser("extract-pages")
    extract.add_argument("--input", required=True)
    extract.add_argument("--output", required=True)
    extract.add_argument("--pages", required=True)
    rotate = pdf_commands.add_parser("rotate")
    rotate.add_argument("--input", required=True)
    rotate.add_argument("--output", required=True)
    rotate.add_argument("--pages", required=True)
    rotate.add_argument("--degrees", required=True, type=int)
    text = pdf_commands.add_parser("extract-text")
    text.add_argument("--input", required=True)
    text.add_argument("--output", required=True)

    docx = groups.add_parser("docx")
    docx_commands = docx.add_subparsers(dest="command", required=True)
    fill = docx_commands.add_parser("fill")
    fill.add_argument("--template", required=True)
    fill.add_argument("--output", required=True)
    fill.add_argument("--data", required=True)
    replace = docx_commands.add_parser("replace")
    replace.add_argument("--input", required=True)
    replace.add_argument("--output", required=True)
    replace.add_argument("--find", required=True)
    replace.add_argument("--replacement", required=True)

    excel = groups.add_parser("excel")
    excel_commands = excel.add_subparsers(dest="command", required=True)
    combine = excel_commands.add_parser("combine")
    combine.add_argument("--output", required=True)
    combine.add_argument("--mode", choices=["values", "formulas"], required=True)
    combine.add_argument("--sheet")
    combine.add_argument("--allow-formula-shift", action="store_true")
    combine.add_argument("inputs", nargs="+")
    compare = excel_commands.add_parser("compare-by-key")
    compare.add_argument("--left", required=True)
    compare.add_argument("--right", required=True)
    compare.add_argument("--output", required=True)
    compare.add_argument("--keys", required=True)
    compare.add_argument("--mode", choices=["values", "formulas"], required=True)
    compare.add_argument("--left-sheet")
    compare.add_argument("--right-sheet")
    dedupe = excel_commands.add_parser("dedupe")
    dedupe.add_argument("--input", required=True)
    dedupe.add_argument("--output", required=True)
    dedupe.add_argument("--keys")
    dedupe.add_argument("--mode", choices=["values", "formulas"], required=True)
    dedupe.add_argument("--sheet")
    dedupe.add_argument("--allow-formula-shift", action="store_true")
    split = excel_commands.add_parser("split-sheets")
    split.add_argument("--input", required=True)
    split.add_argument("--output-dir", required=True)
    split.add_argument("--sheets")
    split.add_argument("--mode", choices=["values", "formulas"], required=True)

    pptx = groups.add_parser("pptx")
    pptx_commands = pptx.add_subparsers(dest="command", required=True)
    pptx_fill_command = pptx_commands.add_parser("fill")
    pptx_fill_command.add_argument("--template", required=True)
    pptx_fill_command.add_argument("--output", required=True)
    pptx_fill_command.add_argument("--data", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.group == "pdf":
            if args.command == "merge":
                result = pdf_merge(args.inputs, args.output)
            elif args.command == "split":
                result = pdf_split(args.input, args.output_dir)
            elif args.command == "extract-pages":
                result = pdf_extract_pages(args.input, args.output, args.pages)
            elif args.command == "rotate":
                result = pdf_rotate(args.input, args.output, args.pages, args.degrees)
            else:
                result = pdf_extract_text(args.input, args.output)
        elif args.group == "docx":
            result = (
                docx_fill(args.template, args.output, args.data)
                if args.command == "fill"
                else docx_replace(args.input, args.output, args.find, args.replacement)
            )
        elif args.group == "excel":
            if args.command == "combine":
                result = excel_combine(
                    args.inputs,
                    args.output,
                    args.mode,
                    args.sheet,
                    args.allow_formula_shift,
                )
            elif args.command == "compare-by-key":
                result = excel_compare_by_key(
                    args.left,
                    args.right,
                    args.output,
                    args.keys,
                    args.mode,
                    args.left_sheet,
                    args.right_sheet,
                )
            elif args.command == "dedupe":
                result = excel_dedupe(
                    args.input,
                    args.output,
                    args.keys,
                    args.mode,
                    args.sheet,
                    args.allow_formula_shift,
                )
            else:
                result = excel_split_sheets(
                    args.input,
                    args.output_dir,
                    args.sheets,
                    args.mode,
                )
        else:
            result = pptx_fill(args.template, args.output, args.data)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OfficeToolError, FileNotFoundError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"office-tools: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
