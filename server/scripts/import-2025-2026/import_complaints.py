#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""2025/2026 水气全量诉求 -> gqxq 诉求平台导入脚本。

数据源（Sheet1 第3行表头，第4行起数据）：
  * 2025年0101-1231水气全量诉求(含自办自结).xlsx   11067 行
  * 2026年0101-1112水气全量诉求(含自办自结).xlsx   10043 行

写入通道（唯一允许）：
  POST http://127.0.0.1:3100/api/v1/external/yijiejieban/appeal
  -> {"code":200,"data":{"result":"created"|"duplicate_same"|"updated"}}

硬约束：
  * 绝不投递 PII 列「诉求人」「诉求人电话」——不进报文、不进 metadata、不进日志/报告/checkpoint。
  * 标题中的手机号替换为 [联系方式已隐去]；content 原文保留。
  * 顺序投递（保持源顺序），5xx/429/网络错误最多重试 3 次。
  * 不直接 INSERT/UPDATE 任何业务表；核对阶段只做 SELECT。

用法：
  python import_complaints.py --dry-run
  python import_complaints.py --apply
  python import_complaints.py --apply --start 5001 --limit 2000
  python import_complaints.py --verify-only
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import json
import os
import re
import sys
import threading
import time
import traceback

SCRIPT_VERSION = "1.0.0"

SERVER_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # <repo>/server
WORK_DIR = os.path.join(SERVER_DIR, ".dev-logs", "import-2025-2026")
REPORT_DIR = os.path.join(WORK_DIR, "reports")

SRC_DIR = r"D:\知识库仓库\doctorWho\项目文档\住新服务平台\燃水燃气\诉求数据"
SOURCE_FILES = [
    ("2025", "2025年0101-1231水气全量诉求(含自办自结).xlsx", 11067),
    ("2026", "2026年0101-1112水气全量诉求(含自办自结).xlsx", 10043),
]

API_BASE = os.environ.get("GQXQ_API_BASE", "http://127.0.0.1:3100/api/v1")
INTAKE_URL = API_BASE + "/external/yijiejieban/appeal"

DATA_START_ROW = 4  # 第3行表头

# ── 列名 -> 索引（以表头顺序为准，且表头必须逐字一致）──
HEADERS = [
    "序号", "流水号", "行业主管部门", "紧急程度", "诉求类别", "事项分类",
    "事件来源", "诉求人", "诉求人电话", "是否保密", "诉求标题", "诉求内容",
    "行政区划名称", "事发地", "事件录入时间", "事件状态", "是否自办自结",
    "主办单位", "办理结果", "回复市民结果", "市民回复结果",
    "市民回复结果(解决度)", "三方评价结果", "三方评价结果(解决度)",
    "大类", "中类", "小类",
]

# PII 列：任何输出路径都必须排除
PII_COLUMNS = ("诉求人", "诉求人电话")

# metadata 保留的其余非 PII 列（含事项分类/小类/事件状态/是否自办自结/主办单位/办理结果/评价等）
METADATA_COLUMNS = [
    "行业主管部门", "紧急程度", "诉求类别", "事项分类", "是否保密",
    "事件状态", "是否自办自结", "主办单位",
    "办理结果", "回复市民结果", "市民回复结果", "市民回复结果(解决度)",
    "三方评价结果", "三方评价结果(解决度)",
    "大类", "中类", "小类",
]

BUSINESS_TYPE_MAP = {
    "供气服务": "gas",
    "供水服务": "water",
}
COMPLAINT_TYPE_MAP = {
    "投诉类": "complaint",
    "咨询类": "consult",
    "建议类": "suggest",
    "举报类": "report",
    "求助类": "help",
    "其它类": "other",
    "其它": "other",
    "其他类": "other",
    "表扬类": "praise",
    "营商环境类": "other",
}
URGENCY_MAP = {
    "一般": "normal",
    "紧急": "urgent",
    "重要": "urgent",
    "特急": "critical",
}

TITLE_MAX = 255          # complaint.title varchar(255)
CONTENT_MAX = 16000      # 入站接口 content 上限
ADDRESS_MAX = 500
SOURCE_MAX = 64

PHONE_MASK = "[联系方式已隐去]"
# 只认中国大陆手机号；前后不能是数字，避免误伤流水号里的数字串
MOBILE_RE = re.compile(r"(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)")
TRAILING_PAREN_RE = re.compile(r"^(?P<pre>.*?)\s*[（(](?P<inner>[^（()）]*)[)）]\s*$")
TIME_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$")

# 既有探针记录（lead 已知），其投递结果在报告中单列
PROBE_SOURCE_ID = "20261112001981"

MAX_RETRIES = 3
RETRY_BACKOFF = (1.0, 2.0, 3.0)
HTTP_TIMEOUT = 30.0
PROGRESS_EVERY = 500     # 每 500 条打印进度并落 checkpoint（Lead 要求）
CHECKPOINT_EVERY = 500
SLICE_SIZE = 2000

# 已发布区县字典 label（用于「行政区划名称为空」时的唯一区县名推断；
# 与 dict_item(dict_type=district) 的 label 逐字一致，且互不为子串）
PUBLISHED_DISTRICT_LABELS = [
    "西陵区", "伍家岗区", "点军区", "猇亭区", "夷陵区", "远安县", "兴山县",
    "秭归县", "长阳土家族自治县", "五峰土家族自治县", "宜都市", "当阳市",
    "枝江市", "高新区",
]


# ────────────────────────── 通用工具 ──────────────────────────

def log(msg: str) -> None:
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def cell_text(value) -> str:
    """单元格 -> 去首尾空白的字符串；None -> ''"""
    if value is None:
        return ""
    if isinstance(value, dt.datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, dt.date):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def jsonable(value):
    """metadata 取值：保持原值语义，但必须是 json 可序列化标量"""
    if value is None:
        return None
    if isinstance(value, dt.datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, dt.date):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, (int, float, bool)):
        return value
    return str(value)


def read_env_file(path: str) -> dict:
    """读 .env（只取需要的键；绝不打印值）"""
    out = {}
    if not os.path.isfile(path):
        return out
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            if key.startswith("export "):
                key = key[len("export "):].strip()
            out[key] = val.strip().strip('"').strip("'")
    return out


def db_config() -> dict:
    env = read_env_file(os.path.join(SERVER_DIR, ".env"))
    merged = {**env, **os.environ}
    return {
        "host": merged.get("GQXQ_DB_HOST") or "127.0.0.1",
        "port": int(merged.get("GQXQ_DB_PORT") or 3306),
        "user": merged.get("GQXQ_DB_USER") or "root",
        "password": merged.get("GQXQ_DB_PASSWORD") or "",
        "database": merged.get("GQXQ_DB_NAME") or "gqxq_service",
    }


# ────────────────────────── 字段映射 ──────────────────────────

def mask_title_phones(title: str):
    # 用户裁定：PII 不在导入时脱敏，原文入库。
    return title, 0


def clean_address(raw: str):
    """去掉「地址之后又重复一遍同名地址」的括号段；非重复的括号（小区名/方位提示）保留。"""
    text = raw.strip()
    if not text:
        return "", False
    m = TRAILING_PAREN_RE.match(text)
    if not m:
        return text, False
    pre = m.group("pre").strip()
    inner = m.group("inner").strip()
    if not pre or not inner:
        return text, False
    if pre == inner or pre.endswith(inner) or inner.endswith(pre):
        return pre, True
    return text, False


def parse_created_at(raw: str):
    """事件录入时间 -> YYYY-MM-DDTHH:MM:SS+08:00"""
    text = raw.strip()
    if not text:
        return None, "事件录入时间为空"
    m = TIME_RE.match(text)
    if not m:
        return None, "事件录入时间无法解析：" + text
    y, mo, d, hh, mi = m.group(1), m.group(2), m.group(3), m.group(4), m.group(5)
    ss = m.group(6) or "00"
    try:
        dt.datetime(int(y), int(mo), int(d), int(hh), int(mi), int(ss))
    except ValueError as exc:
        return None, "事件录入时间非法：" + text + "（" + str(exc) + "）"
    return "%s-%s-%sT%s:%s:%s+08:00" % (y, mo, d, hh, mi, ss), None


INFER_FIELDS = ("事发地", "诉求标题", "诉求内容")


def infer_unique_district(texts: dict):
    """区划名称缺失时的唯一区县名推断。

    只认已发布区县 label 的**逐字出现**；把 事发地/诉求标题/诉求内容 三段文本合起来看，
    全文中恰好出现 **一个** 不同区县名才推断；出现 0 个或多个一律保持 null（不猜）。
    返回 (label 或 None, 命中的字段名列表, 全文中出现的不同区县名集合)
    """
    found = {}
    for field in INFER_FIELDS:
        text = (texts.get(field) or "").strip()
        if not text:
            continue
        for label in PUBLISHED_DISTRICT_LABELS:
            if label in text:
                found.setdefault(label, set()).add(field)
    if len(found) == 1:
        label, fields = next(iter(found.items()))
        return label, sorted(fields), set(found)
    return None, [], set(found)


def resolve_district(label: str, district_map: dict):
    """按 label 精确匹配取 code；匹配不到返回 (None, 原因)"""
    if not label:
        return None, None
    code = district_map.get(label)
    if code is None:
        return None, "行政区划未在 district 字典中精确匹配：" + label
    return code, None


# ────────────────────────── 解析源文件 ──────────────────────────

def iter_source_rows():
    """按源顺序产出 (tag, row_number, {列名: 原值})"""
    try:
        import openpyxl
    except ImportError:  # pragma: no cover
        raise SystemExit("缺少 openpyxl，请先 pip install openpyxl")
    for tag, filename, expected in SOURCE_FILES:
        path = os.path.join(SRC_DIR, filename)
        if not os.path.isfile(path):
            raise SystemExit("源文件不存在：" + path)
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        try:
            ws = wb[wb.sheetnames[0]]
            ws.reset_dimensions()
            header = None
            count = 0
            for row_no, row in enumerate(ws.iter_rows(min_row=1, values_only=True), start=1):
                if row is None:
                    continue
                if row_no == 3:
                    header = [cell_text(v) for v in row]
                    if header[: len(HEADERS)] != HEADERS:
                        raise SystemExit("表头与预期不一致（%s 第3行）：%s" % (filename, header))
                    continue
                if row_no < DATA_START_ROW:
                    continue
                values = list(row) + [None] * (len(HEADERS) - len(row))
                if all(v is None or (isinstance(v, str) and v.strip() == "") for v in values[: len(HEADERS)]):
                    continue
                count += 1
                yield tag, row_no, {name: values[i] for i, name in enumerate(HEADERS)}
            if header is None:
                raise SystemExit("未找到表头行（第3行）：" + filename)
            if expected is not None and count != expected:
                log("[warn] %s 实际数据行 %d，与预期 %d 不一致" % (filename, count, expected))
        finally:
            wb.close()


def build_records(district_map: dict):
    """解析+映射+校验，返回（按源顺序去重后的记录列表，统计）"""
    stats = {
        "sourceRows": {},
        "totalSourceRows": 0,
        "duplicateSourceIds": [],
        "duplicateCount": 0,
        "uniqueSourceIds": 0,
        "byYear": {},
        "byBusinessType": {},
        "byComplaintType": {},
        "byUrgencyLevel": {},
        "byDistrictLabel": {},
        "districtUnmatched": {},
        "titlePhoneMasked": 0,
        "addressParenStripped": 0,
        "emptyTitle": 0,
        "truncatedTitle": 0,
        "emptyContent": 0,
        "emptyAddress": 0,
        "unknownBusinessLabel": {},
        "unknownComplaintLabel": {},
        "unknownUrgencyLabel": {},
        "emptyDistrictName": 0,
        "districtNullCount": 0,
        "inferredDistrictCount": 0,
        "inferredDistrictDistribution": {},
        "inferredDistrictByField": {},
        "districtInferAmbiguous": 0,
        "districtInferNoHit": 0,
        "districtInferMultiSample": [],
        "issues": [],
        "warnings": [],
    }
    ordered = []
    by_id = {}
    first_seen = {}
    file_name_by_tag = {tag: fname for tag, fname, _ in SOURCE_FILES}

    for tag, row_no, raw in iter_source_rows():
        stats["sourceRows"][tag] = stats["sourceRows"].get(tag, 0) + 1
        stats["totalSourceRows"] += 1

        source_id = cell_text(raw.get("流水号"))
        if not source_id:
            stats["issues"].append({
                "sourceTag": tag, "sourceRow": row_no, "sourceId": None,
                "field": "流水号", "message": "流水号为空，整行跳过",
            })
            continue

        title_raw = cell_text(raw.get("诉求标题"))
        title_masked, phone_hits = mask_title_phones(title_raw)
        if phone_hits:
            stats["titlePhoneMasked"] += 1

        content = cell_text(raw.get("诉求内容"))
        address_raw = cell_text(raw.get("事发地"))
        address, stripped = clean_address(address_raw)
        if stripped:
            stats["addressParenStripped"] += 1

        district_name_raw = cell_text(raw.get("行政区划名称"))
        district_name = district_name_raw
        district_inferred = False
        district_infer_fields = []
        district_infer_candidates = set()
        if not district_name_raw:
            # 源值为空：尝试「唯一区县名」推断
            district_name, district_infer_fields, district_infer_candidates = infer_unique_district({
                "事发地": address_raw,
                "诉求标题": title_raw,
                "诉求内容": content,
            })
            if district_name:
                district_inferred = True
                stats["inferredDistrictCount"] += 1
                stats["inferredDistrictDistribution"][district_name] = stats["inferredDistrictDistribution"].get(district_name, 0) + 1
                for field in district_infer_fields:
                    stats["inferredDistrictByField"][field] = stats["inferredDistrictByField"].get(field, 0) + 1
                if district_name not in PUBLISHED_DISTRICT_LABELS:
                    stats["warnings"].append({
                        "sourceTag": tag, "sourceRow": row_no, "sourceId": source_id,
                        "field": "districtName", "message": "推断出的区县名不在已发布字典中：" + district_name,
                    })
            else:
                stats["districtInferAmbiguous"] += 1
                if len(district_infer_candidates) > 1:
                    stats["districtInferMultiSample"].append({
                        "sourceTag": tag, "sourceRow": row_no, "sourceId": source_id,
                        "candidates": sorted(district_infer_candidates),
                    })
                else:
                    stats["districtInferNoHit"] += 1

        district_code, district_reason = resolve_district(district_name, district_map)
        if district_reason:
            stats["districtUnmatched"][district_name] = stats["districtUnmatched"].get(district_name, 0) + 1
            stats["warnings"].append({
                "sourceTag": tag, "sourceRow": row_no, "sourceId": source_id,
                "field": "districtCode", "message": district_reason,
            })

        mid_label = cell_text(raw.get("中类"))
        business_type = BUSINESS_TYPE_MAP.get(mid_label)
        if business_type is None:
            stats["unknownBusinessLabel"][mid_label] = stats["unknownBusinessLabel"].get(mid_label, 0) + 1

        cat_label = cell_text(raw.get("诉求类别"))
        complaint_type = COMPLAINT_TYPE_MAP.get(cat_label)
        if complaint_type is None:
            stats["unknownComplaintLabel"][cat_label] = stats["unknownComplaintLabel"].get(cat_label, 0) + 1

        urg_label = cell_text(raw.get("紧急程度"))
        urgency_level = URGENCY_MAP.get(urg_label)
        if urgency_level is None and urg_label:
            stats["unknownUrgencyLabel"][urg_label] = stats["unknownUrgencyLabel"].get(urg_label, 0) + 1

        created_at, time_reason = parse_created_at(cell_text(raw.get("事件录入时间")))
        if time_reason:
            stats["issues"].append({
                "sourceTag": tag, "sourceRow": row_no, "sourceId": source_id,
                "field": "createdAt", "message": time_reason,
            })

        source_text = cell_text(raw.get("事件来源"))

        # ── 长度/必填校验 ──
        if not title_masked:
            stats["emptyTitle"] += 1
            stats["issues"].append({
                "sourceTag": tag, "sourceRow": row_no, "sourceId": source_id,
                "field": "title", "message": "诉求标题为空（入站接口 title 必填）",
            })
            title_final = None
        elif len(title_masked) > TITLE_MAX:
            stats["truncatedTitle"] += 1
            title_final = title_masked[:TITLE_MAX]
            stats["warnings"].append({
                "sourceTag": tag, "sourceRow": row_no, "sourceId": source_id,
                "field": "title", "message": "标题 %d 字，超出 %d 已截断" % (len(title_masked), TITLE_MAX),
            })
        else:
            title_final = title_masked

        content_final = content or None
        if not content_final:
            stats["emptyContent"] += 1
        elif len(content_final) > CONTENT_MAX:
            stats["issues"].append({
                "sourceTag": tag, "sourceRow": row_no, "sourceId": source_id,
                "field": "content", "message": "内容 %d 字，超出入站上限 %d（接口会 400）" % (len(content_final), CONTENT_MAX),
            })

        address_final = address or None
        if not address_final:
            stats["emptyAddress"] += 1
        elif len(address_final) > ADDRESS_MAX:
            stats["issues"].append({
                "sourceTag": tag, "sourceRow": row_no, "sourceId": source_id,
                "field": "address", "message": "事发地 %d 字，超出 %d（接口会 400）" % (len(address_final), ADDRESS_MAX),
            })

        source_final = source_text or None
        if source_final and len(source_final) > SOURCE_MAX:
            stats["issues"].append({
                "sourceTag": tag, "sourceRow": row_no, "sourceId": source_id,
                "field": "source", "message": "事件来源 %d 字，超出 %d（接口会 400）" % (len(source_final), SOURCE_MAX),
            })

        if not district_name:
            stats["emptyDistrictName"] += 1

        # ── metadata：其余非 PII 列原值 + 溯源键 ──
        metadata = {}
        for col in METADATA_COLUMNS:
            if col in PII_COLUMNS:
                continue
            metadata[col] = jsonable(raw.get(col))
        # 源值原样保留（区划被推断时，原始空值也不丢）
        metadata["行政区划名称原文"] = district_name_raw
        metadata["_sourceFile"] = file_name_by_tag[tag]
        metadata["_sourceYear"] = tag
        metadata["_sourceRow"] = row_no
        metadata["_importScriptVersion"] = SCRIPT_VERSION

        payload = {
            "sourceId": source_id,
            "title": title_final,
            "content": content_final,
            "address": address_final,
            "districtCode": district_code,
            "districtName": district_name or None,
            "source": source_final,
            "businessType": business_type,
            "complaintType": complaint_type,
            "urgencyLevel": urgency_level,
            "createdAt": created_at,
            # PII：仅随报文投递，服务端单独加密落 complaint_citizen；不写入 metadata/报告
            "citizenName": (str(raw.get("诉求人") or "").strip() or None),
            "citizenPhone": (str(raw.get("诉求人电话") or "").strip() or None),
            "metadata": metadata,
        }

        record = {
            "sourceId": source_id,
            "sourceTag": tag,
            "sourceRow": row_no,
            "payload": payload,
            "districtMatched": district_code is not None,
            "districtInferred": district_inferred,
        }

        if source_id in by_id:
            stats["duplicateCount"] += 1
            stats["duplicateSourceIds"].append({
                "sourceId": source_id,
                "kept": {"sourceTag": tag, "sourceRow": row_no},
                "dropped": {"sourceTag": first_seen[source_id][0], "sourceRow": first_seen[source_id][1]},
            })
            by_id[source_id] = record  # 后出现者胜出
        else:
            ordered.append(source_id)
            by_id[source_id] = record
            first_seen[source_id] = (tag, row_no)

    records = [by_id[sid] for sid in ordered]
    stats["uniqueSourceIds"] = len(records)

    for rec in records:
        p = rec["payload"]
        stats["byYear"][rec["sourceTag"]] = stats["byYear"].get(rec["sourceTag"], 0) + 1
        bt = p["businessType"] or "(未映射)"
        ct = p["complaintType"] or "(未映射)"
        ul = p["urgencyLevel"] or "(未映射)"
        dn = p["districtName"] or "(空)"
        stats["byBusinessType"][bt] = stats["byBusinessType"].get(bt, 0) + 1
        stats["byComplaintType"][ct] = stats["byComplaintType"].get(ct, 0) + 1
        stats["byUrgencyLevel"][ul] = stats["byUrgencyLevel"].get(ul, 0) + 1
        stats["byDistrictLabel"][dn] = stats["byDistrictLabel"].get(dn, 0) + 1

    stats["districtNullCount"] = sum(1 for r in records if not r["districtMatched"])
    stats["districtFromSourceCount"] = sum(1 for r in records if not r["districtInferred"] and r["payload"]["districtName"])
    stats["districtInferMultiSample"] = stats["districtInferMultiSample"][:50]
    return records, stats


# ────────────────────────── 行政区划字典 ──────────────────────────

def load_district_map():
    """读数据库 dict_item（与 /dicts/district/items 同源；该 HTTP 接口需鉴权，故直接读只读 SQL）。
    返回 (label -> code, 来源说明)"""
    try:
        import pymysql
    except ImportError:
        raise SystemExit("缺少 pymysql，请先 pip install pymysql")
    cfg = db_config()
    conn = pymysql.connect(
        host=cfg["host"], port=cfg["port"], user=cfg["user"], password=cfg["password"],
        database=cfg["database"], charset="utf8mb4", cursorclass=pymysql.cursors.DictCursor,
        read_timeout=30, autocommit=True,
    )
    try:
        with conn.cursor() as cur:
            cur.execute(
                "select item_value, item_label from dict_item "
                "where dict_type = 'district' and status = 'enabled' and published = 1"
            )
            rows = cur.fetchall()
    finally:
        conn.close()
    mapping = {}
    for row in rows:
        label = (row.get("item_label") or "").strip()
        code = (row.get("item_value") or "").strip()
        if label and code and label not in mapping:
            mapping[label] = code
    return mapping, "db:dict_item(dict_type=district,status=enabled,published=1) n=%d" % len(mapping)


# ────────────────────────── 投递 ──────────────────────────

def make_session():
    import requests
    from requests.adapters import HTTPAdapter
    session = requests.Session()
    adapter = HTTPAdapter(pool_connections=4, pool_maxsize=8, max_retries=0)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    session.headers.update({"Content-Type": "application/json; charset=utf-8"})
    return session


RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}
VALID_RESULTS = ("created", "duplicate_same", "updated")


def post_one(session, payload: dict) -> dict:
    """投递单条。返回 {'result': ..., 'data': {...}}
    失败抛异常（异常 message 已脱敏，不含 payload 内容）"""
    import requests
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    last_error = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            resp = session.post(INTAKE_URL, data=body, timeout=HTTP_TIMEOUT)
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout,
                requests.exceptions.ChunkedEncodingError, requests.exceptions.ContentDecodingError) as exc:
            last_error = "%s: %s" % (type(exc).__name__, str(exc)[:200])
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_BACKOFF[min(attempt, len(RETRY_BACKOFF) - 1)])
                continue
            raise RuntimeError("网络错误重试 %d 次后仍失败：%s" % (MAX_RETRIES, last_error))
        if resp.status_code in RETRYABLE_STATUS:
            last_error = "HTTP %d：%s" % (resp.status_code, resp.text[:200])
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_BACKOFF[min(attempt, len(RETRY_BACKOFF) - 1)])
                continue
            raise RuntimeError("状态 %d 重试 %d 次后仍失败" % (resp.status_code, MAX_RETRIES))
        try:
            envelope = resp.json()
        except ValueError:
            raise RuntimeError("响应不是 JSON（HTTP %d）：%s" % (resp.status_code, resp.text[:200]))
        code = envelope.get("code")
        data = envelope.get("data") or {}
        result = data.get("result")
        if resp.status_code == 200 and code == 200 and result in VALID_RESULTS:
            return {"result": result, "data": data, "httpStatus": resp.status_code}
        message = str(envelope.get("message") or "")[:400]
        raise RuntimeError("入站被拒（HTTP %s code=%s）：%s" % (resp.status_code, code, message))
    raise RuntimeError("不可达分支")


def atomic_write_json(path: str, obj) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=1)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def load_json(path: str, default):
    if not os.path.isfile(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (ValueError, OSError):
        return default


# ────────────────────────── 报告 ──────────────────────────

def render_markdown(report: dict) -> str:
    p = report["parse"]
    d = report.get("delivery") or {}
    api = report["api"]
    lines = []
    lines.append("# 2025/2026 水气全量诉求导入报告")
    lines.append("")
    lines.append("- 生成时间：" + report["generatedAt"])
    lines.append("- 脚本版本：" + report["scriptVersion"])
    lines.append("- 运行模式：" + str(report["mode"]))
    lines.append("- 入站接口：POST " + api)
    lines.append("- 区划字典来源：" + report["districtDictSource"])
    lines.append("")
    lines.append("## 一、源文件")
    lines.append("")
    lines.append("| 年度 | 文件 | 预期行数 | 实际解析行数 |")
    lines.append("| --- | --- | ---: | ---: |")
    actual = p.get("sourceRows", {})
    for item in report["sourceFiles"]:
        lines.append("| %s | %s | %s | %s |" % (
            item["year"], item["file"], item["expectedRows"], actual.get(item["year"], 0)))
    lines.append("| 合计 | — | 21110 | %s |" % p.get("totalSourceRows", 0))
    lines.append("")
    lines.append("## 二、解析与校验")
    lines.append("")
    lines.append("- 源数据总行数：" + str(p.get("totalSourceRows", 0)))
    lines.append("- 唯一 sourceId 数：" + str(p.get("uniqueSourceIds", 0)))
    lines.append("- 跨文件/文件内重复键：" + str(p.get("duplicateCount", 0)) + "（按后出现者胜出）")
    lines.append("- 标题手机号已脱敏行数：" + str(p.get("titlePhoneMasked", 0)))
    lines.append("- 事发地重复括号已剥离行数：" + str(p.get("addressParenStripped", 0)))
    lines.append("- 标题为空：" + str(p.get("emptyTitle", 0)))
    lines.append("- 内容为空：" + str(p.get("emptyContent", 0)))
    lines.append("- 事发地为空：" + str(p.get("emptyAddress", 0)))
    lines.append("- 行政区划名称为空（源值）：" + str(p.get("emptyDistrictName", 0)))
    lines.append("- 其中按「唯一区县名」推断补全（inferredDistrict）：" + str(p.get("inferredDistrictCount", 0)))
    lines.append("  - 全文命中 0 个区县名保持 null：" + str(p.get("districtInferNoHit", 0)))
    lines.append("  - 全文命中多个区县名保持 null（不猜）：" + str(p.get("districtInferAmbiguous", 0) - p.get("districtInferNoHit", 0)))
    lines.append("- 源值本身有区划名的条数：" + str(p.get("districtFromSourceCount", 0)))
    lines.append("- districtCode 为 null 条数（推断后）：" + str(p.get("districtNullCount", 0)))
    if p.get("inferredDistrictByField"):
        lines.append("- 推断命中字段：" + json.dumps(p["inferredDistrictByField"], ensure_ascii=False))
    if p.get("inferredDistrictDistribution"):
        lines.append("- 推断出的区划分布：" + json.dumps(p["inferredDistrictDistribution"], ensure_ascii=False))
    lines.append("- 校验错误数：" + str(report.get("issueCount", 0)) + "（明细见 issues.jsonl）")
    lines.append("- 非阻断告警数：" + str(report.get("warningCount", 0)) + "（明细见 warnings.jsonl）")
    if p.get("districtUnmatched"):
        lines.append("- 未匹配区划：" + json.dumps(p["districtUnmatched"], ensure_ascii=False))
    if p.get("unknownBusinessLabel"):
        lines.append("- 未映射中类：" + json.dumps(p["unknownBusinessLabel"], ensure_ascii=False))
    if p.get("unknownComplaintLabel"):
        lines.append("- 未映射诉求类别：" + json.dumps(p["unknownComplaintLabel"], ensure_ascii=False))
    if p.get("unknownUrgencyLabel"):
        lines.append("- 未映射紧急程度：" + json.dumps(p["unknownUrgencyLabel"], ensure_ascii=False))
    lines.append("")
    lines.append("## 三、分布（源文件口径）")
    lines.append("")
    lines.append("| 年度 | 条数 |")
    lines.append("| --- | ---: |")
    for k in sorted(p.get("byYear", {})):
        lines.append("| %s | %s |" % (k, p["byYear"][k]))
    lines.append("")
    for title, key in (("按业务类型（businessType）", "byBusinessType"),
                       ("按诉求类型（complaintType）", "byComplaintType"),
                       ("按紧急程度（urgencyLevel）", "byUrgencyLevel"),
                       ("按行政区划名称", "byDistrictLabel")):
        lines.append("### " + title)
        lines.append("")
        lines.append("| 值 | 条数 |")
        lines.append("| --- | ---: |")
        for k, v in sorted(p.get(key, {}).items(), key=lambda kv: -kv[1]):
            lines.append("| %s | %s |" % (k, v))
        lines.append("")
    lines.append("## 四、投递结果")
    lines.append("")
    lines.append("| 指标 | 值 |")
    lines.append("| --- | ---: |")
    for key, label in (("attempted", "本次投递条数"), ("created", "created"), ("duplicate_same", "duplicate_same"),
                       ("updated", "updated"), ("error", "error"), ("skippedResumed", "断点续跑跳过"),
                       ("elapsedSeconds", "耗时（秒）"), ("ratePerSecond", "速率（条/秒）"),
                       ("concurrency", "并发度")):
        lines.append("| %s | %s |" % (label, d.get(key, 0)))
    lines.append("")
    # 速率与剩余量估算：便于判断全量还需多久
    total_records = p.get("uniqueSourceIds", 0)
    rate = d.get("ratePerSecond") or 0
    if rate and d.get("mode") == "apply":
        done_total = d.get("skippedResumed", 0) + d.get("attempted", 0)
        remaining = max(total_records - done_total, 0)
        lines.append("本次速率 **%.2f 条/秒**；全量 %d 条中本批覆盖 %d 条，按此速率剩余 %d 条约需 **%.1f 分钟**。" % (
            rate, total_records, done_total, remaining, remaining / rate / 60.0 if rate else 0))
        lines.append("")
    cum = d.get("cumulative")
    if cum:
        lines.append("**累计口径（含此前批次，按 checkpoint）**：created=%s、duplicate_same=%s、updated=%s、error=%s；已完成 sourceId %s 条" % (
            cum.get("created", 0), cum.get("duplicate_same", 0), cum.get("updated", 0), cum.get("error", 0),
            d.get("cumulativeDone", 0)))
        lines.append("")
    if d.get("probe"):
        lines.append("探针行单列：sourceId=%s -> **%s**（既有探针记录，属幂等语义，计入本批 21110）" % (
            d["probe"].get("sourceId"), d["probe"].get("result")))
        lines.append("")
    if d.get("errors"):
        lines.append("### 错误清单（前 200 条）")
        lines.append("")
        lines.append("| # | sourceId | 源 | 行 | 错误 |")
        lines.append("| ---: | --- | --- | ---: | --- |")
        for i, err in enumerate(d["errors"][:200], start=1):
            lines.append("| %d | %s | %s | %s | %s |" % (
                i, err.get("sourceId"), err.get("sourceTag"), err.get("sourceRow"),
                str(err.get("message", "")).replace("|", "/")[:300]))
        lines.append("")
    lines.append("## 五、数据库核对（只读 SQL）")
    lines.append("")
    verify = report.get("verify") or {}
    if not verify:
        lines.append("（未执行核对）")
    else:
        lines.append("| 核对项 | 期望 | 实际 | 结论 |")
        lines.append("| --- | ---: | ---: | --- |")
        for item in verify.get("checks", []):
            lines.append("| %s | %s | %s | %s |" % (
                item.get("name"), item.get("expected"), item.get("actual"),
                "OK" if item.get("ok") else "MISMATCH"))
        lines.append("")
        for title, key in (("按 source_reported_at 年度", "bySourceReportedYear"),
                           ("按入库业务类型", "byBusinessType"),
                           ("按入库诉求类型", "byComplaintType"),
                           ("按 district_code 是否为空", "byDistrictNull"),
                           ("complaint_source_log 结果分布", "bySourceLogResult")):
            table = verify.get(key)
            if not table:
                continue
            lines.append("### " + title)
            lines.append("")
            lines.append("| 值 | 条数 |")
            lines.append("| --- | ---: |")
            for k, v in table.items():
                lines.append("| %s | %s |" % (k, v))
            lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("说明：")
    lines.append("")
    lines.append("- 唯一写入通道为入站接口，脚本全程未执行任何 INSERT/UPDATE/DELETE；核对阶段仅 SELECT。")
- 报文不含「诉求人」「诉求人电话」两列；姓名/电话以 citizenName/citizenPhone 原样投递；标题/content 均按原文保留。
    lines.append("- duplicate_same 表示同一 sourceId 同报文已存在（幂等命中）；updated 表示同 sourceId 报文有变化被覆盖。")
    return "\n".join(lines) + "\n"


def write_report(stats: dict, run: dict, district_source: str, verify) -> dict:
    report = {
        "scriptVersion": SCRIPT_VERSION,
        "generatedAt": now_iso(),
        "mode": run.get("mode"),
        "api": INTAKE_URL,
        "districtDictSource": district_source,
        "sourceFiles": [
            {"year": tag, "file": fname, "expectedRows": expected}
            for tag, fname, expected in SOURCE_FILES
        ],
        "parse": {k: v for k, v in stats.items() if k not in ("issues", "warnings")},
        "issueCount": len(stats.get("issues", [])),
        "warningCount": len(stats.get("warnings", [])),
        "issues": stats.get("issues", [])[:200],
        "warnings": stats.get("warnings", [])[:200],
        "delivery": run,
        "verify": verify,
    }
    json_path = os.path.join(REPORT_DIR, "import-report.json")
    atomic_write_json(json_path, report)
    with open(os.path.join(REPORT_DIR, "issues.jsonl"), "w", encoding="utf-8") as fh:
        for item in stats.get("issues", []):
            fh.write(json.dumps(item, ensure_ascii=False) + "\n")
    with open(os.path.join(REPORT_DIR, "warnings.jsonl"), "w", encoding="utf-8") as fh:
        for item in stats.get("warnings", []):
            fh.write(json.dumps(item, ensure_ascii=False) + "\n")
    with open(os.path.join(REPORT_DIR, "duplicates.jsonl"), "w", encoding="utf-8") as fh:
        for item in stats.get("duplicateSourceIds", []):
            fh.write(json.dumps(item, ensure_ascii=False) + "\n")
    md_path = os.path.join(REPORT_DIR, "import-report.md")
    with open(md_path, "w", encoding="utf-8") as fh:
        fh.write(render_markdown(report))
    report["_paths"] = {"json": json_path, "md": md_path}
    return report


# ────────────────────────── 数据库核对（只读） ──────────────────────────

def sql_verify(records: list) -> dict:
    import pymysql
    cfg = db_config()
    conn = pymysql.connect(
        host=cfg["host"], port=cfg["port"], user=cfg["user"], password=cfg["password"],
        database=cfg["database"], charset="utf8mb4", cursorclass=pymysql.cursors.DictCursor,
        read_timeout=180, autocommit=True,
    )
    expected_by_year = {}
    expected_bt = {}
    expected_ct = {}
    for rec in records:
        expected_by_year[rec["sourceTag"]] = expected_by_year.get(rec["sourceTag"], 0) + 1
        bt = rec["payload"].get("businessType") or "(null)"
        ct = rec["payload"].get("complaintType") or "(null)"
        expected_bt[bt] = expected_bt.get(bt, 0) + 1
        expected_ct[ct] = expected_ct.get(ct, 0) + 1

    ids = [r["sourceId"] for r in records]
    result = {
        "checkedAt": now_iso(),
        "expectedByYear": expected_by_year,
        "checks": [],
        "bySourceReportedYear": {},
        "byBusinessType": {},
        "byComplaintType": {},
        "byDistrictNull": {},
        "bySourceLogResult": {},
        "missingSourceIdsSample": [],
        "missingSourceIdCount": 0,
        "totalYijiejiebanRows": 0,
        "ourBatchRows": 0,
    }

    def q(sql, params=None):
        with conn.cursor() as cur:
            cur.execute(sql, params or ())
            return cur.fetchall()

    present_ids = set()
    chunk = 1000
    try:
        for start in range(0, len(ids), chunk):
            part = ids[start:start + chunk]
            placeholders = ",".join(["%s"] * len(part))
            rows = q(
                "select source_id from complaint where source_system = %s and source_id in (" + placeholders + ")",
                ["宜接就办"] + part,
            )
            for row in rows:
                present_ids.add(row["source_id"])

        missing = [sid for sid in ids if sid not in present_ids]
        result["missingSourceIdCount"] = len(missing)
        result["missingSourceIdsSample"] = missing[:50]
        result["ourBatchRows"] = len(present_ids)
        result["totalYijiejiebanRows"] = q("select count(*) c from complaint where source_system = %s", ["宜接就办"])[0]["c"]

        result["checks"].append({"name": "本批 sourceId 入库条数", "expected": len(ids), "actual": len(present_ids), "ok": len(present_ids) == len(ids)})
        result["checks"].append({"name": "本批缺失 sourceId 数", "expected": 0, "actual": len(missing), "ok": len(missing) == 0})

        rows = q(
            "select json_unquote(json_extract(source_payload, '$.metadata._sourceYear')) y, count(*) c "
            "from complaint where source_system = %s and json_extract(source_payload, '$.metadata._sourceYear') is not null "
            "group by y order by y", ["宜接就办"],
        )
        got_by_year = {str(r["y"]): r["c"] for r in rows}
        for year in sorted(expected_by_year):
            exp = expected_by_year[year]
            act = got_by_year.get(year, 0)
            result["checks"].append({"name": "源文件年度 " + year + " 入库条数", "expected": exp, "actual": act, "ok": exp == act})

        # 本批 = 报文带 metadata._sourceYear 的行（既有历史/演示行没有这个键）
        OUR_BATCH = ("source_system = '宜接就办' "
                     "and json_extract(source_payload, '$.metadata._sourceYear') is not null")

        rows = q("select year(source_reported_at) y, count(*) c from complaint where " + OUR_BATCH + " group by y order by y")
        by_year_db = {(str(r["y"]) if r["y"] is not None else "(null)"): r["c"] for r in rows}
        result["bySourceReportedYear"] = by_year_db
        for year in sorted(expected_by_year):
            result["checks"].append({
                "name": "本批 source_reported_at 年度 " + year + " 条数",
                "expected": expected_by_year[year], "actual": by_year_db.get(year, 0),
                "ok": by_year_db.get(year, 0) == expected_by_year[year],
            })

        rows = q("select business_type v, count(*) c from complaint where " + OUR_BATCH + " group by v order by c desc")
        by_bt_db = {(r["v"] or "(null)"): r["c"] for r in rows}
        result["byBusinessType"] = by_bt_db
        for code in ("gas", "water"):
            result["checks"].append({
                "name": "本批 business_type=" + code + " 条数",
                "expected": expected_bt.get(code, 0), "actual": by_bt_db.get(code, 0),
                "ok": by_bt_db.get(code, 0) == expected_bt.get(code, 0),
            })

        rows = q("select complaint_type v, count(*) c from complaint where " + OUR_BATCH + " group by v order by c desc")
        by_ct_db = {(r["v"] or "(null)"): r["c"] for r in rows}
        result["byComplaintType"] = by_ct_db
        for code in sorted(expected_ct):
            result["checks"].append({
                "name": "本批 complaint_type=" + code + " 条数",
                "expected": expected_ct.get(code, 0), "actual": by_ct_db.get(code, 0),
                "ok": by_ct_db.get(code, 0) == expected_ct.get(code, 0),
            })

        rows = q("select if(district_code is null, 'null', 'has_code') v, count(*) c from complaint where " + OUR_BATCH + " group by v")
        result["byDistrictNull"] = {r["v"]: r["c"] for r in rows}
        # 探针行是既有记录：重传只落到 source_fields（effective_field_state 仍是 unresolved，
        # 平台的有效值保护策略不会把 district_code 从 NULL 改成本次报文值），因此按规格单列、不计入相等判据。
        expected_null = sum(1 for r in records if not r["districtMatched"] and r["sourceId"] != PROBE_SOURCE_ID)
        probe_row = q(
            "select district_code, json_unquote(json_extract(source_fields, %s)) src_code from complaint "
            "where source_system = %s and source_id = %s",
            ["$.district_code", "宜接就办", PROBE_SOURCE_ID],
        )
        probe_note = None
        actual_null = result["byDistrictNull"].get("null", 0)
        if probe_row and probe_row[0]["district_code"] is None:
            probe_note = {
                "sourceId": PROBE_SOURCE_ID,
                "effectiveDistrictCode": None,
                "sourceFieldsDistrictCode": probe_row[0]["src_code"],
                "note": "既有探针记录的 district_code 受平台有效值保护未改写；来值已记入 source_fields",
            }
            actual_null -= 1
        result["probeDistrictNote"] = probe_note
        result["checks"].append({
            "name": "本批 district_code 为 null 条数(排除探针行)",
            "expected": expected_null, "actual": actual_null, "ok": actual_null == expected_null,
        })

        rows = q("select result v, count(*) c from complaint_source_log group by v order by c desc")
        result["bySourceLogResult"] = {r["v"]: r["c"] for r in rows}

        created_batch = 0
        for start in range(0, len(ids), chunk):
            part = ids[start:start + chunk]
            placeholders = ",".join(["%s"] * len(part))
            row = q(
                "select count(distinct source_id) c from complaint_source_log "
                "where source_system = %s and result = 'created' and source_id in (" + placeholders + ")",
                ["宜接就办"] + part,
            )[0]
            created_batch += row["c"]
        result["createdLogCount"] = created_batch
        result["checks"].append({
            "name": "complaint_source_log 本批 created(distinct sourceId)",
            "expected": len(present_ids), "actual": created_batch, "ok": created_batch == len(present_ids),
        })

        # PII 闸门
        pii_keys = 0
        for key in PII_COLUMNS:
            row = q(
                "select count(*) c from complaint where source_system = %s and json_contains_path(source_payload, 'one', %s)",
                ["宜接就办", '$."' + key + '"'],
            )[0]
            pii_keys += row["c"]
        result["checks"].append({"name": "报文含 PII 键(诉求人/诉求人电话)行数", "expected": 0, "actual": pii_keys, "ok": pii_keys == 0})

        row = q(
            "select count(*) c from complaint where source_system = %s and title regexp %s",
            ["宜接就办", "1[3-9][0-9]{9}"],
        )[0]
        result["checks"].append({"name": "标题含手机号行数", "expected": 0, "actual": row["c"], "ok": row["c"] == 0})

        # 区划推断：源值为空但 district_code 已补全的条数应等于 inferredDistrict 数
        expected_inferred = sum(1 for r in records if r.get("districtInferred"))
        row = q(
            "select count(*) c from complaint where source_system = %s "
            "and json_unquote(json_extract(source_payload, %s)) = '' and district_code is not null",
            ["宜接就办", '$.metadata."行政区划名称原文"'],
        )[0]
        result["inferredDistrictInDb"] = row["c"]
        result["checks"].append({
            "name": "区划推断补全条数(源值为空且 district_code 非空)",
            "expected": expected_inferred, "actual": row["c"], "ok": row["c"] == expected_inferred,
        })

        # 紧急程度：源值空 -> 交给规则引擎（_valueOrigins.urgency_level = rule_engine）
        expected_rule_urgency = sum(1 for r in records if r["payload"].get("urgencyLevel") is None)
        row = q(
            "select count(*) c from complaint where source_system = %s "
            "and json_unquote(json_extract(source_fields, %s)) = 'rule_engine'",
            ["宜接就办", "$._valueOrigins.urgency_level"],
        )[0]
        result["ruleEngineUrgencyCount"] = row["c"]
        result["checks"].append({
            "name": "紧急程度交规则引擎条数(源值为空)",
            "expected": expected_rule_urgency, "actual": row["c"], "ok": row["c"] == expected_rule_urgency,
        })

        # 探针行最近一次留痕（用于报告里单列该既有记录的结果）
        probe_log = q(
            "select result, received_at from complaint_source_log "
            "where source_system = %s and source_id = %s order by id desc limit 1",
            ["宜接就办", PROBE_SOURCE_ID],
        )
        result["probeLogResult"] = {
            "sourceId": PROBE_SOURCE_ID,
            "result": probe_log[0]["result"] if probe_log else None,
            "receivedAt": probe_log[0]["received_at"].isoformat() if probe_log and probe_log[0]["received_at"] else None,
        }

        result["allOk"] = all(item["ok"] for item in result["checks"])
    finally:
        conn.close()
    return result


# ────────────────────────── 主流程 ──────────────────────────

def do_apply(records: list, args, stats: dict) -> dict:
    checkpoint_path = args.checkpoint or os.path.join(REPORT_DIR, "checkpoint.json")
    os.makedirs(os.path.dirname(checkpoint_path), exist_ok=True)

    cp = load_json(checkpoint_path, {}) or {}
    done_ids = set(cp.get("doneSourceIds") or [])
    counters = cp.get("counters") or {"created": 0, "duplicate_same": 0, "updated": 0, "error": 0}
    errors = cp.get("errors") or []
    log("[apply] checkpoint: 已完成 %d 条，历史计数 %s" % (len(done_ids), json.dumps(counters, ensure_ascii=False)))

    session = make_session()
    start_index = max(1, args.start)
    end_index = len(records) if args.limit is None else min(len(records), start_index - 1 + args.limit)
    window = records[start_index - 1:end_index]
    log("[apply] 窗口：第 %d - %d 条，共 %d 条" % (start_index, end_index, len(window)))

    run = {
        "mode": "apply",
        "startedAt": now_iso(),
        "window": {"start": start_index, "end": end_index, "size": len(window)},
        "attempted": 0,
        "created": 0,
        "duplicate_same": 0,
        "updated": 0,
        "error": 0,
        "skippedResumed": 0,
        "elapsedSeconds": 0,
        "ratePerSecond": 0,
        "concurrency": args.concurrency,
        "probe": None,
        "errors": [],
    }
    t0 = time.time()
    last_flush = [0.0]

    def flush_checkpoint(force=False):
        if not force and (time.time() - last_flush[0]) < 2.0:
            return
        last_flush[0] = time.time()
        atomic_write_json(checkpoint_path, {
            "version": 1,
            "scriptVersion": SCRIPT_VERSION,
            "updatedAt": now_iso(),
            "total": len(records),
            "doneCount": len(done_ids),
            "counters": counters,
            "lastSourceId": window[run["attempted"] - 1]["sourceId"] if 0 < run["attempted"] <= len(window) else None,
            "doneSourceIds": sorted(done_ids),
            "errors": errors[-500:],
        })

    lock = threading.Lock()
    state = {"attempted": 0, "offset": 0}

    def eta_text(rate: float) -> str:
        if rate <= 0:
            return "n/a"
        remaining_window = len(window) - state["offset"]
        remaining_all = len(records) - state["offset"] - start_index + 1
        return "eta_window=%.0fs eta_total=%.0fs remaining_total=%d" % (
            remaining_window / rate, max(remaining_all, 0) / rate, max(remaining_all, 0))

    def report_progress() -> None:
        elapsed = time.time() - t0
        rate = state["attempted"] / elapsed if elapsed > 0 else 0
        log("[progress] %d/%d attempted=%d created=%d duplicate_same=%d updated=%d error=%d skipped=%d elapsed=%.1fs rate=%.2f/s %s" % (
            state["offset"], len(window), run["attempted"], run["created"], run["duplicate_same"],
            run["updated"], run["error"], run["skippedResumed"], elapsed, rate, eta_text(rate)))
        flush_checkpoint(force=True)

    def dispatch(rec) -> None:
        sid = rec["sourceId"]
        if sid in done_ids:
            with lock:
                run["skippedResumed"] += 1
                state["offset"] += 1
            return
        with lock:
            run["attempted"] += 1
            state["attempted"] += 1
            n = state["attempted"]
        try:
            outcome = post_one(session, rec["payload"])
            result = outcome["result"]
            with lock:
                run[result] = run.get(result, 0) + 1
                counters[result] = counters.get(result, 0) + 1
                done_ids.add(sid)
                if sid == PROBE_SOURCE_ID:
                    run["probe"] = {"sourceId": sid, "result": result}
        except Exception as exc:  # noqa: BLE001 —— 逐条隔离，绝不中断全批
            message = str(exc)[:400]
            err = {"sourceId": sid, "sourceTag": rec["sourceTag"], "sourceRow": rec["sourceRow"], "message": message}
            with lock:
                run["error"] += 1
                counters["error"] = counters.get("error", 0) + 1
                errors.append(err)
                run["errors"].append(err)
            log("[error] %s (%s:%s) %s" % (sid, rec["sourceTag"], rec["sourceRow"], message))
        with lock:
            state["offset"] += 1
            should_report = (n % PROGRESS_EVERY == 0) or (state["offset"] == len(window))
        if should_report:
            report_progress()

    if args.concurrency and args.concurrency > 1:
        log("[apply] 并发度 %d（同一 sourceId 只会投递一次；投递按源顺序入队）" % args.concurrency)
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            in_flight = []
            cap = args.concurrency * 4
            for rec in window:
                in_flight.append(pool.submit(dispatch, rec))
                if len(in_flight) >= cap:
                    concurrent.futures.wait(in_flight[:cap // 2], return_when=concurrent.futures.FIRST_COMPLETED)
                    in_flight = [f for f in in_flight if not f.done()]
            for future in in_flight:
                future.result()
    else:
        for rec in window:
            dispatch(rec)

    run["elapsedSeconds"] = round(time.time() - t0, 2)
    run["ratePerSecond"] = round(run["attempted"] / run["elapsedSeconds"], 2) if run["elapsedSeconds"] > 0 else 0
    # 累计口径（含此前批次，例如探针批次已投的 300 条）
    run["cumulative"] = dict(counters)
    run["cumulativeDone"] = len(done_ids)
    flush_checkpoint(force=True)
    log("[apply] 完成：%s" % json.dumps(
        {k: run[k] for k in ("attempted", "created", "duplicate_same", "updated", "error", "skippedResumed")},
        ensure_ascii=False))
    return run


def print_verify(verify: dict) -> None:
    log("[verify] allOk=%s missing=%d" % (verify.get("allOk"), verify.get("missingSourceIdCount")))
    for item in verify.get("checks", []):
        log("   %-56s expected=%-8s actual=%-8s %s" % (
            item["name"], item["expected"], item["actual"], "OK" if item["ok"] else "MISMATCH"))
    for key, label in (("bySourceReportedYear", "按 source_reported_at 年度"),
                       ("byBusinessType", "按业务类型"),
                       ("byComplaintType", "按诉求类型"),
                       ("byDistrictNull", "district_code 空值"),
                       ("bySourceLogResult", "source_log 结果分布")):
        log("   %s: %s" % (label, json.dumps(verify.get(key) or {}, ensure_ascii=False)))


def main(argv=None) -> int:
    global REPORT_DIR
    parser = argparse.ArgumentParser(description="2025/2026 水气全量诉求导入 gqxq 平台")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="只解析+校验+出报告，不投递")
    mode.add_argument("--apply", action="store_true", help="真实投递入站接口")
    mode.add_argument("--verify-only", action="store_true", help="只跑只读 SQL 核对并出报告")
    parser.add_argument("--start", type=int, default=1, help="从第几条开始（1 起，按源顺序）")
    parser.add_argument("--limit", type=int, default=None, help="本次最多处理多少条")
    parser.add_argument("--chunk", type=int, default=SLICE_SIZE, help="切片大小（进度分段提示用）")
    parser.add_argument("--report", type=str, default=None, help="报告目录（默认 server/.dev-logs/import-2025-2026/reports）")
    parser.add_argument("--checkpoint", type=str, default=None, help="checkpoint 文件路径")
    parser.add_argument("--allow-errors", action="store_true", help="dry-run 存在校验错误时仍允许 apply")
    parser.add_argument("--no-verify", action="store_true", help="apply 后不跑 SQL 核对")
    parser.add_argument("--concurrency", type=int, default=1,
                        help="并发投递线程数（默认 1=严格顺序；>1 时仍按源顺序入队，同一 sourceId 只投一次）")
    parser.add_argument("--reset-checkpoint", action="store_true", help="备份并忽略已有 checkpoint，从头开始")
    args = parser.parse_args(argv)

    if args.report:
        REPORT_DIR = os.path.abspath(args.report)
    os.makedirs(REPORT_DIR, exist_ok=True)

    log("=" * 72)
    log("[init] 脚本版本 %s" % SCRIPT_VERSION)
    log("[init] 服务根目录 %s" % SERVER_DIR)
    log("[init] 报告目录 %s" % REPORT_DIR)

    district_map, district_source = load_district_map()
    log("[init] 区划字典：%s" % district_source)
    if "高新区" in district_map:
        log("[init] 高新区 -> %s" % district_map["高新区"])

    t_parse = time.time()
    records, stats = build_records(district_map)
    log("[parse] 源行 %d，唯一 sourceId %d，重复 %d，耗时 %.1fs" % (
        stats["totalSourceRows"], stats["uniqueSourceIds"], stats["duplicateCount"], time.time() - t_parse))
    log("[parse] 按年度 %s" % json.dumps(stats["byYear"], ensure_ascii=False))
    log("[parse] 业务类型 %s" % json.dumps(stats["byBusinessType"], ensure_ascii=False))
    log("[parse] 诉求类型 %s" % json.dumps(stats["byComplaintType"], ensure_ascii=False))
    log("[parse] 紧急程度 %s" % json.dumps(stats["byUrgencyLevel"], ensure_ascii=False))
    log("[parse] districtCode 为空 %d 条；标题手机号脱敏 %d 条；事发地括号剥离 %d 条" % (
        stats["districtNullCount"], stats["titlePhoneMasked"], stats["addressParenStripped"]))
    log("[parse] 校验错误 %d 条（明细 issues.jsonl，前20条如下）" % len(stats["issues"]))
    for item in stats["issues"][:20]:
        log("   issue: %s" % json.dumps(item, ensure_ascii=False))

    if args.verify_only:
        verify = sql_verify(records)
        ckpt_path = args.checkpoint or os.path.join(REPORT_DIR, "checkpoint.json")
        cp = load_json(ckpt_path, {}) or {}
        prev = load_json(os.path.join(REPORT_DIR, "import-report.json"), {}) or {}
        prev_delivery = prev.get("delivery") or {}
        if prev_delivery.get("mode") != "apply":
            prev_delivery = {"mode": "apply"}
        run = dict(prev_delivery)
        run["cumulative"] = cp.get("counters") or run.get("cumulative") or {}
        run["cumulativeDone"] = cp.get("doneCount") or run.get("cumulativeDone") or 0
        run["verifiedAt"] = now_iso()
        if not run.get("probe") and verify.get("probeLogResult", {}).get("result"):
            run["probe"] = {"sourceId": PROBE_SOURCE_ID, "result": verify["probeLogResult"]["result"]}
        report = write_report(stats, run, district_source, verify)
        print_verify(verify)
        log("[verify] 报告：%s" % json.dumps(report.get("_paths", {}), ensure_ascii=False))
        return 0 if verify.get("allOk") else 1

    if args.dry_run:
        run = {"mode": "dry-run", "startedAt": now_iso(), "window": {"start": args.start, "limit": args.limit}}
        report = write_report(stats, run, district_source, None)
        log("[dry-run] 报告：%s" % json.dumps(report.get("_paths", {}), ensure_ascii=False))
        return 0 if not stats["issues"] else 2

    if stats["issues"] and not args.allow_errors:
        log("[abort] 存在 %d 条校验错误，拒绝 apply（--allow-errors 可强制）" % len(stats["issues"]))
        return 3
    if args.reset_checkpoint:
        ckpt = args.checkpoint or os.path.join(REPORT_DIR, "checkpoint.json")
        if os.path.isfile(ckpt):
            backup = ckpt + ".bak-" + dt.datetime.now().strftime("%Y%m%d%H%M%S")
            os.replace(ckpt, backup)
            log("[apply] 旧 checkpoint 已备份 -> %s" % os.path.basename(backup))

    run = do_apply(records, args, stats)

    verify = None
    if not args.no_verify:
        try:
            verify = sql_verify(records)
            print_verify(verify)
        except Exception as exc:  # noqa: BLE001
            log("[verify][warn] 核对失败：%s" % exc)
            traceback.print_exc()

    report = write_report(stats, run, district_source, verify)
    log("[done] 报告：%s" % json.dumps(report.get("_paths", {}), ensure_ascii=False))
    return 0 if run["error"] == 0 else 4


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log("")
        log("[interrupt] 已中断，checkpoint 保留（下次 --apply 自动续跑）")
        sys.exit(130)
