#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""List distinct 主办单位 values that were NOT mapped to an enterprise (report/lead follow-up)."""
import csv, json, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../.."))
OUT = os.path.join(ROOT, ".dev-logs", "import-2025-2026", "masterdata")
profile = json.load(open(os.path.join(OUT, "source-profile.json"), encoding="utf-8"))
mapped = {r["sourceDepartmentName"] for r in
          csv.DictReader(open(os.path.join(OUT, "department_mapping-import.csv"), encoding="utf-8"))}
rows = []
for d in profile["departments"]:
    name = d["name"]
    if not name:
        continue
    if name in mapped:
        continue
    rows.append([name, d["count"], ";".join("%s:%d" % kv for kv in
                 sorted(d["districts"].items(), key=lambda kv: -kv[1]))])
rows.sort(key=lambda r: -r[1])
with open(os.path.join(OUT, "department-unmapped.csv"), "w", encoding="utf-8-sig", newline="") as f:
    w = csv.writer(f)
    w.writerow(["sourceDepartmentName", "count", "districtDistribution"])
    w.writerows(rows)
print("unmapped departments", len(rows))
