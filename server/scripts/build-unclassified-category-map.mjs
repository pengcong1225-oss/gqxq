#!/usr/bin/env node
/**
 * 1.1.7 精准分类 —— 464 条未分类诉求的「来源类型 → 平台正式大小类」映射草案（只读）
 *
 * 背景：审查报告（01-后台A-诉求数据与详情.md §1.1.7）实测 complaint 表
 * 21,574 条中 464 条 major_category_code 为 NULL（2026-09 批次，宜接就办来源）。
 * 这 464 条在 complaint.source_major_category_code / source_minor_category_code 里没有
 * 保存来源分类编码，但每条最新一条 complaint_source_log.payload.metadata 中有来源系统原始
 * 三层类型名：案件主类型名 / 案件二级类型名 / 案件类型名。
 *
 * 本脚本只读 complaint + complaint_source_log，按字典 complaint_category v20（19 项）
 * 生成「建议 major / minor + 依据」CSV，供业务确认后再决定是否落库。
 * 不写任何数据库行；不修改 complaint；不猜测无依据的类型。
 *
 * 用法（在 gqxq/server 下）：
 *   npx tsx scripts/build-unclassified-category-map.mjs
 *   npx tsx scripts/build-unclassified-category-map.mjs --out=<csv路径> [--deliverables=<目录>]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

function argValue(name) {
  const prefix = '--' + name + '=';
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length) ?? null;
}
function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error('缺少环境变量 ' + name + '（请在 server/.env 中配置）');
  return String(v).trim();
}
const DELIVERABLES_DIR = resolve(
  argValue('deliverables') ||
    process.env.GQXQ_DELIVERABLES_DIR ||
    'D:/deepSeekHerness/zhuxinServer/deliverables/标书符合性审查-20261118',
);
const OUT_PATH = resolve(argValue('out') || resolve(DELIVERABLES_DIR, '464未分类映射草案.csv'));

const dbConfig = {
  host: process.env.GQXQ_DB_HOST || '127.0.0.1',
  port: Number(process.env.GQXQ_DB_PORT || 3306),
  user: requireEnv('GQXQ_DB_USER'),
  password: process.env.GQXQ_DB_PASSWORD || '',
  database: requireEnv('GQXQ_DB_NAME'),
  charset: 'utf8mb4',
  timezone: '+08:00',
};

/**
 * 来源三级类型（案件类型名）→ 平台小类编码。
 * 依据：字典 complaint_category v20 的 item_label 与来源类型名逐字核对；
 * 农村/城镇细分在平台字典中没有对应小项，按业务性质归并到城镇小类（需业务确认）。
 */
const MINOR_RULES = [
  { source: '燃气报装点火问题', minor: 'g04', kind: 'exact', note: '' },
  { source: '燃气服务问题投诉', minor: 'g01', kind: 'exact', note: '' },
  { source: '燃气费用问题投诉（含捆绑销售）', minor: 'g02', kind: 'exact', note: '' },
  { source: '燃气施工问题', minor: 'g03', kind: 'exact', note: '' },
  { source: '燃气报损报修问题', minor: 'g05', kind: 'exact', note: '' },
  { source: '停气问题', minor: 'g06', kind: 'exact', note: '' },
  { source: '燃气业务查询', minor: 'g07', kind: 'exact', note: '' },
  { source: '城镇停水问题', minor: 'w01', kind: 'exact', note: '' },
  { source: '农村停水问题', minor: 'w01', kind: 'merged', note: '平台字典无「农村停水」独立小类，按供水停水性质归入 w01 城镇停水问题' },
  { source: '用水费用问题投诉', minor: 'w02', kind: 'exact', note: '' },
  { source: '农村供水费用问题', minor: 'w02', kind: 'merged', note: '平台字典无「农村供水费用」独立小类，按用水费用性质归入 w02' },
  { source: '水质问题投诉', minor: 'w03', kind: 'exact', note: '' },
  { source: '农村水质问题投诉', minor: 'w03', kind: 'merged', note: '平台字典无「农村水质」独立小类，按水质性质归入 w03' },
  { source: '水压问题投诉', minor: 'w04', kind: 'exact', note: '' },
  { source: '农村供水水压问题', minor: 'w04', kind: 'merged', note: '平台字典无「农村供水水压」独立小类，按水压性质归入 w04' },
  { source: '城镇用水问题', minor: 'w05', kind: 'exact', note: '' },
  { source: '用水服务问题投诉', minor: 'w06', kind: 'exact', note: '' },
  { source: '供水施工挖断问题', minor: 'w07', kind: 'exact', note: '' },
  { source: '城镇用水报损报修问题', minor: 'w08', kind: 'exact', note: '' },
  { source: '农村供水报损报修问题', minor: 'w08', kind: 'merged', note: '平台字典无「农村供水报损报修」独立小类，按报损报修性质归入 w08' },
];
const MINOR_BY_SOURCE = new Map(MINOR_RULES.map((r) => [r.source, r]));

const MAJOR_BY_SOURCE_SECOND = {
  '供水服务': 'water_service',
  '供气服务': 'gas_service',
};
const MAJOR_BY_BUSINESS = { water: 'water_service', gas: 'gas_service' };

const toText = (v) => {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

const conn = await mysql.createConnection(dbConfig);
try {
  const [dictRows] = await conn.query(
    'select item_value, item_label, parent_code, status, published, version from dict_item where dict_type = ? order by item_value',
    ['complaint_category'],
  );
  const [dictTypeRows] = await conn.query(
    'select dict_type, dict_name, version, published from dict_type where dict_type = ?',
    ['complaint_category'],
  );
  const dict = new Map(dictRows.map((r) => [String(r.item_value), r]));
  const version = dictTypeRows[0]?.version ?? null;
  const majorNames = new Map(
    dictRows.filter((r) => r.parent_code == null).map((r) => [String(r.item_value), String(r.item_label)]),
  );
  const minorNames = new Map(
    dictRows.filter((r) => r.parent_code != null).map((r) => [String(r.item_value), String(r.item_label)]),
  );
  if (!dict.has('water_service') || !dict.has('gas_service')) throw new Error('字典 complaint_category 缺少大类编码，停止');

  const [unclassified] = await conn.query(
    'select complaint_id, business_type, complaint_type, source_system, source_major_category_code, source_minor_category_code, received_at ' +
      'from complaint where major_category_code is null and deleted = 0 order by complaint_id',
  );
  const [beforeCount] = await conn.query(
    'select count(*) total from complaint where major_category_code is null and deleted = 0',
  );

  const [logs] = await conn.query(
    'select complaint_id, payload, received_at, id from complaint_source_log ' +
      'where complaint_id in (select complaint_id from complaint where major_category_code is null and deleted = 0) ' +
      'order by complaint_id, received_at desc, id desc',
  );
  const latestLog = new Map();
  for (const row of logs) if (!latestLog.has(row.complaint_id)) latestLog.set(String(row.complaint_id), row);

  const rows = [];
  const missingLog = [];
  const conflicts = [];
  const unmappedSourceTypes = new Map();
  const minorCounts = new Map();
  const majorCounts = new Map();

  for (const c of unclassified) {
    const complaintId = String(c.complaint_id);
    const log = latestLog.get(complaintId);
    const sourceBiz = String(c.business_type ?? '');
    if (!log) {
      missingLog.push(complaintId);
      rows.push({
        complaint_id: complaintId,
        sourceMajor: '',
        sourceSecond: '',
        sourceThird: '',
        businessType: sourceBiz,
        complaintType: c.complaint_type,
        major: '',
        minorMajorName: '',
        minor: '',
        minorName: '',
        confidence: '低',
        reason: '无 complaint_source_log，无法取得来源类型；需人工指定',
        anomaly: '来源日志缺失',
      });
      continue;
    }
    let metadata = null;
    try {
      const payload = JSON.parse(toText(log.payload) || '{}');
      metadata = payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : null;
    } catch {
      metadata = null;
    }
    const sourceMajor = metadata?.['案件主类型名'] != null ? String(metadata['案件主类型名']) : '';
    const sourceSecond = metadata?.['案件二级类型名'] != null ? String(metadata['案件二级类型名']) : '';
    const sourceThird = metadata?.['案件类型名'] != null ? String(metadata['案件类型名']) : '';
    const sourceComplaintType = metadata?.['诉求类型'] != null ? String(metadata['诉求类型']) : '';

    const majorFromSource = MAJOR_BY_SOURCE_SECOND[sourceSecond] ?? null;
    const majorFromBusiness = MAJOR_BY_BUSINESS[sourceBiz] ?? null;
    let major = majorFromSource ?? majorFromBusiness;
    const rule = MINOR_BY_SOURCE.get(sourceThird) ?? null;
    const minor = rule?.minor ?? '';
    let confidence = rule ? (rule.kind === 'exact' ? '高' : '中') : '低';
    const anomaly = [];
    let reason = '';

    if (majorFromSource && majorFromBusiness && majorFromSource !== majorFromBusiness) {
      anomaly.push('来源二级类型与 business_type 不一致（' + sourceSecond + ' vs ' + sourceBiz + '）');
      confidence = '低';
    }
    if (!major) {
      confidence = '低';
      anomaly.push('来源二级类型与 business_type 均无法映射大类');
    }
    if (rule) {
      const ruleMajor = String(minor).startsWith('g') ? 'gas_service' : String(minor).startsWith('w') ? 'water_service' : null;
      if (major && ruleMajor && ruleMajor !== major) {
        anomaly.push('来源三级类型映射的小类归属与建议大类不一致');
        confidence = '低';
        major = ruleMajor;
      }
      reason =
        rule.kind === 'exact'
          ? '来源三级类型「' + sourceThird + '」与字典 v' + version + ' 小类 ' + minor + '「' + (minorNames.get(minor) ?? '') + '」名称精确对应；来源二级类型「' + sourceSecond + '」→ ' + major
          : '来源三级类型「' + sourceThird + '」与字典 v' + version + ' 小类无同名项，' + rule.note + '；来源二级类型「' + sourceSecond + '」→ ' + major + '，映射归并需业务确认';
    } else {
      unmappedSourceTypes.set(sourceThird || '(空)', (unmappedSourceTypes.get(sourceThird || '(空)') ?? 0) + 1);
      anomaly.push('来源三级类型在字典 v' + version + ' 无对应小类，需业务人工判定 minor');
      reason = '来源三级类型「' + sourceThird + '」在字典 v' + version + ' 无对应小类；建议大类取自来源二级类型「' + sourceSecond + '」，minor 留空待人工判定';
    }
    if (!sourceSecond && !sourceThird) anomaly.push('来源日志 metadata 缺少案件类型字段');

    if (anomaly.length) conflicts.push({ complaintId, anomaly, major, minor, sourceThird });
    if (major) majorCounts.set(major, (majorCounts.get(major) ?? 0) + 1);
    minorCounts.set(minor || '(未定)', (minorCounts.get(minor || '(未定)') ?? 0) + 1);
    rows.push({
      complaint_id: complaintId,
      sourceMajor,
      sourceSecond,
      sourceThird,
      businessType: sourceBiz,
      complaintType: c.complaint_type,
      sourceComplaintType,
      major: major ?? '',
      majorName: major ? majorNames.get(major) ?? '' : '',
      minor,
      minorName: minor ? minorNames.get(minor) ?? '' : '',
      confidence,
      reason,
      anomaly: anomaly.join('；'),
    });
  }

  const headers = [
    'complaint_id',
    '来源主类型',
    '来源二级类型',
    '建议major',
    '建议minor',
    '依据',
    '来源三级类型',
    'business_type',
    '来源诉求类型',
    '建议大类名称',
    '建议小类名称',
    '置信度',
    '异常说明',
  ];
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.complaint_id,
        r.sourceMajor,
        r.sourceSecond,
        r.major,
        r.minor,
        r.reason,
        r.sourceThird,
        r.businessType,
        r.sourceComplaintType,
        r.majorName,
        r.minorName,
        r.confidence,
        r.anomaly,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');

  const [afterCount] = await conn.query(
    'select count(*) total from complaint where major_category_code is null and deleted = 0',
  );
  const dictCodesValid = [...majorCounts.keys(), ...minorCounts.keys()]
    .filter((c) => c !== '(未定)')
    .every((c) => dict.has(c) && Number(dict.get(c).published) === 1);
  const summary = {
    mode: 'read-only',
    database: dbConfig.database,
    output: OUT_PATH,
    dict: {
      type: 'complaint_category',
      version: version == null ? null : Number(version),
      typePublished: dictTypeRows[0] ? Number(dictTypeRows[0].published) : null,
      publishedItems: dictRows.filter((r) => Number(r.published) === 1).length,
      codesValid: dictCodesValid,
    },
    totalUnclassified: Number(beforeCount[0].total),
    rows: rows.length,
    mappedBoth: rows.filter((r) => r.major && r.minor).length,
    majorOnlyNeedsMinor: rows.filter((r) => r.major && !r.minor).length,
    unmapped: rows.filter((r) => !r.major).length,
    missingSourceLog: missingLog.length,
    anomalyRows: conflicts.length,
    anomaliesByType: Object.fromEntries(
      [...conflicts.reduce((m, c) => { for (const a of c.anomaly) m.set(a, (m.get(a) ?? 0) + 1); return m; }, new Map()).entries()],
    ),
    unmappedSourceTypes: [...unmappedSourceTypes.entries()].sort((a, b) => b[1] - a[1]),
    byMajor: Object.fromEntries([...majorCounts.entries()].sort((a, b) => b[1] - a[1])),
    byMinor: Object.fromEntries([...minorCounts.entries()].sort((a, b) => b[1] - a[1])),
    dbWriteCheck: {
      unclassifiedBefore: Number(beforeCount[0].total),
      unclassifiedAfter: Number(afterCount[0].total),
      unchanged: Number(beforeCount[0].total) === Number(afterCount[0].total),
    },
  };
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await conn.end();
}
