import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Col, Empty, InputNumber, Modal, Row, Space, Switch, Table, Tag, Typography } from 'antd';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { buildSupportResearch, localDay, validateWarningRules, type SeasonResearch } from './researchModel';
import type { SupportComplaint, SupportWarningConfig, SupportWarningRule, TenderDataset } from './types';

// The chart package exposes one extra default wrapper when rendered under Node ESM.
const EChartsComponent = typeof ReactECharts === 'function' ? ReactECharts : (ReactECharts as unknown as { default: typeof ReactECharts }).default;

export interface SupportResearchProps {
  view?: 'all' | 'rules' | 'preview';
  data: TenderDataset; from: string; to: string; onComplaint: (row: SupportComplaint) => void;
  config: SupportWarningConfig; onSaveRules: (rules: SupportWarningRule[]) => Promise<void>; canManage: boolean;
}
const scenarioNames = { winter: '冬季供气', summer: '夏季供水', planned: '计划停供', installation: '安装问题' };
const rangeText = (from: string, to: string) => `${from} 至 ${to}`;
type OpenDetail = (title: string, rows: SupportComplaint[], period: string) => void;

function barOption(labels: string[], current: number[], previous?: number[], names: string[] = ['诉求数量']): EChartsOption {
  return { animation: false, aria: { enabled: true }, color: ['#3277ed', '#a9bbd5'], tooltip: { trigger: 'axis' },
    legend: { top: 0 }, grid: { left: 20, right: 20, top: 50, bottom: 40, containLabel: true },
    xAxis: { type: 'category', data: labels, axisLabel: { hideOverlap: true } }, yAxis: { type: 'value', minInterval: 1, name: '件' },
    series: [{ type: 'bar', name: names[0], data: current, barMaxWidth: 40 }, ...(previous ? [{ type: 'bar' as const, name: names[1], data: previous, barMaxWidth: 40 }] : [])] };
}
function Chart({ option, label, onClick }: { option: EChartsOption; label: string; onClick: (index: number, series: number) => void }) {
  return <div role="img" aria-label={label}><EChartsComponent option={option} notMerge style={{ height: 270 }} onEvents={{ click: (e: { dataIndex: number; seriesIndex: number }) => onClick(e.dataIndex, e.seriesIndex) }} /></div>;
}
function SeasonPanel({ season, open }: { season: SeasonResearch; open: OpenDetail }) {
  const name = season.kind === 'winter' ? '冬季供气气压问题' : '夏季供水水压问题';
  const currentPeriod = rangeText(season.current.from, season.current.to), previousPeriod = rangeText(season.previous.from, season.previous.to);
  const drill = (title: string, rows: SupportComplaint[], period: string) => <Button type="link" onClick={() => open(`${name} · ${title}`, rows, period)}>{rows.length} 件</Button>;
  return <Card title={name} extra={<Tag color={season.kind === 'winter' ? 'orange' : 'blue'}>{season.kind === 'winter' ? '每年11月—次年3月' : '每年6—9月'}</Tag>}>
    <Typography.Paragraph type="secondary">按{season.kind === 'winter' ? '冬季结束年份标记：例如2026季为2025-11-01至2026-03-31' : '夏季所在年份标记'}。最近五季含截至日已开始的最新季；本季统计 {currentPeriod}，上季统计 {previousPeriod}。本季尚未结束时按 {season.current.to} 截断，上季为完整季；两季长度不同，不计算同比增长率。仅匹配{season.kind === 'winter' ? '供气“气压问题”' : '供水“水压问题”'}。</Typography.Paragraph>
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={8}>
        <Typography.Title level={5}>最近五季诉求总量</Typography.Title>
        <Chart label={`${name}最近五季总量，表格提供全部数值与明细`} option={barOption(season.years.map(y => `${y.year}季`), season.years.map(y => y.rows.length))} onClick={i => { const y = season.years[i]; if (y) open(`${name} · ${y.year}季`, y.rows, rangeText(y.from, y.to)); }} />
        <Table size="small" rowKey="year" pagination={false} dataSource={season.years} columns={[
          { title: '季年 / 统计日期', render: (_, y) => <><strong>{y.year}季</strong><br /><Typography.Text type="secondary">{y.from}～{y.to}{y.to < y.fullTo ? '（未完季）' : ''}</Typography.Text></> },
          { title: '诉求量 / 明细', render: (_, y) => drill(`${y.year}季`, y.rows, rangeText(y.from, y.to)) },
        ]} />
      </Col>
      <Col xs={24} xl={8}>
        <Typography.Title level={5}>本季与上季逐月比较</Typography.Title>
        <Chart label={`${name}逐月比较，未开始月份显示0且可查看空明细`} option={barOption(season.months.map(m => m.label), season.months.map(m => m.currentRows.length), season.months.map(m => m.previousRows.length), [`${season.current.year}季`, `${season.previous.year}季`])} onClick={(i, s) => { const m = season.months[i]; if (m) open(`${name} · ${s === 0 ? season.current.year : season.previous.year}季${m.label}`, s === 0 ? m.currentRows : m.previousRows, s === 0 ? `${rangeText(m.currentRange.from, m.currentRange.to)}；本季总截止日 ${season.current.to}` : rangeText(m.previousRange.from, m.previousRange.to)); }} />
        <Table size="small" rowKey="month" pagination={false} dataSource={season.months} columns={[
          { title: '月份', dataIndex: 'label' },
          { title: `${season.current.year}季`, render: (_, m) => drill(`${season.current.year}季${m.label}`, m.currentRows, `${rangeText(m.currentRange.from, m.currentRange.to)}；本季总截止日 ${season.current.to}`) },
          { title: `${season.previous.year}季`, render: (_, m) => drill(`${season.previous.year}季${m.label}`, m.previousRows, rangeText(m.previousRange.from, m.previousRange.to)) },
        ]} />
      </Col>
      <Col xs={24} xl={8}>
        <Typography.Title level={5}>本季高发网格前六 · 上季对比</Typography.Title>
        {season.topGrids.length ? <Chart label={`${name}高发网格前六，上季按相同网格ID比较`} option={barOption(season.topGrids.map(g => g.name), season.topGrids.map(g => g.rows.length), season.topGrids.map(g => g.previousRows.length), [`${season.current.year}季`, `${season.previous.year}季`])} onClick={(i, s) => { const g = season.topGrids[i]; if (g) open(`${name} · ${g.name} · ${s === 0 ? season.current.year : season.previous.year}季`, s === 0 ? g.rows : g.previousRows, s === 0 ? currentPeriod : previousPeriod); }} /> : <Empty description="本季暂无匹配诉求，无高发网格" />}
        <Table size="small" rowKey="id" pagination={false} dataSource={season.topGrids} columns={[
          { title: '网格', dataIndex: 'name' },
          { title: `${season.current.year}季`, render: (_, g) => drill(`${g.name} · ${season.current.year}季`, g.rows, currentPeriod) },
          { title: `${season.previous.year}季`, render: (_, g) => drill(`${g.name} · ${season.previous.year}季`, g.previousRows, previousPeriod) },
        ]} />
        <Typography.Text type="secondary">按本季数量降序，同量按网格ID排序；上季为同一网格的上一季数量。最多六个有诉求网格。</Typography.Text>
      </Col>
    </Row>
  </Card>;
}

export default function SupportResearch({ data, from, to, onComplaint, config, onSaveRules, canManage, view = 'all' }: SupportResearchProps) {
  const research = useMemo(() => buildSupportResearch(data, from, to, config.rules), [data, from, to, config]);
  const [draft, setDraft] = useState(() => config.rules.map(r => ({ ...r })));
  const [detail, setDetail] = useState<{ title: string; rows: SupportComplaint[]; period: string } | null>(null);
  const [paused, setPaused] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const generation = useRef(0);
  const submittedRules = useRef<string | null>(null);
  useEffect(() => { generation.current++; submittedRules.current = null; setDraft(config.rules.map(r => ({ ...r }))); setFeedback(null); setSaving(false); setDetail(null); }, [data, canManage]);
  useEffect(() => {
    setDraft(config.rules.map(r => ({ ...r }))); setDetail(null);
    setFeedback(submittedRules.current === JSON.stringify(config.rules) ? { type: 'success', text: '预警规则已保存，预警按已保存配置计算。' } : null);
  }, [config]);
  useEffect(() => setDetail(null), [from, to]);
  const open: OpenDetail = (title, rows, period) => setDetail({ title, rows, period });
  const change = (scenario: SupportWarningRule['scenario'], patch: Partial<SupportWarningRule>) => { setDraft(rules => rules.map(r => r.scenario === scenario ? { ...r, ...patch } : r)); setFeedback(null); };
  async function save() {
    if (!canManage || saving) return;
    const error = validateWarningRules(draft);
    if (error) { setFeedback({ type: 'error', text: error }); return; }
    const currentGeneration = generation.current;
    submittedRules.current = JSON.stringify(draft);
    setSaving(true); setFeedback(null);
    try { await onSaveRules(draft.map(r => ({ ...r }))); if (generation.current === currentGeneration) setFeedback({ type: 'success', text: '预警规则已保存，预警按已保存配置计算。' }); }
    catch (error) { if (generation.current === currentGeneration) { submittedRules.current = null; setFeedback({ type: 'error', text: error instanceof Error ? error.message : '保存失败，请重试。' }); } }
    finally { if (generation.current === currentGeneration) setSaving(false); }
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(config.rules);
  return <Space direction="vertical" size={16} style={{ width: '100%' }}>
    <style>{`@keyframes support-research-marquee{0%,10%{transform:translateX(0)}90%,100%{transform:translateX(-12%)}}.support-research-ticker{overflow:hidden}.support-research-ticker-track{display:flex;gap:24px;width:max-content;max-width:none;animation:support-research-marquee 18s ease-in-out infinite alternate;padding:8px 12px}.support-research-ticker:hover .support-research-ticker-track,.support-research-ticker:focus-within .support-research-ticker-track{animation-play-state:paused}@media(prefers-reduced-motion:reduce){.support-research-ticker-track{animation:none;flex-wrap:wrap;width:auto}.support-research-ticker{overflow:visible}}`}</style>
    <Alert showIcon type={data.mode === 'simulation' ? 'warning' : 'info'} message={data.mode === 'simulation' ? '模拟数据 · 诉求预警与专题研判' : '真实导入数据 · 诉求预警与专题研判'} description={`${data.sourceLabel}；数据版本 ${data.revision}。${data.mode === 'simulation' ? '以下数量、趋势、预警和明细均为演示样本，不代表实际业务结果。可通过本模块的真实数据导入入口整体替换。' : '仅分析当前导入的数据，不补造缺失年份、网格或诉求；零值表示当前导入样本中无匹配记录。'}`} />
    {!research.rangeValid && <Alert type="error" showIcon message="日期范围无效，请选择有效的起止日期。" />}
    {view !== 'rules' && <Card title="往年同期高发诉求 · 前三类" extra={<Button size="small" onClick={() => setPaused(!paused)}>{paused ? '继续滚动' : '暂停滚动'}</Button>}>
      <Typography.Paragraph type="secondary">所选 {from} 至 {to} 的上一年同期：{rangeText(research.priorRange.from, research.priorRange.to)}，含首尾日（北京时间，闰日回退至上一年2月末）。按数量降序，同量按类型名称排序。</Typography.Paragraph>
      {research.priorTop3.length ? <div className="support-research-ticker" role="region" aria-label="往年同期诉求前三类，可暂停滚动或通过键盘访问明细"><div className="support-research-ticker-track" style={{ animationPlayState: paused ? 'paused' : undefined }}>{research.priorTop3.map((r, i) => <Space key={r.name}><Tag color="blue">TOP {i + 1}</Tag><Typography.Text strong>{r.name}</Typography.Text><Button onClick={() => open(`往年同期 · ${r.name}`, r.rows, rangeText(research.priorRange.from, research.priorRange.to))} aria-label={`往年同期${r.name}${r.rows.length}件，查看明细`}>{r.rows.length} 件 · 查看明细</Button></Space>)}</div></div> : <Empty description="上一年同期暂无诉求，无法形成前三类" />}
    </Card>}
    {view !== 'preview' && <Card title="预警场景与规则配置" extra={<Tag>规则版本 {config.revision}</Tag>}>
      <Typography.Paragraph type="secondary">四类场景独立计算，以所选截止日 {to} 为末日，向前包含最近N个自然日；达到或超过阈值即触发。此观察窗不受顶部起始日限制。修改后需保存生效，未保存的输入不会改变预警结果。</Typography.Paragraph>
      {!canManage && <Alert type="info" message="当前账号可查看预警，无规则管理权限。" style={{ marginBottom: 12 }} />}
      <Table size="small" rowKey="scenario" pagination={false} scroll={{ x: 780 }} dataSource={draft} columns={[
        { title: '场景', render: (_, r) => scenarioNames[r.scenario] },
        { title: '启用', render: (_, r) => <Switch aria-label={`${scenarioNames[r.scenario]}启用`} checked={r.enabled} disabled={!canManage || saving} onChange={enabled => change(r.scenario, { enabled })} /> },
        { title: '观察天数', render: (_, r) => <InputNumber aria-label={`${scenarioNames[r.scenario]}观察天数`} min={1} max={3660} precision={0} value={r.days} disabled={!canManage || saving} onChange={days => change(r.scenario, { days: days ?? 0 })} addonAfter="天" /> },
        { title: '触发阈值', render: (_, r) => <InputNumber aria-label={`${scenarioNames[r.scenario]}触发阈值`} min={1} precision={0} value={r.threshold} disabled={!canManage || saving} onChange={threshold => change(r.scenario, { threshold: threshold ?? 0 })} addonAfter="件" /> },
      ]} />
      <Space style={{ marginTop: 12 }} wrap><Button type="primary" loading={saving} disabled={!canManage || !dirty} onClick={save}>保存预警规则</Button><Button disabled={!canManage || !dirty || saving} onClick={() => { setDraft(config.rules.map(r => ({ ...r }))); setFeedback(null); }}>恢复已保存规则</Button><Typography.Text type="secondary">{dirty ? '存在未保存修改' : '已使用服务器保存规则'}</Typography.Text></Space>
      {feedback && <Alert role="status" type={feedback.type} showIcon message={feedback.text} style={{ marginTop: 12 }} />}
      <Row gutter={[12, 12]} style={{ marginTop: 16 }}>{research.warnings.map(w => <Col xs={24} md={12} xl={6} key={w.rule.scenario}><Card size="small" title={scenarioNames[w.rule.scenario]} extra={<Tag color={!w.rule.enabled ? 'default' : w.triggered ? 'red' : 'green'}>{!w.rule.enabled ? '已停用' : w.triggered ? '触发预警' : '未达阈值'}</Tag>}><Typography.Paragraph>{w.from} 至 {w.to}<br />已保存阈值：{w.rule.threshold} 件 / {w.rule.days} 天</Typography.Paragraph><Button danger={w.triggered} onClick={() => open(`${scenarioNames[w.rule.scenario]} · 预警观察窗`, w.rows, rangeText(w.from, w.to))}>{w.rows.length} 件 · 查看完整明细</Button></Card></Col>)}</Row>
    </Card>}
    {view !== 'rules' && <><SeasonPanel season={research.winter} open={open} />
    <SeasonPanel season={research.summer} open={open} /></>}
    <Modal open={!!detail} title={<Space wrap>{detail?.title}<Tag color={data.mode === 'simulation' ? 'orange' : 'blue'}>{data.mode === 'simulation' ? '模拟数据' : '真实导入数据'}</Tag></Space>} width={1100} footer={null} onCancel={() => setDetail(null)} destroyOnClose>
      <Typography.Paragraph type="secondary">统计窗口：{detail?.period}（北京时间，含首尾日）。共 {detail?.rows.length ?? 0} 件；以下记录与所点数值一一对应。点击“查看诉求”打开记录详情。</Typography.Paragraph>
      <Table size="small" rowKey="id" dataSource={detail?.rows ?? []} scroll={{ x: 950 }} pagination={{ pageSize: 10, showSizeChanger: true, showTotal: n => `共 ${n} 件` }} columns={[
        { title: '编号', dataIndex: 'id' }, { title: '标题', dataIndex: 'title', ellipsis: true }, { title: '业务', dataIndex: 'businessType', render: v => v === 'gas' ? '供气' : '供水' }, { title: '诉求类型', dataIndex: 'type' }, { title: '场景', dataIndex: 'scenario', render: (v: SupportComplaint['scenario']) => v === 'other' ? '其他' : scenarioNames[v] },
        { title: '发生日期', dataIndex: 'occurredAt', render: v => localDay(v) ?? '无效日期' }, { title: '网格', dataIndex: 'gridId', render: id => data.grids.find(g => g.id === id)?.name ?? `未匹配网格（${id}）` }, { title: '操作', fixed: 'right', width: 100, render: (_, r) => <Button type="link" onClick={() => onComplaint(r)}>查看诉求</Button> },
      ]} />
    </Modal>
  </Space>;
}
