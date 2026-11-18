#!/usr/bin/env python
# -*- coding: utf-8 -*-
import json, os
OUT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../.dev-logs/import-2025-2026/masterdata"))
p = json.load(open(os.path.join(OUT, "source-profile.json"), encoding="utf-8"))
lines = []
for d in p["departments"]:
    top = sorted(d["districts"].items(), key=lambda kv: -kv[1])[:3]
    lines.append("%d\t%s\t%s" % (d["count"], d["name"] or "<空>", ", ".join("%s:%d" % kv for kv in top)))
open(os.path.join(OUT, "distinct-departments.txt"), "w", encoding="utf-8").write("\n".join(lines))
print("wrote", len(lines))
