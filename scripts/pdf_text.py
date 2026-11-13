from contextlib import closing
import sys

import pypdfium2 as pdfium


def text_pages(path):
    pages = []
    # Let Python open the file so Windows can resolve Unicode receipt paths.
    with open(path, "rb") as source, closing(pdfium.PdfDocument(source)) as document:
        for page in document:
            with closing(page), closing(page.get_textpage()) as text:
                pages.append(text.get_text_bounded().replace("\r\n", "\n"))
    return pages


if __name__ == "__main__":
    print("\n".join(text_pages(sys.argv[1])))
