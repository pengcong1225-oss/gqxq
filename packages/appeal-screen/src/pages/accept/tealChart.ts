/**
 * 验收大屏 · 青绿科技感图表公共样式（8002 风格：深青底 + #86fbe7 高亮）
 * 只放 ECharts option 片段，具体图表在各自卡片里组装。
 */
export const TEAL = {
  bright: '#86fbe7',
  cyan: '#54d5bc',
  cyanDeep: '#2aa38f',
  text: '#d0eeea',
  sub: '#9bc9c5',
  muted: '#8ab9b0',
  grid: '#17443f',
  border: '#377b72',
  warn: '#ffd67c',
  red: '#ff8f8f',
  bg: 'rgba(3, 27, 26, 0.94)',
} as const;

export const TEAL_FONT = "'Bahnschrift', 'DIN Alternate', 'Microsoft YaHei', sans-serif";

export function tealTooltip() {
  return {
    trigger: 'axis' as const,
    confine: true,
    backgroundColor: TEAL.bg,
    borderColor: TEAL.bright,
    borderWidth: 1,
    padding: [6, 10],
    textStyle: { color: TEAL.text, fontSize: 12, fontFamily: TEAL_FONT },
    axisPointer: { type: 'shadow' as const, shadowStyle: { color: 'rgba(134, 251, 231, 0.08)' } },
  };
}

export function tealBarGradient() {
  return {
    type: 'linear' as const,
    x: 0,
    y: 0,
    x2: 1,
    y2: 0,
    colorStops: [
      { offset: 0, color: 'rgba(84, 213, 188, 0.22)' },
      { offset: 1, color: TEAL.bright },
    ],
  };
}
