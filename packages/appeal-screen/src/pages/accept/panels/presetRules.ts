/**
 * 验收大屏 · 四按钮（标书 1.2.6/1.2.7/1.2.8/1.2.10/1.2.11）的**预设规则口径**
 *
 * 规则已由主线落库并发布（version=2，2026-11-17 实测）：
 *   冬季保供 g08 燃气气压 / 夏季保畅 w04 水压 / 计划性停气 g06 / 计划性停水 w01。
 * 阈值推导与规则名以主线实测为准；后端核算响应只返回 ruleId/name/status/reason/count，
 * 不含阈值与窗口，因此卡片上的「阈值 / 窗口」用本文件的预设口径补齐并明确标注「已发布规则」。
 * 燃气三件套（gas_three_piece）**不落库**：定义与分类映射未业务确认，UI 只显示「待业务确认」。
 */

export type AlertScene = 'winter' | 'summer' | 'planned_shutdown' | 'gas_three_piece';

export const SCENE_LABELS: Record<string, string> = {
  winter: '冬季保供',
  summer: '夏季保畅',
  planned_shutdown: '计划性停水停气',
  gas_three_piece: '燃气三件套安装',
};

export interface PresetRule {
  ruleId: string;
  kind: 'seasonal' | 'alert';
  scene: AlertScene;
  sceneLabel: string;
  businessType: 'gas' | 'water';
  /** 分类限定（标书口径） */
  category: string;
  categoryLabel: string;
  /** 阈值（件）；seasonal 无阈值 */
  threshold: number | null;
  /** 统计窗口（天）；seasonal 用 startMonth~endMonth */
  windowDays: number | null;
  /** 窗口/保障期展示文案 */
  windowText: string;
  /** 阈值推导（主线实测口径） */
  thresholdBasis: string | null;
}

export const PRESET_RULES: PresetRule[] = [
  {
    ruleId: 'seasonal-winter-gas-pressure',
    kind: 'seasonal',
    scene: 'winter',
    sceneLabel: '冬季保供',
    businessType: 'gas',
    category: 'g08',
    categoryLabel: '燃气气压问题(g08)',
    threshold: null,
    windowDays: null,
    windowText: '保障期 11 月–次年 3 月（含）',
    thresholdBasis: null,
  },
  {
    ruleId: 'seasonal-summer-water-pressure',
    kind: 'seasonal',
    scene: 'summer',
    sceneLabel: '夏季保畅',
    businessType: 'water',
    category: 'w04',
    categoryLabel: '水压问题(w04)',
    threshold: null,
    windowDays: null,
    windowText: '保障期 6–9 月（含）',
    thresholdBasis: null,
  },
  {
    ruleId: 'alert-winter-gas-pressure',
    kind: 'alert',
    scene: 'winter',
    sceneLabel: '冬季保供',
    businessType: 'gas',
    category: 'g08',
    categoryLabel: '燃气气压问题(g08)',
    threshold: 7,
    windowDays: 7,
    windowText: '7 日窗口',
    thresholdBasis: 'g08 周均 4.3 × 1.5 = 7 件',
  },
  {
    ruleId: 'alert-summer-water-pressure',
    kind: 'alert',
    scene: 'summer',
    sceneLabel: '夏季保畅',
    businessType: 'water',
    category: 'w04',
    categoryLabel: '水压问题(w04)',
    threshold: 16,
    windowDays: 7,
    windowText: '7 日窗口',
    thresholdBasis: 'w04 周均 10.1 × 1.5 = 16 件',
  },
  {
    ruleId: 'alert-planned-shutdown-gas',
    kind: 'alert',
    scene: 'planned_shutdown',
    sceneLabel: '计划性停水停气',
    businessType: 'gas',
    category: 'g06',
    categoryLabel: '停气问题(g06)',
    threshold: 16,
    windowDays: 3,
    windowText: '3 日窗口',
    thresholdBasis: 'g06 日均 2.56 × 3 日 × 2 = 16 件',
  },
  {
    ruleId: 'alert-planned-shutdown-water',
    kind: 'alert',
    scene: 'planned_shutdown',
    sceneLabel: '计划性停水停气',
    businessType: 'water',
    category: 'w01',
    categoryLabel: '城镇停水(w01)',
    threshold: 29,
    windowDays: 3,
    windowText: '3 日窗口',
    thresholdBasis: 'w01 日均 4.75 × 3 日 × 2 = 29 件',
  },
];

export const PRESET_RULE_MAP: Record<string, PresetRule> = Object.fromEntries(PRESET_RULES.map((r) => [r.ruleId, r]));

export function presetOf(ruleId: string | null | undefined): PresetRule | null {
  if (!ruleId) return null;
  return PRESET_RULE_MAP[ruleId] ?? null;
}

/** 预警场景（顶部四场景 chip）：三件套固定「待业务确认」 */
export const ALERT_SCENES: { scene: AlertScene; label: string; note: string }[] = [
  { scene: 'winter', label: '冬季保供', note: 'g08 燃气气压 · 7 件 / 7 日' },
  { scene: 'summer', label: '夏季保畅', note: 'w04 水压 · 16 件 / 7 日' },
  { scene: 'planned_shutdown', label: '计划性停水停气', note: 'g06 停气 16 件 / w01 停水 29 件 · 3 日' },
  { scene: 'gas_three_piece', label: '燃气三件套安装', note: '定义与分类映射待业务确认（系统拒绝未确认落库）' },
];

export const GAS_THREE_PIECE_NOTE = '定义与分类映射待业务确认（规则引擎要求 definitionConfirmed=true；系统拒绝在未确认时落库）';

/** 网格对比：后端返回的是 major 大类（不是 g01/w01 小类），这里给出字典中文名 */
export const MAJOR_CATEGORY_LABELS: Record<string, string> = {
  water_service: '供水服务（大类）',
  gas_service: '供气服务（大类）',
};

export function majorCategoryLabel(code: string): string {
  return MAJOR_CATEGORY_LABELS[code] ?? code;
}

/** 停供与施工：正式接口未接入，先给字段口径（标书 1.2.6/1.2.7） */
export const EVENT_TABS = [
  { key: 'shutdown', label: '停水停气' },
  { key: 'construction', label: '管道施工改造' },
] as const;

export const EVENT_FIELDS = [
  { key: 'enterprise', label: '企业', desc: '责任企业（多家企业时按企业分行或分列）' },
  { key: 'businessType', label: '业务类型', desc: '计划停水 / 突发停水 / 计划停气 / 突发停气 / 管线施工' },
  { key: 'timeRange', label: '时间范围', desc: '事件开始 – 结束时间（来源业务时间）' },
  { key: 'households', label: '涉及户数', desc: '影响范围内的服务户数' },
  { key: 'demandCount', label: '产生诉求量', desc: '事件关联诉求件数（事件级 / 网格级分开统计）' },
] as const;

export const EVENTS_PENDING_TEXT =
  '事件数据待对接：正式接口尚未提供停供/施工事件数据（库内仅 2 条样例行，不作为正式数据展示）。' +
  '字段口径已就绪：企业 / 业务类型 / 时间范围 / 涉及户数 / 产生诉求量；接入后按网格关联展示，缺失不补 0。';