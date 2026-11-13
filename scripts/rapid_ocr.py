#!/usr/bin/env python3
import json
import os
import shutil
import sys
import time
from contextlib import closing

import numpy as np
import pypdfium2 as pdfium
import xlrd
from docx import Document
from openpyxl import load_workbook
from pdf_text import text_pages


def pdf_pages(path):
    with closing(pdfium.PdfDocument(path)) as document:
        for page in document:
            with closing(page), closing(page.render(scale=2)) as bitmap:
                pixels = np.array(bitmap.to_pil().convert("RGB"))
            yield pixels


def office_text(path):
    lower = path.lower()
    if lower.endswith(".docx"):
        document = Document(path)
        lines = [paragraph.text for paragraph in document.paragraphs if paragraph.text.strip()]
        for table in document.tables:
            lines.extend("\t".join(cell.text for cell in row.cells) for row in table.rows)
        return "\n".join(lines)
    if lower.endswith(".xlsx"):
        workbook = load_workbook(path, read_only=True, data_only=True)
        try:
            lines = []
            for sheet in workbook.worksheets:
                lines.append(f"工作表：{sheet.title}")
                for row in sheet.iter_rows(values_only=True):
                    values = ["" if value is None else str(value) for value in row]
                    if any(values):
                        lines.append("\t".join(values))
                    if sum(map(len, lines)) > 180000:
                        return "\n".join(lines)[:180000]
            return "\n".join(lines)
        finally:
            workbook.close()
    if lower.endswith(".xls"):
        workbook = xlrd.open_workbook(path, on_demand=True)
        lines = []
        for sheet in workbook.sheets():
            lines.append(f"工作表：{sheet.name}")
            for row_index in range(sheet.nrows):
                lines.append("\t".join(str(value) for value in sheet.row_values(row_index)))
                if sum(map(len, lines)) > 180000:
                    return "\n".join(lines)[:180000]
        return "\n".join(lines)
    if lower.endswith((".csv", ".txt", ".md")):
        for encoding in ("utf-8-sig", "gb18030"):
            try:
                with open(path, "r", encoding=encoding) as handle:
                    return handle.read(180000)
            except UnicodeDecodeError:
                continue
    return ""


def main():
    if len(sys.argv) == 2 and sys.argv[1] == "--setup":
        from rapidocr import RapidOCR
        RapidOCR()
        print("RapidOCR PP-OCRv6 ONNX models are ready")
        return
    if len(sys.argv) == 5 and sys.argv[1] == "--render-visual":
        _, _, manifest_path, output_dir, output_path = sys.argv
        os.makedirs(output_dir, exist_ok=True)
        with open(manifest_path, "r", encoding="utf-8") as handle:
            manifest = json.load(handle)
        images = []
        for file_index, item in enumerate(manifest.get("files", [])):
            source_path = item["path"]
            source_name = item["name"]
            lower = source_path.lower()
            if lower.endswith(".pdf"):
                with closing(pdfium.PdfDocument(source_path)) as document:
                    for page_index in range(min(len(document), 3, 12 - len(images))):
                        image_path = os.path.join(output_dir, f"{file_index + 1:02d}-{page_index + 1:02d}.png")
                        with closing(document[page_index]) as page, closing(page.render(scale=1.6)) as bitmap:
                            bitmap.to_pil().save(image_path)
                        images.append({"source": source_name, "page": page_index + 1, "path": image_path})
            elif lower.endswith((".png", ".jpg", ".jpeg", ".webp")) and len(images) < 12:
                extension = os.path.splitext(lower)[1]
                image_path = os.path.join(output_dir, f"{file_index + 1:02d}-01{extension}")
                shutil.copy2(source_path, image_path)
                images.append({"source": source_name, "page": 1, "path": image_path})
        with open(output_path, "w", encoding="utf-8") as handle:
            json.dump({"images": images}, handle, ensure_ascii=False)
        return
    if len(sys.argv) != 3:
        raise SystemExit("usage: rapid_ocr.py manifest.json output.json")
    manifest_path, output_path = sys.argv[1:]
    with open(manifest_path, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)

    started = time.perf_counter()
    engine = None
    init_seconds = 0
    files = []
    for item in manifest.get("files", []):
        file_started = time.perf_counter()
        pages = []
        try:
            lower = item["path"].lower()
            if lower.endswith((".docx", ".xlsx", ".xls", ".csv", ".txt", ".md")):
                pages.append(office_text(item["path"]))
            else:
                if lower.endswith(".pdf"):
                    extracted = text_pages(item["path"])
                    if extracted and all(text.strip() for text in extracted):
                        files.append({"name": item["name"], "pages": extracted, "seconds": round(time.perf_counter() - file_started, 3)})
                        continue
                if engine is None:
                    from rapidocr import RapidOCR
                    init_started = time.perf_counter()
                    engine = RapidOCR()
                    init_seconds = time.perf_counter() - init_started
                inputs = pdf_pages(item["path"]) if lower.endswith(".pdf") else [item["path"]]
                for page in inputs:
                    result = engine(page, use_cls=False, text_score=0.35)
                    pages.append("\n".join(result.txts or []))
            files.append({"name": item["name"], "pages": pages, "seconds": round(time.perf_counter() - file_started, 3)})
        except ImportError:
            raise
        except Exception as error:
            files.append({"name": item["name"], "pages": [], "seconds": round(time.perf_counter() - file_started, 3), "error": str(error)})

    payload = {
        "model": "PP-OCRv6-small-ONNX",
        "init_seconds": round(init_seconds, 3),
        "total_seconds": round(time.perf_counter() - started, 3),
        "files": files,
    }
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)


if __name__ == "__main__":
    main()
