#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Analyze the two complaint xlsx exports (no PII printed, only aggregate counts)."""
import collections, json, os, re, sys
import openpyxl

SRC = [r"D:\知识库仓库\doctorWho\项目文档\住新服务平台\燃水燃气\诉求数据\2025年0101-1231水气全量诉求(含自办自结).xlsx",
       r"D:\知识库仓库\doctorWho\项目文档\住新服务平台\燃水燃气\诉求数据\2026年0101-1112水气全量诉求(含自办自结).xlsx"]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".dev-logs", "import-2025-2026", "masterdata")
OUT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../.dev-logs/import-2025-2026/masterdata"))
os.makedirs(OUT, exist_ok=True)

COLS = ['行政区划名称', '事发地', '主办单位', '大类', '中类', '小类', '事项分类', '行业主管部门', '诉求标题', '诉求内容']

def rows():
    for p in SRC:
        wb = openpyxl.load_workbook(p, data_only=True, read_only=False)
        ws = wb.worksheets[0]
        it = ws.iter_rows(min_row=3, values_only=True)
        header = [str(c).strip() if c is not None else '' for c in next(it)]
        idx = {h: i for i, h in enumerate(header)}
        for row in it:
            if row is None or all(v is None or str(v).strip() == '' for v in row):
                continue
            rec = {}
            for c in COLS:
                if c in idx:
                    v = row[idx[c]]
                    rec[c] = str(v).strip() if v is not None else ''
            yield os.path.basename(p), rec
        wb.close()

districts = collections.Counter()
depts = collections.Counter()
dept_by_district = collections.defaultdict(collections.Counter)
cats = collections.Counter()          # (大类,中类,小类)
midcats = collections.Counter()       # (大类,中类)
leaf_by_mid = collections.defaultdict(set)
items = collections.Counter()         # 事项分类
industry = collections.Counter()
n = 0
for _, r in rows():
    n += 1
    districts[r.get('行政区划名称', '')] += 1
    depts[r.get('主办单位', '')] += 1
    dept_by_district[r.get('主办单位', '')][r.get('行政区划名称', '')] += 1
    top, mid, leaf = r.get('大类', ''), r.get('中类', ''), r.get('小类', '')
    cats[(top, mid, leaf)] += 1
    midcats[(top, mid)] += 1
    leaf_by_mid[(top, mid)].add(leaf)
    items[r.get('事项分类', '')] += 1
    industry[r.get('行业主管部门', '')] += 1

payload = {
    'totalRows': n,
    'districts': districts.most_common(),
    'departments': [{'name': k, 'count': v, 'districts': dict(dept_by_district[k])} for k, v in depts.most_common()],
    'categories': [{'top': k[0], 'mid': k[1], 'leaf': k[2], 'count': v} for k, v in cats.most_common()],
    'midCategories': [{'top': k[0], 'mid': k[1], 'count': v, 'leaves': sorted(leaf_by_mid[k])} for k, v in midcats.most_common()],
    'itemCategories': items.most_common(),
    'industryDepartments': industry.most_common(),
}
with open(os.path.join(OUT, 'source-profile.json'), 'w', encoding='utf-8') as f:
    json.dump(payload, f, ensure_ascii=False, indent=2)
print('rows', n)
print('districts:', len(districts))
for k, v in districts.most_common():
    print('  ', repr(k), v)
print('departments:', len(depts))
for k, v in depts.most_common(80):
    print('  ', v, k)
print('mid categories:', len(midcats))
for (t, m), v in midcats.most_common():
    print('  ', v, t, '/', m, '->', sorted(leaf_by_mid[(t, m)]))
print('wrote', os.path.join(OUT, 'source-profile.json'))
