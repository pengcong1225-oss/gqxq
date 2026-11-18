#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Build final community import set from candidates: quality floor, variant merge, code map.

Outputs under server/.dev-logs/import-2025-2026/masterdata/:
  community-selected.csv   canonical rows (name, code, district, adminGridCode, ...)
  community-code-map.csv   name -> code (for lead's geocode/jitter write-back)
  community-review.csv     excluded / uncertain candidates with reason
  community-build-summary.json
"""
import collections, csv, json, os, re

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../.."))
OUT = os.path.join(ROOT, ".dev-logs", "import-2025-2026", "masterdata")
SNAPSHOT = os.path.join(ROOT, "src", "data", "yichangTownships.snapshot.json")
SRC_CSV = os.path.join(OUT, "community-candidates.csv")

snap = json.load(open(SNAPSHOT, encoding="utf-8"))
COUNTIES = [(c["code"], c["name"], c["townships"]) for c in snap["counties"]]
FUNCTIONAL = [("420507", "高新区", [])]
DISTRICTS = COUNTIES + FUNCTIONAL
DISTRICT_NAME = {code: name for code, name, _ in DISTRICTS}

# suffix variants that only qualify a base name (safe to strip for merge).
# 社区(居委会) forms are excluded from import per Lead decision, but still merge to the
# same settlement so a 小区-form variant of the same place can be imported.
QUALIFIERS = ["小区", "社区"]
# residential suffix evidence (project/settlement, not a road/area)
RESIDENTIAL = ["小区", "花园", "家园", "公寓", "家属院", "新村", "花苑", "雅苑", "佳苑", "新苑", "苑", "社区",
               "广场", "大厦", "府"]
# name fragments that prove the span is an address/road/village-group, not a settlement name
FORBIDDEN_IN_NAME = ["号", "栋", "幢", "单元", "楼", "层", "室", "组", "队", "网格", "工业园", "开发区",
                     "街道", "街办", "办事处", "省", "县", "镇", "乡", "村", "小区内", "附近", "对面",
                     "旁边", "门口", "这里", "那边", "区域", "片区"]
DISTRICT_ALIASES = set()
for code, name, _ in DISTRICTS:
    DISTRICT_ALIASES.add(name)
    if name.endswith("土家族自治县"):
        DISTRICT_ALIASES.add(name.replace("土家族自治县", ""))
    if name.endswith("自治县"):
        DISTRICT_ALIASES.add(name.replace("自治县", ""))
    if name.endswith("县") or name.endswith("区") or name.endswith("市"):
        DISTRICT_ALIASES.add(name[:-1])
DISTRICT_ALIASES |= {"宜昌", "湖北", "宜昌市", "湖北省", "鄂"}

# generic / sentence-fragment names that cannot geocode a settlement
GENERIC_NAMES = {"老小区", "新小区", "现小区", "该小区", "本小区", "杂居小区", "安置小区", "健康小区",
                 "旧小区", "部分小区", "整个小区", "所有小区", "不少小区", "一些小区", "很多小区",
                 "多数小区", "大多数小区", "小区", "人才公寓", "商业广场", "城市广场", "国际广场",
                 "商城小区", "阳光小区", "幸福小区", "生活小区", "教师公寓", "公租房小区"}
BAD_NAME_FRAGMENTS = ["尽快", "严重", "属于", "作为", "直接", "保护", "保障", "专业", "手段", "协助",
                      "商户", "查询", "开始", "位于", "频繁", "两个", "多个", "部分", "所有", "整个",
                      "任何", "每个", "有些", "其他", "解决", "恢复", "处理", "维修", "影响", "问题",
                      "情况", "小区内", "时间", "目前", "现在", "已经", "导致", "造成", "物业", "居民",
                      "业主", "投诉", "反映", "要求", "建议", "希望", "停水", "停气", "施工", "改造"]

def normalize_name(name):
    """Strip a stray leading 市 glued from '宜都市…' style text (never a real settlement prefix)."""
    if len(name) >= 5 and name.startswith("市"):
        return name[1:]
    return name

def stem(name):
    s = name
    for q in QUALIFIERS:
        if s.endswith(q) and len(s) - len(q) >= 2:
            s = s[:-len(q)]
            break
    return s

def prefix_merge(a, b):
    """Merge same-place variants only. A short stem (e.g. 东山, 锦绣) must never act as a
    bridge, otherwise distinct compounds sharing a prefix chain into one group."""
    if a == b:
        return True
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    if len(short) < 4:
        return False
    return long_.startswith(short) and len(long_) - len(short) <= 2

class DSU:
    def __init__(self, n):
        self.p = list(range(n))
    def find(self, x):
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x
    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[rb] = ra

def classify(name, variants):
    """Return (importable, reason)."""
    if name.endswith("社区"):
        return False, "社区(居委会)类，不建小区"
    if name in GENERIC_NAMES:
        return False, "泛称名称，无地理指向"
    if len(name) == 3 and name.endswith("小区"):
        return False, "基名不足（仅1字+小区）"
    for frag in BAD_NAME_FRAGMENTS:
        if frag in name:
            return False, "含叙述性片段:" + frag
    probe = name
    for q in QUALIFIERS:
        if probe.endswith(q):
            probe = probe[:-len(q)]
            break
    # strip 小区 before checking stray 区 (小区 is legitimate)
    check = probe.replace("小区", "")
    if name[0] in DISTRICT_ALIASES or any(check.startswith(a) for a in DISTRICT_ALIASES if len(a) >= 2):
        return False, "以区县/城市名开头（道路或片区）"
    for f in FORBIDDEN_IN_NAME:
        if f in check:
            return False, "含地址/村组片段:" + f
    if "区" in check:
        return False, "含行政区划片段:区"
    if re.search(r"[0-9]{4,}", name):
        return False, "含长数字串"
    # bare area-type names (湾/里) only rejected when no residential suffix evidence exists in the group
    if name.endswith("湾") or name.endswith("里"):
        if not any(v.endswith(tuple(RESIDENTIAL)) for v in variants):
            return False, "疑似道路/片区名(湾/里)，无住宅后缀证据"
    if not any(name.endswith(s) for s in ["小区", "花园", "家园", "公寓", "家属院", "新村", "花苑", "雅苑",
                                          "佳苑", "新苑", "苑", "社区", "广场", "大厦", "府"]):
        return False, "无住宅/社区后缀"
    return True, ""

def main():
    rows = []
    with open(SRC_CSV, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            r["name"] = normalize_name(r["name"])
            r["count"] = int(r["count"]); r["addrCount"] = int(r["addrCount"])
            r["titleCount"] = int(r["titleCount"]); r["contentCount"] = int(r["contentCount"])
            rows.append(r)
    review = []
    kept = []
    for r in sorted(rows, key=lambda x: -x["count"]):
        if r["districtCode"] not in DISTRICT_NAME:
            review.append({**r, "reason": "区县未识别"}); continue
        if not (r["count"] >= 2 or r["addrCount"] >= 1):
            review.append({**r, "reason": "仅单次出现于内容且无地址证据"}); continue
        kept.append(r)
    # union-find per district
    by_district = collections.defaultdict(list)
    for r in kept:
        by_district[r["districtCode"]].append(r)
    selected = []
    seen_codes = set()
    seq_by_district = collections.Counter()
    for dcode in sorted(by_district):
        group_rows = by_district[dcode]
        n = len(group_rows)
        dsu = DSU(n)
        stems = [stem(r["name"]) for r in group_rows]
        for i in range(n):
            for j in range(i + 1, n):
                if prefix_merge(stems[i], stems[j]):
                    dsu.union(i, j)
        groups = collections.defaultdict(list)
        for i in range(n):
            groups[dsu.find(i)].append(group_rows[i])
        merged = []
        for members in groups.values():
            variants = [m["name"] for m in members]
            candidates = []
            reasons = set()
            for m in members:
                ok, why = classify(m["name"], variants)
                if ok:
                    candidates.append(m)
                else:
                    reasons.add(why)
            if not candidates:
                for m in members:
                    review.append({**m, "reason": "; ".join(sorted(reasons))})
                continue
            # canonical: highest count; tie -> prefer base form (name == stem), then longest
            def score(m):
                return (m["count"], 1 if m["name"] == stem(m["name"]) else 0, len(m["name"]))
            best = sorted(candidates, key=score, reverse=True)[0]
            total = sum(m["count"] for m in members)
            addr = sum(m["addrCount"] for m in members)
            towns = collections.Counter()
            for m in members:
                if m.get("townshipCode"):
                    towns[m["townshipCode"]] += m["count"]
            tcode = towns.most_common(1)[0][0] if towns else dcode
            merged.append({"name": best["name"], "districtCode": dcode,
                           "districtName": DISTRICT_NAME[dcode], "count": total, "addrCount": addr,
                           "variants": variants, "townshipCode": tcode})
        merged.sort(key=lambda x: (-x["count"], x["name"]))
        for m in merged:
            seq_by_district[dcode] += 1
            m["code"] = "C-%s-%04d" % (dcode, seq_by_district[dcode])
            m["adminGridCode"] = m["townshipCode"] if m["townshipCode"].startswith(dcode) and len(m["townshipCode"]) == 9 else dcode
            selected.append(m)
    selected.sort(key=lambda x: (x["districtCode"], x["code"]))
    # write selected
    with open(os.path.join(OUT, "community-selected.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["name", "code", "districtCode", "districtName", "adminGridCode", "count", "addrCount", "variants"])
        for m in selected:
            w.writerow([m["name"], m["code"], m["districtCode"], m["districtName"], m["adminGridCode"],
                        m["count"], m["addrCount"], "|".join(sorted(set(m["variants"])))])
    with open(os.path.join(OUT, "community-code-map.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["name", "code", "districtCode", "adminGridCode"])
        for m in selected:
            w.writerow([m["name"], m["code"], m["districtCode"], m["adminGridCode"]])
    with open(os.path.join(OUT, "community-review.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["name", "districtCode", "districtName", "townshipCode", "count",
                                          "addrCount", "titleCount", "contentCount", "reason", "evidence"])
        w.writeheader()
        for r in sorted(review, key=lambda x: -x["count"]):
            w.writerow({k: r.get(k, "") for k in w.fieldnames})
    community_candidates = sum(1 for r in rows if r["name"].endswith("社区"))
    summary = {"candidateRows": len(rows), "keptBeforeMerge": len(kept), "selected": len(selected),
               "review": len(review),
               "communityTypeCandidates(社区尾缀)": community_candidates,
               "excludedCommunityTypeRows": sum(1 for r in review if "社区(居委会)类" in r["reason"]),
               "reviewReasons": collections.Counter(r["reason"] for r in review).most_common(),
               "perDistrict": {DISTRICT_NAME[k]: v for k, v in
                               collections.Counter(m["districtCode"] for m in selected).most_common()},
               "variantsMerged": sum(len(set(m["variants"])) - 1 for m in selected)}
    json.dump(summary, open(os.path.join(OUT, "community-build-summary.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print("selected", len(selected), "review", len(review))

if __name__ == "__main__":
    main()