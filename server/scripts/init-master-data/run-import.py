#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Run one master-data import: python run-import.py <kind> <csv> <requestId> [--preview-only]"""
import json, sys
import client

kind, path, request_id = sys.argv[1], sys.argv[2], sys.argv[3]
allow = "--preview-only" not in sys.argv
rec = client.run_import(kind, path, request_id, allow_commit=allow)
client.save_result(rec)
text = json.dumps(rec, ensure_ascii=False, indent=2)[:6000]
sys.stdout.buffer.write(text.encode("utf-8"))
