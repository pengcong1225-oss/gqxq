#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Build category / enterprise / department_mapping / service_grid / grid_coverage import CSVs.

All names come from the two source exports (see source-profile.json). Anything uncertain is
marked in 00-report.md; nothing here invents a legal entity name.
"""
import csv, json, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../.."))
OUT = os.path.join(ROOT, ".dev-logs", "import-2025-2026", "masterdata")
profile = json.load(open(os.path.join(OUT, "source-profile.json"), encoding="utf-8"))

def w(name, header, rows):
    path = os.path.join(OUT, name)
    with open(path, "w", encoding="utf-8", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(header)
        wr.writerows(rows)
    return path

# ---------------- complaint_category: two levels only (platform dict limit) ----------------
# major = 中类 (供气服务/供水服务), minor = 小类. 住 is the shared top umbrella and cannot be a
# third level; it is retained as the report's grouping label only.
cats = profile["categories"]
gas = [c for c in cats if c["mid"] == "供气服务"]
water = [c for c in cats if c["mid"] == "供水服务"]
gas.sort(key=lambda c: (-c["count"], c["leaf"]))
water.sort(key=lambda c: (-c["count"], c["leaf"]))
rows = [["b4-v1", "gas_service", "供气服务", "", "10", "enabled", "true", "false"],
        ["b4-v1", "water_service", "供水服务", "", "20", "enabled", "true", "false"]]
for i, c in enumerate(gas, 1):
    rows.append(["b4-v1", "g%02d" % i, c["leaf"], "gas_service", str(i), "enabled", "true", "false"])
for i, c in enumerate(water, 1):
    rows.append(["b4-v1", "w%02d" % i, c["leaf"], "water_service", str(i), "enabled", "true", "false"])
w("category-import.csv", ["templateVersion", "code", "label", "parentCode", "sort", "status", "published", "cascadeDisable"], rows)
print("category rows", len(rows))

# ---------------- enterprise ----------------
# code, name, businessType, primary district, note
enterprises = [
    ["ENT-GAS-002", "宜昌中燃智慧能源有限公司", "gas", "420502", ""],
    ["ENT-GAS-003", "夷陵中燃公司", "gas", "420506", "来源简称，待工商核实"],
    ["ENT-GAS-004", "长阳县燃气公司", "gas", "420528", "来源简称，待工商核实"],
    ["ENT-GAS-005", "兴山县新捷天然气有限公司", "gas", "420526", ""],
    ["ENT-WATER-003", "宜昌浦华三峡水务", "water", "420502", "来源简称，待工商核实；完整工商名待补"],
    ["ENT-WATER-004", "宜昌城发集团", "water", "420502", "供水口径待证"],
    ["ENT-WATER-005", "长阳县清江水务集团", "water", "420528", "来源简称，待工商核实"],
    ["ENT-WATER-006", "兴山县自来水有限责任公司", "water", "420526", ""],
]
ent_header = ["templateVersion", "enterpriseCode", "enterpriseName", "businessType", "status", "districtCode", "uscc",
              "legalPerson", "contactPerson", "contactPhone", "serviceArea", "address", "disableReason",
              "displayOnScreen", "screenName"]
ent_rows = [["b4-v1", c, n, b, "enabled", d, "", "", "", "", "", "", "", "", ""] for c, n, b, d, _ in enterprises]
w("enterprise-import.csv", ent_header, ent_rows)
print("enterprise rows", len(ent_rows))
json.dump([{"code": c, "name": n, "businessType": b, "districtCode": d, "note": note}
           for c, n, b, d, note in enterprises],
          open(os.path.join(OUT, "enterprise-import-meta.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)

# ---------------- department_mapping ----------------
dept_profile = {d["name"]: d for d in profile["departments"]}
mappings = [
    ("中燃宜昌公司", "ENT-GAS-001", ["中燃宜昌公司", "中燃公司"]),
    ("宜昌中燃智慧能源有限公司", "ENT-GAS-002", ["宜昌中燃智慧能源有限公司"]),
    ("夷陵中燃公司", "ENT-GAS-003", ["夷陵中燃公司"]),
    ("长阳县燃气公司", "ENT-GAS-004", ["长阳县燃气公司"]),
    ("兴山县新捷天然气有限公司", "ENT-GAS-005", ["兴山县新捷天然气有限公司"]),
    ("浦华三峡水务", "ENT-WATER-003", ["浦华三峡水务", "宜昌浦华三峡水务"]),
    ("宜昌城发集团", "ENT-WATER-004", ["宜昌城发集团"]),
    ("长阳县清江水务集团", "ENT-WATER-005", ["长阳县清江水务集团", "长阳清江水务集团"]),
    ("兴山县自来水有限责任公司", "ENT-WATER-006", ["兴山县自来水有限责任公司"]),
]
dm_rows = []
for i, (src_name, ent, aliases) in enumerate(mappings, 1):
    dm_rows.append(["b4-v1", "YJJB", "YJJB-%03d" % i, src_name, ent, "enterprise",
                    json.dumps(aliases, ensure_ascii=False), "false"])
w("department_mapping-import.csv",
  ["templateVersion", "sourceSystem", "sourceDepartmentCode", "sourceDepartmentName", "enterpriseCode",
   "entityType", "aliases", "verified"], dm_rows)
print("department_mapping rows", len(dm_rows))

# ---------------- service_grid + grid_coverage ----------------
# Districts each enterprise actually received complaints in (from source 主办单位 field).
def districts_of(src_name):
    d = dept_profile.get(src_name)
    if not d:
        return []
    return [k for k, v in sorted(d["districts"].items(), key=lambda kv: -kv[1]) if k]

grid_defs = [
    ("GRID-ENT-GAS-001", "宜昌中燃城市燃气有限公司", "gas", "ENT-GAS-001", "中燃宜昌公司", "燃气"),
    ("GRID-ENT-GAS-002", "宜昌中燃智慧能源有限公司", "gas", "ENT-GAS-002", "宜昌中燃智慧能源有限公司", "燃气"),
    ("GRID-ENT-GAS-003", "夷陵中燃公司", "gas", "ENT-GAS-003", "夷陵中燃公司", "燃气"),
    ("GRID-ENT-GAS-004", "长阳县燃气公司", "gas", "ENT-GAS-004", "长阳县燃气公司", "燃气"),
    ("GRID-ENT-GAS-005", "兴山县新捷天然气有限公司", "gas", "ENT-GAS-005", "兴山县新捷天然气有限公司", "燃气"),
    ("GRID-ENT-WATER-003", "宜昌浦华三峡水务", "water", "ENT-WATER-003", "浦华三峡水务", "供水"),
    ("GRID-ENT-WATER-004", "宜昌城发集团", "water", "ENT-WATER-004", "宜昌城发集团", "供水"),
    ("GRID-ENT-WATER-005", "长阳县清江水务集团", "water", "ENT-WATER-005", "长阳县清江水务集团", "供水"),
    ("GRID-ENT-WATER-006", "兴山县自来水有限责任公司", "water", "ENT-WATER-006", "兴山县自来水有限责任公司", "供水"),
]
DISTRICT_CODE = {}
for code_name in [("西陵区", "420502"), ("伍家岗区", "420503"), ("点军区", "420504"), ("猇亭区", "420505"),
                  ("夷陵区", "420506"), ("远安县", "420525"), ("兴山县", "420526"), ("秭归县", "420527"),
                  ("长阳土家族自治县", "420528"), ("五峰土家族自治县", "420529"), ("宜都市", "420581"),
                  ("当阳市", "420582"), ("枝江市", "420583"), ("高新区", "420507")]:
    DISTRICT_CODE[code_name[0]] = code_name[1]

sg_rows = []
cov_rows = []
cov_meta = []
for gcode, gname, btype, ent, src_name, label in grid_defs:
    sg_rows.append(["b4-v1", gcode, gname + label + "服务网格", ent, btype, "", ""])
    dists = districts_of(src_name)
    for dname in dists:
        dcode = DISTRICT_CODE.get(dname)
        if not dcode:
            continue
        cov_rows.append(["b4-v1", gcode, "2026-01-01", "", "admin_grid", dcode])
        cov_meta.append({"gridCode": gcode, "relationKind": "admin_grid", "relationCode": dcode, "districtName": dname})
w("service_grid-import.csv",
  ["templateVersion", "code", "name", "enterpriseCode", "businessType", "managerName", "managerPhone"], sg_rows)
w("grid_coverage-import.csv",
  ["templateVersion", "code", "validFrom", "validTo", "relationKind", "relationCode"], cov_rows)
print("service_grid rows", len(sg_rows), "grid_coverage rows", len(cov_rows))
json.dump(cov_meta, open(os.path.join(OUT, "grid_coverage-import-meta.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=2)