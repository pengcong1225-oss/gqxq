import React from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';

export default function DailyComplaintChart({ trend }: { trend: { date: string; count: number }[] }) {
  const longRange = trend.length > 60;
  const option: EChartsOption = {
    animationDuration: 250,
    color: ['#3978f6'],
    aria: { enabled: true },
    grid: { left: 16, right: 20, top: 32, bottom: longRange ? 68 : 16, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: value => `${value} 件` },
    xAxis: {
      type: 'category', data: trend.map(d => d.date),
      axisTick: { alignWithLabel: true }, axisLine: { lineStyle: { color: '#d9e1ec' } },
      axisLabel: { color: '#64748b', fontSize: 12, hideOverlap: true, margin: 12, formatter: (value: string) => value.slice(5) },
    },
    yAxis: {
      type: 'value', name: '数量（件）', min: 0, minInterval: 1,
      nameTextStyle: { color: '#64748b' }, axisLabel: { color: '#64748b' },
      splitLine: { lineStyle: { color: '#edf1f7', type: 'dashed' } },
    },
    dataZoom: longRange ? [{ type: 'slider', bottom: 4, height: 24, startValue: Math.max(0, trend.length - 60), endValue: trend.length - 1 }] : [],
    series: [{ name: '诉求数量', type: 'bar', data: trend.map(d => d.count), barMaxWidth: 32, itemStyle: { borderRadius: [4, 4, 0, 0] }, emphasis: { itemStyle: { color: '#1d4ed8' } } }],
  };
  return <div role="img" aria-label={`每日诉求数量趋势，共${trend.length}天，合计${trend.reduce((sum, d) => sum + d.count, 0)}件`}><ReactECharts option={option} notMerge style={{ height: 300, width: '100%' }} /></div>;
}
