/** 统计大屏配色 / 字体 / ECharts 公共样式 */

export const C = {
  bg0: '#040b16',
  bg1: '#071528',
  panelBg: 'rgba(8, 26, 46, 0.88)',
  panelBgSoft: 'rgba(11, 33, 56, 0.72)',
  border: 'rgba(52, 152, 219, 0.35)',
  borderStrong: 'rgba(53, 224, 255, 0.55)',
  cyan: '#35e0ff',
  cyanDeep: '#19b8d8',
  text: '#dceeff',
  sub: '#8fb6d3',
  muted: '#5d7f9b',
  water: '#19d3f0',
  gas: '#f5a623',
  red: '#ff5b5b',
  orange: '#ff9f43',
  yellow: '#ffd166',
  green: '#2ecc71',
  purple: '#a68bff',
  grid: 'rgba(96, 156, 196, 0.16)',
} as const;

/** 4K/拼接屏可读性：所有字号按 1920 设计稿写，靠 transform scale 与 canvas DPR 放大 */
export const FONT_FAMILY = "'Bahnschrift', 'DIN Alternate', system-ui, 'Microsoft YaHei', sans-serif";

export const CHART_TEXT = {
  fontFamily: FONT_FAMILY,
  color: C.sub,
  fontSize: 15,
};

export function axisCommon(showSplitLine = true) {
  return {
    axisLine: { lineStyle: { color: C.border } },
    axisTick: { show: false },
    axisLabel: { color: C.sub, fontSize: 14, fontFamily: FONT_FAMILY },
    splitLine: showSplitLine
      ? { show: true, lineStyle: { color: C.grid, type: 'dashed' as const } }
      : { show: false },
  };
}

export function baseTooltip(extra: Record<string, unknown> = {}) {
  return {
    trigger: 'axis' as const,
    confine: true,
    backgroundColor: 'rgba(4, 16, 30, 0.95)',
    borderColor: C.borderStrong,
    borderWidth: 1,
    padding: [8, 12],
    textStyle: { color: C.text, fontSize: 15, fontFamily: FONT_FAMILY },
    axisPointer: {
      type: 'shadow' as const,
      shadowStyle: { color: 'rgba(53, 224, 255, 0.08)' },
      lineStyle: { color: C.cyan },
    },
    ...extra,
  };
}

export function baseGrid(extra: Record<string, unknown> = {}) {
  return { left: 56, right: 24, top: 34, bottom: 34, containLabel: true, ...extra };
}

/** 与整体缩放一致的 canvas 像素比，保证 4K/拼接屏不糊 */
export function designScale(): number {
  if (typeof window === 'undefined') return 1;
  return Math.min(window.innerWidth / 1920, window.innerHeight / 1080) || 1;
}

export function chartDpr(): number {
  const base = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  return Math.min(3, base * Math.max(1, designScale()));
}
