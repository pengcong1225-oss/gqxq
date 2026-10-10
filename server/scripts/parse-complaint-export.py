#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Bounded stdin BIFF XLS -> UTF-8 JSON table; never logs workbook contents.

Production dependency: Python 3.9+ and xlrd==2.0.2.
Install: python -m pip install -r scripts/requirements-complaint-import.txt
Set COMPLAINT_IMPORT_PYTHON to the Python executable if it is not on PATH.
The Node caller supplies its 15-second wall timeout and 30-MiB output cap.
"""
import io
import json
import math
import struct
import sys

MAX_BYTES = 10 * 1024 * 1024
MAX_ROWS = 2005  # Up to five title/header rows and 2000 data rows.
MAX_COLS = 64
MAX_CELLS = MAX_ROWS * MAX_COLS
MAX_TEXT_BYTES = 65535
MAX_OUTPUT = 30 * 1024 * 1024


def preflight(data, xlrd):
    """xlrd exposes formula cached values, so inspect BIFF records first."""
    if data.startswith(b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'):
        from xlrd.compdoc import CompDoc
        doc = CompDoc(data, logfile=io.StringIO())
        for node in doc.dirlist:
            if node.tot_size < 0 or node.tot_size > MAX_BYTES:
                raise ValueError('stream limit')
            if node.name and any(name in node.name.upper() for name in ('VBA', 'MACRO', '_VBA_PROJECT', 'OBJECTPOOL')):
                raise ValueError('macro or embedded object')
        stream = doc.get_named_stream('Workbook')
        if stream is None:
            stream = doc.get_named_stream('Book')
        if stream is None:
            raise ValueError('missing workbook')
    else:
        stream = data
    offset = 0
    cells = 0
    sheets = 0
    records = 0
    first = True
    # BIFF cell records used by ordinary exports; reject formulas even if cached.
    cell_records = {0x0201, 0x0203, 0x0204, 0x0205, 0x027E, 0x00FD, 0x00D6}
    forbidden = {0x0006, 0x0206, 0x0406, 0x04BC, 0x0221, 0x0236, 0x002F,
                 0x00D3, 0x0023, 0x01B8, 0x0059, 0x0018}
    while offset + 4 <= len(stream):
        opcode, length = struct.unpack_from('<HH', stream, offset)
        offset += 4
        if offset + length > len(stream):
            raise ValueError('truncated record')
        body = stream[offset:offset + length]
        offset += length
        records += 1
        if records > 300000:
            raise ValueError('record limit')
        if first:
            first = False
            if opcode != 0x0809 or length < 4 or struct.unpack_from('<H', body)[0] != 0x0600:
                raise ValueError('BIFF8 required')
        if opcode in forbidden:
            raise ValueError('formula, external content or macro')
        if opcode == 0x01AE:  # SUPBOOK: 0x0401 means this workbook, not an external reference.
            if length != 4 or struct.unpack_from('<H', body, 2)[0] != 0x0401:
                raise ValueError('external workbook')
        if opcode == 0x0085:  # BOUNDSHEET
            sheets += 1
            if sheets > 1 or length < 8 or body[5] != 0:
                raise ValueError('single ordinary worksheet required')
        if opcode == 0x0809 and length >= 4 and struct.unpack_from('<H', body, 2)[0] not in (0x0005, 0x0010):
            raise ValueError('macro or non-worksheet stream')
        if opcode == 0x0200:
            if length < 14:
                raise ValueError('invalid dimensions')
            if struct.unpack_from('<I', body, 4)[0] > MAX_ROWS or struct.unpack_from('<H', body, 10)[0] > MAX_COLS:
                raise ValueError('dimension limit')
        if opcode in cell_records or opcode in (0x00BD, 0x00BE):
            if length < 6:
                raise ValueError('invalid cell')
            row, col = struct.unpack_from('<HH', body)
            last_col = struct.unpack_from('<H', body, length - 2)[0] if opcode in (0x00BD, 0x00BE) else col
            if row >= MAX_ROWS or last_col >= MAX_COLS or last_col < col:
                raise ValueError('cell coordinate limit')
            cells += last_col - col + 1
            if cells > MAX_CELLS:
                raise ValueError('cell limit')
    if first or sheets != 1:
        raise ValueError('invalid workbook')


def main():
    try:
        import xlrd
        if xlrd.__version__ != '2.0.2':
            raise ValueError('xlrd 2.0.2 required')
        data = sys.stdin.buffer.read(MAX_BYTES + 1)
        if not data or len(data) > MAX_BYTES:
            raise ValueError('input size')
        preflight(data, xlrd)
        book = xlrd.open_workbook(file_contents=data, logfile=io.StringIO(), on_demand=True)
        try:
            if book.nsheets != 1:
                raise ValueError('single worksheet required')
            sheet = book.sheet_by_index(0)
            if sheet.nrows > MAX_ROWS or sheet.ncols > MAX_COLS or sheet.nrows * sheet.ncols > MAX_CELLS:
                raise ValueError('sheet limit')
            table = []
            expanded_bytes = 0
            for r in range(sheet.nrows):
                row = []
                for c in range(sheet.ncols):
                    cell = sheet.cell(r, c)
                    if cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
                        value = ''
                    elif cell.ctype == xlrd.XL_CELL_DATE:
                        value = xlrd.xldate_as_datetime(cell.value, book.datemode).strftime('%Y-%m-%d %H:%M:%S')
                    elif cell.ctype == xlrd.XL_CELL_NUMBER:
                        if not math.isfinite(cell.value):
                            raise ValueError('nonfinite number')
                        value = str(int(cell.value)) if cell.value == int(cell.value) else str(cell.value)
                    elif cell.ctype == xlrd.XL_CELL_TEXT:
                        value = cell.value
                    else:
                        raise ValueError('unsupported cell type')
                    if len(value.encode('utf-8')) > MAX_TEXT_BYTES:
                        raise ValueError('cell text limit')
                    expanded_bytes += len(value.encode('utf-8'))
                    if expanded_bytes > MAX_BYTES:
                        raise ValueError('expanded text limit')
                    row.append(value)
                table.append(row)
            output_bytes = 0
            for part in json.JSONEncoder(ensure_ascii=False, separators=(',', ':'), allow_nan=False).iterencode(table):
                chunk = part.encode('utf-8')
                output_bytes += len(chunk)
                if output_bytes > MAX_OUTPUT:
                    raise ValueError('output limit')
                sys.stdout.buffer.write(chunk)
        finally:
            book.release_resources()
        return 0
    except Exception:
        # Errors must never echo file paths, source cells or third-party diagnostics.
        sys.stderr.write('XLS rejected or parser runtime unavailable\n')
        return 2


if __name__ == '__main__':
    sys.exit(main())
