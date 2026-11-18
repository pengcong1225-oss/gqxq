#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Build admin_grid / community import CSV from snapshots and the final community list."""
import csv, json, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../.."))
OUT = os.path.join(ROOT, ".dev-logs", "import-2025-2026", "masterdata")
SNAPSHOT = os.path.join(ROOT, "src", "data", "yichangTownships.snapshot.json")
os.makedirs(OUT, exist_ok=True)

snap = json.load(open(SNAPSHOT, encoding="utf-8"))
rows = []
meta = []
for c in snap["counties"]:
    rows.append(["b4-v1", c["code"], c["name"], c["code"]])
    meta.append({"code": c["code"], "name": c["name"], "districtCode": c["code"], "level": "county-fallback"})
    for t in c["townships"]:
        rows.append(["b4-v1", t["code"], t["name"], c["code"]])
        meta.append({"code": t["code"], "name": t["name"], "districtCode": c["code"], "level": t.get("type", "township")})
# functional area 420507 高新区: county-level fallback only (no official township list in snapshot)
rows.append(["b4-v1", "420507", "高新区", "420507"])
meta.append({"code": "420507", "name": "高新区", "districtCode": "420507", "level": "county-fallback"})

path = os.path.join(OUT, "admin_grid-import.csv")
with open(path, "w", encoding="utf-8", newline="") as f:
    w = csv.writer(f)
    w.writerow(["templateVersion", "code", "name", "districtCode"])
    w.writerows(rows)
json.dump(meta, open(os.path.join(OUT, "admin_grid-import-meta.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("admin_grid rows", len(rows))

# community template: code,name,adminGridCode
sel = list(csv.DictReader(open(os.path.join(OUT, "community-selected.csv"), encoding="utf-8-sig")))
grids = {r[1] for r in rows}
missing = sorted({s["adminGridCode"] for s in sel if s["adminGridCode"] not in grids})
if missing:
    raise SystemExit("adminGridCode not in admin grid import: %r" % missing[:10])
with open(os.path.join(OUT, "community-import.csv"), "w", encoding="utf-8", newline="") as f:
    w = csv.writer(f)
    w.writerow(["templateVersion", "code", "name", "adminGridCode"])
    for s in sel:
        w.writerow(["b4-v1", s["code"], s["name"], s["adminGridCode"]])
print("community rows", len(sel))
