"""只读提取本机原件；输入和原值只经本机管道传递，不连接网络。"""

import base64
import contextlib
import datetime
import importlib.metadata
import importlib.util
import io
import json
import math
import sys
import warnings
import zipfile


MAX_ROWS = 10000
MAX_COLUMNS = 256
MAX_CHARS = 2_000_000
MAX_CELLS = 100_000
MAX_ZIP_BYTES = 32 * 1024 * 1024
MAX_OCR_BYTES = 6 * 1024 * 1024


class DocumentError(Exception):
    pass


class ParserOutput(io.TextIOBase):
    """只记解析器是否产生额外文本，不保留原文、路径或业务值。"""

    def __init__(self):
        self.has_output = False

    def write(self, text):
        self.has_output = self.has_output or bool(text.strip())
        return len(text)


def version(name):
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return "unknown"


def require(module):
    if importlib.util.find_spec(module) is None:
        raise DocumentError("material_document_dependency_missing:" + module)


def scalar(value):
    if isinstance(value, datetime.datetime) and value.time() == datetime.time():
        return value.date().isoformat()
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    return str(value)


def inspect_zip(data, spreadsheet=False):
    """元数据和缩略图可存在，宏、嵌入程序、外部工作簿仍不进入取数。"""
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = archive.infolist()
        if len(members) > 2000 or sum(m.file_size for m in members) > MAX_ZIP_BYTES:
            raise DocumentError("material_document_limit")
        names = set()
        for member in members:
            name = member.filename
            if name in names or name.startswith("/") or "\\" in name or any(p in (".", "..") for p in name.split("/")):
                raise DocumentError("material_document_archive_invalid")
            names.add(name)
            if member.flag_bits & 1 or member.file_size > 8 * 1024 * 1024:
                raise DocumentError("material_document_archive_invalid")
            if "vbaproject" in name.lower() or "/embeddings/" in name.lower():
                raise DocumentError("material_document_active_content")
            if spreadsheet and ("/externallinks/" in name.lower()):
                raise DocumentError("material_document_external_link")
            if spreadsheet and name.endswith(".rels"):
                from xml.etree import ElementTree
                rels = ElementTree.fromstring(archive.read(member))
                for rel in rels:
                    if rel.attrib.get("TargetMode") == "External":
                        raise DocumentError("material_document_external_link")


def main(request, parser_output):
    if request.get("operation") == "capabilities":
        packages = {key: (version(package) if importlib.util.find_spec(module) else None) for key, module, package in [
            ("xls", "xlrd", "xlrd"), ("xlsx", "openpyxl", "openpyxl"),
            ("pdf", "fitz", "PyMuPDF"), ("docx", "docx", "python-docx"),
            ("images", "PIL", "Pillow"),
        ]}
        return {"status": "available", "python": sys.version.split()[0], "executable": sys.executable, "packages": packages}

    data = base64.b64decode(request["data"], validate=True)
    if len(data) > 5 * 1024 * 1024:
        raise DocumentError("material_document_limit")
    fmt = request["format"]
    maximum = min(max(int(request.get("maxPages", 40)), 1), 100)
    offset = max(int(request.get("pageOffset", 0)), 0)
    result = {"status": "read", "tables": [], "blocks": [], "diagnostics": [], "ocrPages": [], "cellStates": []}
    chars = 0
    cells_read = 0
    non_literal_cells = set()

    def block(page, text, bbox=None, **extra):
        nonlocal chars
        text = str(text).strip()
        if not text:
            return
        chars += len(text)
        if chars > MAX_CHARS or len(result["blocks"]) >= MAX_ROWS:
            raise DocumentError("material_document_limit")
        line = sum(1 for b in result["blocks"] if b["page"] == page) + 1
        result["blocks"].append({"page": page, "line": line, "text": text, **({"bbox": list(bbox)} if bbox else {}), **extra})

    def table(index, name, rows):
        nonlocal chars, cells_read
        collected = []
        for row_number, cells in rows:
            if row_number > MAX_ROWS or len(cells) > MAX_COLUMNS:
                raise DocumentError("material_document_limit")
            values = [scalar(c) for c in cells]
            while values and values[-1] in (None, "") and (index, row_number, len(values)) not in non_literal_cells:
                values.pop()
            cells_read += len(values)
            if cells_read > MAX_CELLS:
                raise DocumentError("material_document_limit")
            chars += sum(len(str(c)) for c in values if c is not None)
            if chars > MAX_CHARS:
                raise DocumentError("material_document_limit")
            if any(c is not None and c != "" for c in values) or any((index, row_number, c + 1) in non_literal_cells for c in range(len(values))):
                collected.append({"rowNumber": row_number, "cells": values})
        result["tables"].append({"sheetIndex": index, "name": str(name), "rows": collected})

    if fmt == "xls":
        require("xlrd")
        import xlrd
        book = xlrd.open_workbook(file_contents=data, on_demand=True, logfile=parser_output)
        if book.nsheets > 32:
            raise DocumentError("material_document_limit")
        for index in range(book.nsheets):
            sheet = book.sheet_by_index(index)
            if sheet.nrows > MAX_ROWS or sheet.ncols > MAX_COLUMNS:
                raise DocumentError("material_document_limit")

            def values():
                for r in range(sheet.nrows):
                    cells = []
                    for c in range(sheet.ncols):
                        cell = sheet.cell(r, c)
                        value = cell.value
                        if cell.ctype == xlrd.XL_CELL_DATE:
                            value = xlrd.xldate_as_datetime(value, book.datemode)
                        elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                            value = bool(value)
                        elif cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
                            value = None
                        elif cell.ctype == xlrd.XL_CELL_ERROR:
                            value = None
                            result["diagnostics"].append({"code": "cell_error", "sheetIndex": index, "row": r + 1, "column": c + 1})
                        cells.append(value)
                    yield r + 1, cells

            table(index, sheet.name, values())
        book.release_resources()
        result["extractor"] = {"id": "xlrd", "version": version("xlrd"), "mode": "python"}
    elif fmt == "xlsx":
        inspect_zip(data, spreadsheet=True)
        require("openpyxl")
        import openpyxl
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            # 保留公式类型，只读普通值；缓存不是原件已经核实的业务值。
            book = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=False, keep_links=False)
            if len(book.worksheets) > 32:
                raise DocumentError("material_document_limit")
            for index, sheet in enumerate(book.worksheets):
                if sheet.max_row and sheet.max_row > MAX_ROWS or sheet.max_column and sheet.max_column > MAX_COLUMNS:
                    raise DocumentError("material_document_limit")
                def values():
                    for r, row in enumerate(sheet.iter_rows(values_only=False), 1):
                        cells = []
                        for c, cell in enumerate(row, 1):
                            state = "formula_unverified" if cell.data_type == "f" else "cell_error" if cell.data_type == "e" else None
                            if state:
                                result["cellStates"].append({"sheetIndex": index, "row": r, "column": c, "state": state})
                                non_literal_cells.add((index, r, c))
                                result["status"] = "partial"
                            cells.append(None if state else cell.value)
                        yield r, cells
                table(index, sheet.title, values())
            book.close()
        result["extractor"] = {"id": "openpyxl", "version": version("openpyxl"), "mode": "python"}
        if result["cellStates"]:
            result["diagnostics"].append({"code": "unverified_cells", "count": len(result["cellStates"]), "meaning": "公式/错误值未采信；普通单元格仍可读取"})
    elif fmt == "pdf":
        require("fitz")
        import fitz
        document = fitz.open(stream=data, filetype="pdf")
        if document.needs_pass:
            raise DocumentError("material_document_encrypted")
        result["pageCount"] = document.page_count
        result["pageKind"] = "physical"
        end = min(offset + maximum, document.page_count)
        ocr_bytes = 0
        for index in range(offset, end):
            page = document[index]
            before = len(result["blocks"])
            for item in page.get_text("dict")["blocks"]:
                if item.get("type") != 0:
                    continue
                for line in item.get("lines", []):
                    block(index + 1, "".join(s.get("text", "") for s in line.get("spans", [])), line.get("bbox"))
            if len(result["blocks"]) == before:
                if request.get("ocr", True):
                    # 缩放只用于文字识别，页坐标通过缩放比还原。
                    scale = min(2, 3000 / max(page.rect.width, page.rect.height))
                    pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
                    png = pixmap.tobytes("png")
                    ocr_bytes += len(png)
                    if ocr_bytes > MAX_OCR_BYTES:
                        result["status"] = "partial"
                        result["diagnostics"].append({"code": "ocr_render_limit", "page": index + 1})
                        break
                    result["ocrPages"].append({"page": index + 1, "data": base64.b64encode(png).decode("ascii"), "scale": scale})
                else:
                    result["status"] = "partial"
                    result["diagnostics"].append({"code": "ocr_required", "page": index + 1})
        if end < document.page_count:
            result["status"] = "partial"
            result["nextPageOffset"] = end
            result["diagnostics"].append({"code": "page_limit", "nextPageOffset": end})
        document.close()
        result["extractor"] = {"id": "pymupdf", "version": version("PyMuPDF"), "mode": "python"}
    elif fmt == "docx":
        inspect_zip(data)
        require("docx")
        from docx import Document
        document = Document(io.BytesIO(data))
        result["pageKind"] = "logical"
        for paragraph in document.paragraphs:
            block(1, paragraph.text, kind="paragraph")
        for index, item in enumerate(document.tables):
            table(index, "table_" + str(index + 1), ((i, [c.text for c in r.cells]) for i, r in enumerate(item.rows, 1)))
        result["extractor"] = {"id": "python-docx", "version": version("python-docx"), "mode": "python"}
        result["diagnostics"].append({"code": "logical_page_locations", "meaning": "段落行号不是Word物理页码"})
    elif fmt in ("png", "jpg", "jpeg", "tif", "tiff", "bmp", "webp"):
        require("PIL")
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = 16_000_000
        with Image.open(io.BytesIO(data)) as image:
            result["pageCount"] = getattr(image, "n_frames", 1)
            result["pageKind"] = "physical"
            end = min(offset + maximum, result["pageCount"])
            ocr_bytes = 0
            for index in range(offset, end):
                image.seek(index)
                original_size = image.size
                frame = image.convert("RGB")
                frame.thumbnail((3000, 3000))
                output = io.BytesIO()
                frame.save(output, format="PNG")
                png = output.getvalue()
                ocr_bytes += len(png)
                if ocr_bytes > MAX_OCR_BYTES:
                    result["status"] = "partial"
                    result["diagnostics"].append({"code": "ocr_render_limit", "page": index + 1})
                    break
                result["ocrPages"].append({"page": index + 1, "data": base64.b64encode(png).decode("ascii"), "scale": frame.width / original_size[0]})
            if end < result["pageCount"]:
                result["status"] = "partial"
                result["nextPageOffset"] = end
                result["diagnostics"].append({"code": "page_limit", "nextPageOffset": end})
        result["extractor"] = {"id": "pillow", "version": version("Pillow"), "mode": "python"}
    else:
        raise DocumentError("material_document_format_unsupported")
    result["runtime"] = {"id": "python", "version": sys.version.split()[0], "executable": sys.executable}
    return result


parser_output = ParserOutput()
request = {}
try:
    request = json.loads(sys.stdin.buffer.read(8 * 1024 * 1024))
    # 普通解析器的诊断不进入协议输出；最后只在恢复的stdout写一份完整JSON。
    with contextlib.redirect_stdout(parser_output), contextlib.redirect_stderr(parser_output):
        response = main(request, parser_output)
except DocumentError as error:
    response = {"status": "needs_runtime" if "dependency_missing" in str(error) else "unsupported", "error": str(error)}
except Exception:
    # 不把解析库异常中的原文、文件路径或身份字段写入MCP/日志。
    response = {"status": "unsupported", "error": "material_document_parse_failed"}
if parser_output.has_output and response.get("status") in ("read", "partial", "available"):
    response.setdefault("diagnostics", []).append({
        "code": "xls_parser_warning" if request.get("format") == "xls" else "material_document_parser_warning",
        "severity": "warning",
    })
sys.stdout.write(json.dumps(response, ensure_ascii=False, allow_nan=False))
