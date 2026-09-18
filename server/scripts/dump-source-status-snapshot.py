#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""dump-source-status-snapshot.py —— 从宜接就办导出 .xls 里只抽两列，生成来源状态快照 JSON。

产物（**只这两列，不含任何 PII**）：
    { "<案件公文号>": "<督办状态中文>", ... }

用途：喂给 GQXQ_YJJB_ADAPTER=file（见 src/adapters/fileSourceAdapter.ts），
让「来源快照」作为一等适配器被既有的 POST /complaints/:idOrNo/source-sync 消费。
写 source_event_status 的仍然只有 sourceStatusService -> sourceSyncRepo 那一条路径。

用法：
    python scripts/dump-source-status-snapshot.py --out <仓库外的路径.json>
    可选：--file <xls>     覆盖默认源文件
          --report <路径>  旁路报告（默认 <out>.report.txt）

为什么单独一个脚本、不复用 import-yijiejieban-export.py：
    那个脚本负责"全字段入总账"，本脚本负责"两列出快照"，目的与生命周期都不同
    （快照可反复重新生成）。故意不共用代码，改一个不会动到另一个。

重复键：源文件里 DH202604060770 出现 3 次（超期结案 / 正常结案 / 正常结案）。
    JSON 对象一个键只能有一个值，这里**取最后一行**——与平台侧已有的幂等收敛规则一致
    （重复投递时后到的报文覆盖前者），所以快照与库里的末态是同一个来源口径。
    被覆盖的键与它的全部取值都写进旁路报告，绝不静默丢弃。

输出编码：文件一律 utf-8；stdout 只打 ASCII，避免 GBK 控制台把中文打乱。
"""
import argparse
import collections
import datetime
import json
import os
import sys

try:
    import xlrd
except ImportError:
    sys.stderr.write('missing xlrd: pip install xlrd==2.0.1\n')
    sys.exit(3)

# 注意：路径是 raw string（Windows 反斜杠），因此中文文件名不能用 \uXXXX 转义
# （raw string 不解释转义），改用 os.path.join 拼一个字面量文件名。
DEFAULT_XLS = os.path.join(
    r'C:\Users\18806\.dsh\attachments\v1\files\ff\ffff5419f039148c4c2960e29dfbea524f04bbe556e7a0ad8b913aa6431ae452',
    '20260917170900综合查询.xls',
)
KEY_COLUMN = '案件公文号'
STATUS_COLUMN = '督办状态'
HEADER_ROW = 1      # 0 基：第 2 行是表头
FIRST_DATA_ROW = 2  # 0 基：第 3 行起是数据


def cell_text(value):
    if value is None:
        return ''
    if isinstance(value, float):
        return str(int(value)) if value == int(value) else repr(value)
    return str(value).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--file', default=DEFAULT_XLS)
    ap.add_argument('--out', required=True)
    ap.add_argument('--report', default=None)
    args = ap.parse_args()

    if not os.path.exists(args.file):
        sys.stderr.write('[dump] source xls not found: %s\n' % args.file)
        return 2

    book = xlrd.open_workbook(args.file)
    sheet = book.sheet_by_index(0)
    header = [cell_text(sheet.cell_value(HEADER_ROW, c)) for c in range(sheet.ncols)]
    if KEY_COLUMN not in header or STATUS_COLUMN not in header:
        sys.stderr.write('[dump] header missing required column\n')
        return 2
    key_idx = header.index(KEY_COLUMN)
    status_idx = header.index(STATUS_COLUMN)

    ordered = collections.OrderedDict()
    collisions = collections.OrderedDict()
    status_counts = collections.Counter()
    rows = 0
    skipped_empty_key = 0
    skipped_empty_status = 0

    for r in range(FIRST_DATA_ROW, sheet.nrows):
        key = cell_text(sheet.cell_value(r, key_idx))
        status = cell_text(sheet.cell_value(r, status_idx))
        if key == '':
            skipped_empty_key += 1
            continue
        rows += 1
        if status == '':
            # 空状态 = 来源对该案卷没有给出状态，等价于"没有该事件"。
            # 不写进快照（写空值会让整个快照在适配器加载期被判结构不合法），
            # 但计入报告，绝不静默丢弃。
            skipped_empty_status += 1
            continue
        status_counts[status] += 1
        if key in ordered:
            collisions.setdefault(key, []).append(ordered[key])
        ordered[key] = status  # 后到覆盖先到

    if len(ordered) == 0:
        sys.stderr.write('[dump] no usable rows: refusing to write an empty snapshot\n')
        return 3

    out_dir = os.path.dirname(os.path.abspath(args.out))
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as fh:
        json.dump(ordered, fh, ensure_ascii=False, indent=2)
        fh.write('\n')

    report_path = args.report or (args.out + '.report.txt')
    lines = []
    lines.append('来源状态快照生成报告（只含案件公文号与督办状态两列）')
    lines.append('生成时间: %s' % datetime.datetime.now().isoformat(timespec='seconds'))
    lines.append('源文件: %s' % args.file)
    lines.append('工作表: %s（表头第 %d 行，数据自第 %d 行）' % (sheet.name, HEADER_ROW + 1, FIRST_DATA_ROW + 1))
    lines.append('读入数据行: %d' % rows)
    lines.append('写出唯一案件公文号: %d' % len(ordered))
    lines.append('跳过（案件公文号为空）: %d' % skipped_empty_key)
    lines.append('跳过（督办状态为空）: %d' % skipped_empty_status)
    lines.append('')
    lines.append('督办状态取值分布（原文，未经任何加工；按**数据行**统计，故含重复键的各行）:')
    for value, count in status_counts.most_common():
        lines.append('  %s  %d' % (value, count))
    lines.append('')
    lines.append('重复键（JSON 一键一值，取最后一行）: %d 个' % len(collisions))
    for key, previous in collisions.items():
        lines.append('  %s: %s -> 最终 %s' % (key, ' / '.join(previous), ordered[key]))
    if not collisions:
        lines.append('  （无）')
    with open(report_path, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(lines) + '\n')

    print('[dump] rows=%d keys=%d duplicates=%d skipped_empty_key=%d skipped_empty_status=%d'
          % (rows, len(ordered), len(collisions), skipped_empty_key, skipped_empty_status))
    print('[dump] wrote %s' % args.out)
    print('[dump] report %s' % report_path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
