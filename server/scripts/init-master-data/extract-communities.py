#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Extract community/settlement name candidates from the two complaint xlsx exports.

Outputs (under server/.dev-logs/import-2025-2026/masterdata/):
  community-candidates.csv  name,districtCode,districtName,count,addrCount,titleCount,contentCount,evidence
  community-extract-summary.json

Rules follow task-2: suffix whitelist, length 3-24, banned substrings, per (name,district)
dedupe, requires >=2 occurrences or address evidence, parent admin grid matched by township
aliases (fallback: county-level grid). No PII is written (only 事发地 snippets, truncated).
"""
import collections, csv, json, os, re, sys
import openpyxl

SRC = [r"D:\知识库仓库\doctorWho\项目文档\住新服务平台\燃水燃气\诉求数据\2025年0101-1231水气全量诉求(含自办自结).xlsx",
       r"D:\知识库仓库\doctorWho\项目文档\住新服务平台\燃水燃气\诉求数据\2026年0101-1112水气全量诉求(含自办自结).xlsx"]
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../.."))
OUT = os.path.join(ROOT, ".dev-logs", "import-2025-2026", "masterdata")
SNAPSHOT = os.path.join(ROOT, "src", "data", "yichangTownships.snapshot.json")
os.makedirs(OUT, exist_ok=True)

snap = json.load(open(SNAPSHOT, encoding="utf-8"))
COUNTIES = [(c["code"], c["name"], c["townships"]) for c in snap["counties"]]
FUNCTIONAL = [("420507", "高新区", [])]
DISTRICTS = COUNTIES + FUNCTIONAL
DISTRICT_NAME = {code: name for code, name, _ in DISTRICTS}

def aliases_for(name):
    out = {name}
    if name.endswith("土家族自治县"):
        out.add(name.replace("土家族自治县", ""))
    if name.endswith("自治县"):
        out.add(name.replace("自治县", ""))
    if name.endswith("县") or name.endswith("区") or name.endswith("市"):
        out.add(name[:-1])
    return out
DISTRICT_ALIASES = {code: aliases_for(name) for code, name in DISTRICT_NAME.items()}

SUFFIXES = ["家属院", "小区", "花园", "家园", "公寓", "新村", "花苑", "雅苑", "佳苑", "新苑",
            "苑", "社区", "广场", "大厦", "府", "湾", "里", "院"]
SUFFIX_RE = re.compile("|".join(sorted(SUFFIXES, key=len, reverse=True)))
BANNED = ["投诉", "反映", "电话", "联系", "希望", "处理", "问题", "居民", "业主", "物业", "公司",
          "政府", "部门", "工作", "家里", "我们", "整个", "老旧", "最近", "建议", "咨询", "求助",
          "举报", "表扬", "回复", "结果", "情况", "要求", "人员", "服务", "管理", "负责", "小区业",
          "现在", "已经", "因为", "由于", "所以", "但是", "而且", "并且", "然后", "后来", "之前", "以后",
          "当天", "当时", "今天", "昨天", "明天", "早上", "晚上", "中午", "下午", "上午", "目前", "近期",
          "导致", "造成", "出现", "发生", "存在", "看到", "听到", "知道", "认为", "觉得", "告诉",
          "输入", "点击", "搜索", "拨打", "收到", "告知", "前往", "来到", "发现", "检查", "维修"]
# Hard boundary words. Road/street syllables (路/道/街/巷) are deliberately NOT hard stops:
# they legitimately occur inside names (e.g. 解放路社区, 紫阳街社区); a post-trim rule handles
# candidates that swallowed a road prefix.
BOUNDARY_WORDS = ["省", "区", "县", "镇", "乡", "街道", "街办", "办事处", "管理区",
                  "的", "了", "是", "在", "从", "向", "给", "对", "把", "被", "让", "使", "着", "过",
                  "就", "都", "也", "还", "很", "太", "又", "再", "且", "域", "贵", "该", "各", "每",
                  "此", "这", "那", "口", "侧", "约", "米", "旁", "约", "内", "外", "前", "后",
                  "周边", "附近", "对面", "旁边", "门口", "路口", "交叉口", "公交站", "学校", "医院",
                  "菜场", "菜市场", "超市", "停车场", "营业厅", "委员会", "居委会", "社区居",
                  "侧约", "东南侧", "西南侧", "东北侧", "西北侧", "东侧", "南侧", "西侧", "北侧",
                  "号", "栋", "幢", "单元", "楼", "层", "室", "组", "队", "村", "社区居", "网格", "片", "园区",
                  "工业园", "开发区", "新区", "校区", "院区", "厂区", "景区", "地块", "项目", "附近", "周边",
                  "旁边", "对面", "门口", "这里", "那边", "附件", "范围", "小区内"]
SOFT_MARKS = "路道街巷市"
CJK = re.compile(r"^[\u4e00-\u9fa5A-Za-z0-9]$")
# Leading fragments that mean the captured span started too early.
BAD_START = set("我你们你他她它是的了和与及对向给从到于被把让使该本此这那个些有无不没很太再又还就都也才刚将已并而但因由所如若为以至当其之者得说称讲问去来回")
BAD_START |= set("不很太再又还就都也才刚将已并而但因由所如若为以")  # duplicated safety, keep function words only
# Two-char function-word starts that should never begin a community name.
BAD_START2 = ["我们", "你们", "他们", "她们", "这里", "那里", "这边", "那边", "现在", "目前", "近期", "最近",
              "已经", "因为", "由于", "所以", "但是", "而且", "并且", "然后", "后来", "之前", "以后", "当天",
              "当时", "今天", "昨天", "明天", "早上", "晚上", "中午", "下午", "上午", "导致", "造成", "出现",
              "发生", "存在", "看到", "听到", "觉得", "认为", "告诉", "反映", "投诉", "建议", "咨询", "求助",
              "举报", "表扬", "希望", "要求", "输入", "点击", "搜索", "拨打", "收到", "告知", "前往", "来到",
              "发现", "检查", "维修", "整个", "老旧", "居民", "业主", "物业", "公司", "政府", "部门", "工作",
              "市民", "群众", "来电", "先生", "女士", "服务", "管理", "负责", "请问", "想问", "了解", "查询"]

def clean_leading(name):
    prefixes = ["我是", "我家住", "家住", "住在", "位于", "反映", "投诉", "关于", "对于", "由于", "因为", "原因是",
                "自从", "进入", "确保", "影响", "恢复", "改造", "进行", "遮挡", "门店", "水费", "您所在", "所在",
                "前期", "后期", "之前", "以后", "之后", "同时", "如果", "要是", "一旦", "为了", "以免", "虽然",
                "尽管", "即使", "而且", "并且", "但是", "所以", "因此", "目前", "现在", "还是", "就是", "都是",
                "也是", "不是", "无法", "没有", "可以", "需要", "应该", "必须", "已经", "正在", "曾经", "临时",
                "近期", "最近", "今天", "昨天", "明天", "早上", "晚上", "中午", "下午", "上午", "其中", "另外",
                "此外", "然后", "后来", "接着", "于是", "从而", "以便", "防止", "避免", "解决", "协调", "督促",
                "要求", "希望", "建议", "咨询", "求助", "举报", "表扬", "针对", "在", "是", "和", "与", "及",
                "从", "到", "向", "给", "称", "表示", "其", "该", "本", "我", "市民", "先生", "女士", "业主",
                "居民", "群众", "来电人", "服务对象", "查询", "了解", "告知", "通知", "联系", "地址", "位置"]
    changed = True
    while changed:
        changed = False
        for p in prefixes:
            if name.startswith(p) and len(name) - len(p) >= 3:
                name = name[len(p):]
                changed = True
    return name

def trim_road_prefix(name):
    """Drop a swallowed road/official prefix when a plausible name remains after the last road syllable."""
    for i in range(len(name) - 4, 1, -1):
        if name[i] in SOFT_MARKS and name[:i].strip():
            tail = name[i + 1:]
            if len(tail) >= 3 and any(tail.endswith(s) for s in SUFFIXES) and acceptable(tail):
                return tail
    return name

SENTENCE_STARTS = ["关于", "针对", "对于", "由于", "因为", "原因", "自从", "进入", "确保", "影响", "恢复",
                   "改造", "进行", "遮挡", "门店", "水费", "所在", "前期", "后期", "之后", "以后", "以前",
                   "之前", "同时", "如果", "要是", "一旦", "为了", "以免", "而且", "并且", "但是", "所以",
                   "因此", "目前", "现在", "还是", "就是", "都是", "也是", "不是", "无法", "没有", "可以",
                   "需要", "应该", "必须", "已经", "正在", "曾经", "临时", "近期", "最近", "今天", "昨天",
                   "明天", "其中", "另外", "此外", "然后", "后来", "接着", "于是", "从而", "以便", "防止",
                   "避免", "解决", "协调", "督促", "要求", "希望", "建议", "咨询", "求助", "举报", "表扬",
                   "小区内", "整个", "用户", "中燃", "供水", "燃气"]

def acceptable(name):
    if not (3 <= len(name) <= 24):
        return False
    if not any(name.endswith(s) for s in SUFFIXES):
        return False
    for b in BANNED:
        if b in name:
            return False
    for b in BAD_START2 + SENTENCE_STARTS:
        if name.startswith(b):
            return False
    if name[0] in BAD_START:
        return False
    if name[0] in "且的了是在从向给对把被让使着过就都也还又再约侧口域贵该每此这那":
        return False
    if re.search(r"[0-9]{5,}", name):
        return False
    return True

def candidates_in(text):
    """Yield (name, start, end) for each suffix occurrence, growing left to a boundary."""
    res = []
    if not text:
        return res
    for m in SUFFIX_RE.finditer(text):
        end = m.end()
        start = m.start()
        lo = start
        limit = max(0, end - 24)
        while lo > limit:
            before = text[:lo]
            if any(before.endswith(w) for w in BOUNDARY_WORDS):
                break
            ch = text[lo - 1]
            if not CJK.match(ch):
                break
            if ch.isdigit():
                # allow numeric prefixes like "710小区", refuse digits glued after characters
                if not all(c.isdigit() or c.isascii() and c.isalpha() for c in text[lo:end]):
                    break
            lo -= 1
        name = text[lo:end]
        if acceptable(name):
            name = trim_road_prefix(name)
            if acceptable(name):
                res.append((name, lo, end))
    return res

def detect_district(rec):
    raw = rec.get("行政区划名称", "").strip()
    for code, name in DISTRICT_NAME.items():
        if name == raw:
            return code
    for code, al in DISTRICT_ALIASES.items():
        for a in sorted(al, key=len, reverse=True):
            if a and a in raw:
                return code
    addr = rec.get("事发地", "")
    for code, al in DISTRICT_ALIASES.items():
        for a in sorted(al, key=len, reverse=True):
            if a and a in addr:
                return code
    return None

def township_tables():
    tables = {}
    for code, name, townships in DISTRICTS:
        rows = []
        for t in townships:
            tn, tc = t["name"], t["code"]
            variants = {tn}
            base = re.sub(r"(街道|镇|乡)$", "", tn)
            if tn.endswith("街道"):
                variants.update({base + "街办", base + "办事处", base + "管理区", base + "街道办"})
            rows.append((variants, tc, tn))
        tables[code] = rows
    return tables
TOWNS = township_tables()

def match_township(rec, district_code):
    if not district_code:
        return None, None
    for text, weight in ((rec.get("事发地", ""), 3), (rec.get("诉求标题", ""), 2), (rec.get("诉求内容", ""), 1)):
        if not text:
            continue
        best = None
        for variants, tc, tn in TOWNS.get(district_code, []):
            for v in variants:
                idx = text.find(v)
                if idx >= 0:
                    score = (weight, len(v), -idx)
                    if best is None or score > best[0]:
                        best = (score, tc, tn)
        if best:
            return best[1], best[2]
    return None, None

def main():
    agg = collections.defaultdict(lambda: {"count": 0, "addr": 0, "title": 0, "content": 0, "evidence": "",
                                            "townVotes": collections.Counter()})
    total = 0
    district_seen = collections.Counter()
    district_resolved = collections.Counter()
    for p in SRC:
        wb = openpyxl.load_workbook(p, data_only=True)
        ws = wb.worksheets[0]
        it = ws.iter_rows(min_row=3, values_only=True)
        header = [str(c).strip() if c is not None else "" for c in next(it)]
        idx = {h: i for i, h in enumerate(header)}
        for row in it:
            if row is None or all(v is None or str(v).strip() == "" for v in row):
                continue
            rec = {c: (str(row[idx[c]]).strip() if c in idx and row[idx[c]] is not None else "")
                   for c in ["行政区划名称", "事发地", "诉求标题", "诉求内容"]}
            total += 1
            code = detect_district(rec)
            district_seen[rec["行政区划名称"] or "<空>"] += 1
            if code:
                district_resolved[code] += 1
            if not code:
                continue
            seen = set()
            dummy_township = True
            for text_key, weight_key in (("事发地", "addr"), ("诉求标题", "title"), ("诉求内容", "content")):
                for name, _, _ in candidates_in(rec[text_key]):
                    key = (name, code)
                    if key in seen:
                        continue
                    seen.add(key)
                    a = agg[key]
                    a["count"] += 1
                    a[weight_key] += 1
                    if text_key == "事发地" and dummy_township and not a["evidence"]:
                        a["evidence"] = rec["事发地"][:120]
                    if not a["evidence"]:
                        a["evidence"] = (rec["事发地"] or rec["诉求标题"])[:120]
                    tcode, tname = match_township(rec, code)
                    if tcode:
                        a["townVotes"][tcode] += 1
        wb.close()
    rows = []
    for (name, dcode), a in agg.items():
        tcode = a["townVotes"].most_common(1)[0][0] if a["townVotes"] else ""
        rows.append({"name": name, "count": a["count"], "addrCount": a["addr"], "titleCount": a["title"],
                     "contentCount": a["content"], "districtCode": dcode,
                     "districtName": DISTRICT_NAME.get(dcode, ""), "townshipCode": tcode,
                     "evidence": a["evidence"]})
    rows.sort(key=lambda r: (-r["count"], r["districtCode"], r["name"]))
    path = os.path.join(OUT, "community-candidates.csv")
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["name", "districtCode", "districtName", "townshipCode", "count", "addrCount",
                                          "titleCount", "contentCount", "evidence"])
        w.writeheader()
        for r in rows:
            w.writerow({k: r[k] for k in w.fieldnames})
    per_district = collections.Counter(r["districtCode"] for r in rows)
    summary = {"totalRows": total, "candidatePairs": len(rows),
               "countGe2": sum(1 for r in rows if r["count"] >= 2),
               "ge2OrAddr": sum(1 for r in rows if r["count"] >= 2 or r["addrCount"] >= 1),
               "addrGe1": sum(1 for r in rows if r["addrCount"] >= 1),
               "districtRaw": district_seen.most_common(),
               "districtResolved": {DISTRICT_NAME.get(k, k): v for k, v in district_resolved.most_common()},
               "candidatesPerDistrict": {DISTRICT_NAME.get(k, k): v for k, v in per_district.most_common()}}
    json.dump(summary, open(os.path.join(OUT, "community-extract-summary.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print("pairs", len(rows), "ge2", summary["countGe2"], "ge2OrAddr", summary["ge2OrAddr"])

if __name__ == "__main__":
    main()