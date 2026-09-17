#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""import-yijiejieban-export.py —— 把「宜接就办」导出的综合查询 .xls 灌进诉求平台。

为什么用 Python：源文件是 BIFF8 的 .xls，server 侧没有任何依赖能免费读它
（server/package.json 只有 express / mysql2 / knex / zod 这类运行期依赖，
引入 xlsx 会把一个体积大、历史上多次出 CVE 的解析器拖进生产依赖树）。
本脚本是**一次性运维工具**：不进 tsc 构建、不进 node 运行时、不被任何服务 import。

为什么必须走 HTTP 入站接口，而不是直接 INSERT：
  只有 POST /external/yijiejieban/appeal 才能把真实链路全部走到——
  zod 报文校验、uk_source(source_system, source_id) 幂等裁决、complaint_source_log 留痕、
  规则引擎分类与敏感词命中、按日发号器、字段级受保护列拦截。
  直接写库等于绕开被测对象：那样只能证明"我会写 SQL"，证明不了"平台能接单"。

字段映射（左=导出表列，右=入站报文键）：
  案件公文号        -> sourceId            （唯一业务键，落 uk_source）
  来话内容          -> content
  详细地址          -> address
  区                -> districtName（再用 /dicts/district/items 精确匹配出 districtCode）
  录入时间          -> createdAt（补 +08:00 偏移；落 source_reported_at，编号仍按入库时间发）
  案件二级类型名     -> businessType（供水服务=water / 供气服务=gas）
  诉求类型          -> complaintType（六类，含 M10 新增的 help/other/praise）
  其余非 PII 列      -> metadata（不映射任何列，随整包落 complaint.source_payload，可追溯）
  案件类型名        -> 派生 title（去掉【…】前缀后取首句，≤120 字；本平台无标题列，属派生字段）

明确**不投递**的列（PII 最小化）：
  市民姓名 / 市民电话 —— 平台没有对应列，且无业务必要；留在源文件里即可。

用法：
  python scripts/import-yijiejieban-export.py --file <xls>              # 预演：解析+体检，不投递
  python scripts/import-yijiejieban-export.py --file <xls> --apply     # 真投递
  可选：--base http://127.0.0.1:3100/api/v1   --limit N   --start N
        --report <json 路径>   --retry N（瞬时错误重试次数，默认 2）
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

try:
    import xlrd
except ImportError:  # pragma: no cover
    sys.stderr.write('缺少 xlrd：pip install xlrd==2.0.1\n')
    sys.exit(3)

# ── 字典映射（与 server/src/domain/enums.ts 的 DICT 同源，脚本内自检是否与库中字典一致）──
COMPLAINT_TYPE = {
    '投诉类': 'complaint',
    '咨询类': 'consult',
    '建议类': 'suggest',
    '举报类': 'report',
    '求助类': 'help',
    '其他类': 'other',
    '表扬类': 'praise',
}
BUSINESS_TYPE = {'供水服务': 'water', '供气服务': 'gas'}

# 落 metadata 的列（非 PII，映射不掉的来源原值一律不丢）
METADATA_COLUMNS = [
    '案件类型名', '案件主类型名', '案件二级类型名', '区', '街道', '社区', '网格', '接线员',
    '在线办结依据', '部门名称', '二级单位', '处理结果', '规定完成时间', '实际完成时间',
    '坐席满意度', '环境因素', '督办状态', '诉求类型', '定位情况', '前台备注',
]
# 绝不投递：PII
PII_COLUMNS = ['市民姓名', '市民电话']

TITLE_MAX = 120          # 派生标题上限（complaint.title 是 varchar(255)，留足余量）
CONTENT_MAX = 20000      # 与入站 schema 的 content 上限一致
CHANNEL_PREFIXES = [('【省12345工单编号', '省12345'), ('【省退回重办', '省退回重办')]


def load_env(path):
    env = {}
    if not os.path.exists(path):
        return env
    with open(path, 'r', encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            env[key.strip()] = value.strip()
    return env


def cell_text(value):
    if value is None:
        return ''
    if isinstance(value, float):
        return str(int(value)) if value == int(value) else repr(value)
    return str(value).strip()


def read_rows(xls_path):
    book = xlrd.open_workbook(xls_path)
    sheet = book.sheet_by_index(0)
    header = [cell_text(sheet.cell_value(1, c)) for c in range(sheet.ncols)]
    rows = []
    for r in range(2, sheet.nrows):
        row = {}
        for c in range(sheet.ncols):
            row[header[c]] = cell_text(sheet.cell_value(r, c))
        row['__sheetRow'] = r + 1
        rows.append(row)
    return sheet.name, header, rows


def derive_title(content, case_type):
    text = re.sub(r'^【[^】]*】', '', content).strip()
    if not text:
        return case_type[:TITLE_MAX]
    first = re.split(r'[。！？!?\n]', text, maxsplit=1)[0].strip()
    if not first:
        return case_type[:TITLE_MAX]
    return first[:TITLE_MAX]


def derive_channel(content):
    for prefix, name in CHANNEL_PREFIXES:
        if content.startswith(prefix):
            return name
    return None


def map_business(row):
    value = row.get('案件二级类型名', '')
    if value in BUSINESS_TYPE:
        return BUSINESS_TYPE[value], 'exact'
    text = row.get('案件类型名', '') + row.get('来话内容', '')
    if '液化' in text:
        return 'lpg', 'keyword'
    if '燃气' in text or '天然气' in text:
        return 'gas', 'keyword'
    if '水' in text:
        return 'water', 'keyword'
    return None, 'unmapped'


def build_payload(row, district_by_name):
    business, how = map_business(row)
    complaint = COMPLAINT_TYPE.get(row.get('诉求类型', ''))
    content = row.get('来话内容', '')
    district_name = row.get('区', '') or None
    report_at = row.get('录入时间', '')
    payload = {
        'sourceId': row.get('案件公文号', ''),
        'title': derive_title(content, row.get('案件类型名', '')),
        'content': content,
        'address': row.get('详细地址', '') or None,
        'districtName': district_name,
        'districtCode': district_by_name.get(district_name) if district_name else None,
        'source': derive_channel(content),
        'businessType': business,
        'complaintType': complaint,
        'createdAt': (report_at.replace(' ', 'T') + '+08:00') if report_at else None,
        'metadata': {k: row.get(k, '') for k in METADATA_COLUMNS},
    }
    return payload, how


class Api:
    def __init__(self, base, token=None):
        self.base = base.rstrip('/')
        self.token = token

    def call(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode('utf-8')
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header('Content-Type', 'application/json; charset=utf-8')
        if self.token:
            req.add_header('Authorization', 'Bearer ' + self.token)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.status, json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as err:
            raw = err.read().decode('utf-8', 'replace')
            try:
                return err.code, json.loads(raw)
            except json.JSONDecodeError:
                return err.code, {'raw': raw[:500]}

    def login(self, username, password):
        status, body = self.call('POST', '/auth/login', {'username': username, 'password': password})
        if status != 200 or not isinstance(body, dict) or body.get('code') != 200:
            raise RuntimeError('登录失败 HTTP ' + str(status) + ' ' + json.dumps(body, ensure_ascii=False)[:300])
        self.token = body['data']['token']
        return body['data'].get('userInfo', {})

    def dict_items(self, code):
        status, body = self.call('GET', '/dicts/' + code + '/items')
        if status != 200 or not isinstance(body, dict) or body.get('code') != 200:
            raise RuntimeError('取字典 ' + code + ' 失败 HTTP ' + str(status))
        return body['data']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--file', required=True)
    parser.add_argument('--base', default='http://127.0.0.1:3100/api/v1')
    parser.add_argument('--env', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.env'))
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--start', type=int, default=0, help='从第 N 条数据（0 基）开始')
    parser.add_argument('--limit', type=int, default=0, help='最多投递 N 条（0=全部）')
    parser.add_argument('--retry', type=int, default=2)
    parser.add_argument('--report', default=None)
    args = parser.parse_args()

    env = load_env(args.env)
    sheet, header, rows = read_rows(args.file)
    print('[import] 文件=' + args.file)
    print('[import] sheet=' + sheet + ' 列=' + str(len(header)) + ' 数据行=' + str(len(rows)))
    print('[import] 模式=' + ('APPLY（真投递）' if args.apply else 'DRY-RUN（只解析）'))

    api = Api(args.base)
    username = env.get('GQXQ_BOOTSTRAP_ADMIN_USERNAME', '')
    password = env.get('GQXQ_BOOTSTRAP_ADMIN_PASSWORD', '')
    dict_codes = None
    district_by_name = {}
    try:
        info = api.login(username, password)
        print('[import] 已登录：' + str(info.get('username')) + ' / ' + str(info.get('realName')))
        district_items = api.dict_items('district')
        district_by_name = {item['label']: item['value'] for item in district_items}
        print('[import] 行政区划字典 ' + str(len(district_by_name)) + ' 项')
        type_items = api.dict_items('complaint_type')
        dict_codes = [item['value'] for item in type_items]
        print('[import] complaint_type 字典：' + ','.join(dict_codes))
    except Exception as exc:  # noqa: BLE001
        if args.apply:
            print('[import] 致命：APPLY 模式必须能连上服务并登录 -- ' + str(exc))
            return 1
        print('[import] 警告：未能连上服务（' + str(exc) + '），预演继续，但码位无法与库中字典比对')

    # ── 映射体检 ────────────────────────────────────────────────
    problems = []
    stats = {'exact': 0, 'keyword': 0, 'unmapped': 0, 'district_hit': 0, 'district_miss': 0,
             'channel': {}, 'type': {}, 'content_over': 0, 'title_empty': 0, 'addr_over': 0}
    payloads = []
    for row in rows:
        payload, how = build_payload(row, district_by_name)
        stats[how if how in ('exact', 'keyword') else 'unmapped'] += 1
        if payload['businessType'] is None:
            problems.append('行' + str(row['__sheetRow']) + ' 二级类型无法映射：' + repr(row.get('案件二级类型名')))
        if payload['complaintType'] is None:
            problems.append('行' + str(row['__sheetRow']) + ' 诉求类型无法映射：' + repr(row.get('诉求类型')))
        elif dict_codes is not None and payload['complaintType'] not in dict_codes:
            problems.append('行' + str(row['__sheetRow']) + ' 码位不在库中字典：' + payload['complaintType'])
        if payload['districtName']:
            if payload['districtCode']:
                stats['district_hit'] += 1
            else:
                stats['district_miss'] += 1
        stats['channel'][payload['source'] or '(无)'] = stats['channel'].get(payload['source'] or '(无)', 0) + 1
        stats['type'][row.get('诉求类型', '')] = stats['type'].get(row.get('诉求类型', ''), 0) + 1
        if len(payload['content'] or '') > CONTENT_MAX:
            stats['content_over'] += 1
        if not payload['title']:
            stats['title_empty'] += 1
        if len(payload['address'] or '') > 500:
            stats['addr_over'] += 1
        payloads.append(payload)

    ids = [p['sourceId'] for p in payloads]
    dup_map = {}
    for i in ids:
        dup_map[i] = dup_map.get(i, 0) + 1
    duplicates = {k: v for k, v in dup_map.items() if v > 1}

    print('[import] 业务类型映射：精确=' + str(stats['exact']) + ' 关键词兜底=' + str(stats['keyword']) +
          ' 无法映射=' + str(stats['unmapped']))
    print('[import] 诉求类型分布：' + json.dumps(stats['type'], ensure_ascii=False))
    print('[import] 渠道分布：' + json.dumps(stats['channel'], ensure_ascii=False))
    print('[import] 区名命中字典=' + str(stats['district_hit']) + ' 未命中=' + str(stats['district_miss']))
    print('[import] sourceId 唯一=' + str(len(dup_map)) + ' 重复键=' + json.dumps(duplicates))
    print('[import] 超长 content=' + str(stats['content_over']) + ' 空标题=' + str(stats['title_empty']) +
          ' 超长 address=' + str(stats['addr_over']))
    if problems:
        print('[import] 映射问题 ' + str(len(problems)) + ' 条：')
        for item in problems[:20]:
            print('    ' + item)
        print('[import] 存在无法映射的行，拒绝继续（绝不猜码位）。')
        return 2

    targets = payloads[args.start:]
    if args.limit > 0:
        targets = targets[:args.limit]
    print('[import] 本次投递 ' + str(len(targets)) + ' 条（start=' + str(args.start) + ' limit=' + str(args.limit) + ')')

    if not args.apply:
        print('[import] DRY-RUN 结束，未投递任何报文。首条样例：')
        print(json.dumps(targets[0], ensure_ascii=False, indent=2)[:1200] if targets else '(空)')
        return 0

    # ── 顺序投递（顺序必须确定：重复键的收敛结果取决于投递次序）──
    results = []
    started = time.time()
    for idx, payload in enumerate(targets):
        attempt = 0
        while True:
            attempt += 1
            status, body = api.call('POST', '/external/yijiejieban/appeal', payload)
            if status == 200 or (status < 500 and status != 429) or attempt > args.retry:
                break
            time.sleep(0.3 * attempt)
        entry = {'seq': idx, 'sourceId': payload['sourceId'], 'http': status}
        if isinstance(body, dict) and body.get('code') == 200 and isinstance(body.get('data'), dict):
            data = body['data']
            entry['result'] = data.get('result')
            entry['complaintId'] = data.get('complaintId')
            entry['complaintNo'] = data.get('complaintNo')
            entry['changedFields'] = data.get('changedFields')
            entry['warnings'] = data.get('warnings')
        else:
            entry['result'] = 'error'
            entry['error'] = json.dumps(body, ensure_ascii=False)[:400]
        results.append(entry)
        if (idx + 1) % 50 == 0 or idx + 1 == len(targets):
            print('[import] 进度 ' + str(idx + 1) + '/' + str(len(targets)) +
                  ' 用时 ' + str(round(time.time() - started, 1)) + 's')

    summary = {}
    for entry in results:
        summary[entry['result']] = summary.get(entry['result'], 0) + 1
    print('[import] 投递结果汇总：' + json.dumps(summary, ensure_ascii=False))
    errors = [e for e in results if e['result'] == 'error']
    if errors:
        print('[import] 失败 ' + str(len(errors)) + ' 条，前 5 条：')
        for e in errors[:5]:
            print('    ' + e['sourceId'] + ' http=' + str(e['http']) + ' ' + str(e.get('error'))[:240])
    updated = [e for e in results if e.get('result') == 'updated']
    if updated:
        print('[import] 覆盖更新 ' + str(len(updated)) + ' 条：')
        for e in updated:
            print('    ' + e['sourceId'] + ' -> ' + str(e['complaintId']) + ' changed=' + str(e.get('changedFields')))
    warn_rows = [e for e in results if e.get('warnings')]
    if warn_rows:
        seen = {}
        for e in warn_rows:
            for w in e['warnings']:
                seen[w] = seen.get(w, 0) + 1
        print('[import] 告警分布：')
        for w, n in sorted(seen.items(), key=lambda kv: -kv[1])[:10]:
            print('    ' + str(n) + 'x ' + w[:150])

    if args.report:
        report = {
            'file': args.file, 'base': args.base, 'appliedAt': datetime.now().isoformat(),
            'totalRows': len(rows), 'delivered': len(targets), 'start': args.start, 'limit': args.limit,
            'summary': summary, 'duplicateSourceIds': duplicates,
            'mappingStats': stats, 'results': results,
        }
        with open(args.report, 'w', encoding='utf-8') as fh:
            json.dump(report, fh, ensure_ascii=False, indent=2)
        print('[import] 明细报告已写入 ' + args.report)
    return 0


if __name__ == '__main__':
    sys.exit(main())
