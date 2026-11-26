/** 验收大屏场景名称、保障季研判文案和事件字段。 */

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
];

export const ALERT_SCENES: AlertScene[] = ['winter', 'summer', 'planned_shutdown', 'gas_three_piece'];

/** 网格对比：后端返回的是 major 大类（不是 g01/w01 小类），这里给出字典中文名 */
export const MAJOR_CATEGORY_LABELS: Record<string, string> = {
  water_service: '供水服务（大类）',
  gas_service: '供气服务（大类）',
};

export function majorCategoryLabel(code: string): string {
  return MAJOR_CATEGORY_LABELS[code] ?? code;
}

/** 停供与施工：两类事件均已接入真实数据，此处保留字段口径定义（标书 1.2.6/1.2.7） */
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

/**
 * 停供与施工事件的说明文案（已由「待对接」更新为「已接入」）。
 *
 * 现状：停水停气走 `/assessment/shutdown-layer`（157 条真实事件 / 291 打点 / 22 网格），
 * 管道施工走 `/assessment/pipeline-layer`（燃气/供水双图层，按涉及网格着色）。
 * 交互入口在地图上，点击打点或色块查看事件详情。
 */
export const EVENTS_PENDING_TEXT =
  '两类事件均已接入真实数据：停水停气 157 条（291 个打点 / 22 个网格，四类分层可切换），' +
  '管道施工改造按涉及网格在燃气/供水双图层上着色。' +
  '在地图上点击打点或色块即可查看事件详情（企业 / 业务类型 / 时间范围 / 涉及户数 / 影响区域 / 应急预案 / 网格历史 / 相关诉求）。' +
  '字段缺失时如实标注「未提供」，不补 0、不画虚构几何。';
