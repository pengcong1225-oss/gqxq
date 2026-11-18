#!/usr/bin/env python
# -*- coding: utf-8 -*-
import collections, csv, json, os
OUT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../.dev-logs/import-2025-2026/masterdata"))
sel = list(csv.DictReader(open(os.path.join(OUT, "community-selected.csv"), encoding="utf-8-sig")))
rev = list(csv.DictReader(open(os.path.join(OUT, "community-review.csv"), encoding="utf-8-sig")))
summary = json.load(open(os.path.join(OUT, "community-build-summary.json"), encoding="utf-8"))
stats = {
  "selected": len(sel),
  "fallbackCountyGrid": sum(1 for s in sel if len(s["adminGridCode"]) == 6),
  "townshipGrid": sum(1 for s in sel if len(s["adminGridCode"]) == 9),
  "maxNameLen": max(len(s["name"]) for s in sel),
  "reviewRows": len(rev),
  "reviewByReason": collections.Counter(r["reason"] for r in rev).most_common(),
  "selectedPerDistrict": dict(collections.Counter(s["districtName"] for s in sel).most_common()),
  "summary": summary,
}
json.dump(stats, open(os.path.join(OUT, "community-stats.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("ok")
