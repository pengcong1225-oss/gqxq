import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Col, Empty, Result, Row, Space, Statistic, Table, Tag, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../stores/appStore';
import StatisticsFilters, { initialStatisticsDraft, type StatisticsDraft } from './StatisticsFilters';
import { getStatisticsSummary, getStatisticsComplaints } from '../api/statistics';
import type { StatisticsQuery, StatisticsResult, StatisticsPage, StatisticsDataset, DimensionBucket, StatisticsComplaint, BucketSelection } from '../types/statistics';
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const bucketSelection = (b: DimensionBucket): BucketSelection => b.dimension === 'category' ? { dimension: b.dimension, code: b.code, level: b.level, dictionaryVersion: b.dictionaryVersion } : { dimension: b.dimension, code: b.code };
export default function StatisticsPanel({ initialDataset }: {
    initialDataset: StatisticsDataset;
}) {
    const user = useAppStore(s => s.userInfo), token = useAppStore(s => s.token);
    const permissions = user?.permissions ?? [];
    const valid = Boolean(user && !user.mustChangePassword);
    const permissionKey = JSON.stringify([token, user?.userId, user?.authorizationVersion, user?.roles, [...permissions].sort(), valid]);
    const allowed = (['ledger', 'analysis'] as const).filter(d => valid && permissions.includes('statistics.read') && permissions.includes(d === 'ledger' ? 'dashboard.read' : 'analysis.read'));
    const [draft, setDraft] = useState<StatisticsDraft>(() => initialStatisticsDraft(initialDataset));
    const [query, setQuery] = useState<StatisticsQuery | null>(() => initialDataset === 'ledger' ? initialStatisticsDraft(initialDataset) as StatisticsQuery : null);
    const [storedSummary, setSummary] = useState<StatisticsResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [refresh, setRefresh] = useState(0);
    const [detailQuery, setDetailQuery] = useState<StatisticsQuery | null>(null);
    const [storedDetails, setDetails] = useState<StatisticsPage | null>(null);
    const [detailError, setDetailError] = useState<string | null>(null);
    const [page, setPage] = useState(1);
    const [size, setSize] = useState(10);
    const [detailLoading, setDetailLoading] = useState(false);
    const summarySeq = useRef(0), detailSeq = useRef(0);
    const navigate = useNavigate();
    const summaryKey = JSON.stringify([permissionKey, query, refresh]), detailKey = JSON.stringify([summaryKey, detailQuery, page, size]);
    const summaryKeyRef = useRef(summaryKey), detailKeyRef = useRef(detailKey), summaryOwner = useRef<string | null>(null), detailOwner = useRef<string | null>(null);
    if (summaryKeyRef.current !== summaryKey) {
        summaryKeyRef.current = summaryKey;
        summarySeq.current++;
    }
    if (detailKeyRef.current !== detailKey) {
        detailKeyRef.current = detailKey;
        detailSeq.current++;
    }
    const summary = summaryOwner.current === summaryKey ? storedSummary : null, details = detailOwner.current === detailKey ? storedDetails : null;
    const canQuery = Boolean(query && allowed.includes(query.dataset));
    const canDetail = canQuery && permissions.includes('complaint.read');
    useEffect(() => {
        const seq = ++summarySeq.current;
        setSummary(null);
        setError(null);
        setDetails(null);
        setDetailQuery(null);
        if (!query || !canQuery) {
            setLoading(false);
            return;
        }
        setLoading(true);
        void getStatisticsSummary(query).then(data => { if (seq !== summarySeq.current)
            return; summaryOwner.current = summaryKey; setSummary(data); if (canDetail)
            setDetailQuery(data.query); }).catch(e => { if (seq === summarySeq.current)
            setError(errorText(e)); }).finally(() => { if (seq === summarySeq.current)
            setLoading(false); });
        return () => { summarySeq.current++; };
    }, [query, permissionKey, refresh]);
    useEffect(() => { const seq = ++detailSeq.current; setDetails(null); setDetailError(null); if (!detailQuery || !canDetail) {
        setDetailLoading(false);
        return;
    } setDetailLoading(true); void getStatisticsComplaints(detailQuery, page, size).then(data => { if (seq === detailSeq.current) {
        detailOwner.current = detailKey;
        setDetails(data);
    } }).catch(e => { if (seq === detailSeq.current)
        setDetailError(errorText(e)); }).finally(() => { if (seq === detailSeq.current)
        setDetailLoading(false); }); return () => { detailSeq.current++; }; }, [detailKey]);
    const changeDraft = (next: StatisticsDraft) => { if (next.dataset !== draft.dataset) {
        setQuery(null);
        setSummary(null);
        setDetails(null);
        setDetailQuery(null);
    } setDraft(next); };
    const apply = () => { if (!draft.projection)
        return; setPage(1); setQuery({ ...draft, projection: draft.projection, bucket: undefined }); };
    const drill = (b: DimensionBucket) => { if (!summary || !canDetail)
        return; setPage(1); setDetailQuery({ ...summary.query, bucket: bucketSelection(b) }); };
    const groups = [['business', '业务'], ['category', '正式分类（大类）', 'major'], ['category', '正式分类（小类）', 'minor'], ['enterprise', '企业'], ['district', '区划'], ['grid', '网格（非加和）']] as const;
    if (!allowed.length)
        return <Result status="403" title="当前账号无候选统计查询权限" subTitle="需统计能力及相应数据集能力；自定义角色须显式授权。"/>;
    return <div><Typography.Title level={3}>{initialDataset === 'analysis' ? '分析库统计' : '诉求统计概览'}</Typography.Title>
  {initialDataset === 'analysis' && <Alert style={{ marginBottom: 16 }} type="info" showIcon message="分析准入：全部纠偏已处理且曾有交办；无需交办或误报归库不纳入。请选择分析投影，当前有效值与入库快照分别解释。"/>}
  <StatisticsFilters value={draft} onChange={changeDraft} onApply={apply} allowed={allowed} loading={loading}/>
  {error && <Alert type="error" showIcon message="统计加载失败" description={error} action={<Button onClick={() => setRefresh(r => r + 1)}>重试</Button>}/>}
  {!query && <Empty description="请选择分析投影并应用筛选"/>}
  {loading && <Card loading/>}
  {summary && canQuery && <>
   <Space wrap style={{ marginBottom: 16 }}><Tag color="gold">{summary.policy.label} · v{summary.policy.version}</Tag><Typography.Text>数据集：{summary.query.dataset === 'ledger' ? '诉求总账' : '分析库'} · {summary.query.projection === 'current' ? '当前有效值' : '入库快照'}</Typography.Text><Typography.Text>{summary.query.from} ~ {summary.query.to}（上海业务日，截至结束日）</Typography.Text><Button onClick={() => setRefresh(r => r + 1)}>刷新</Button></Space>
   <Alert type={summary.partial ? 'warning' : 'info'} showIcon message={summary.partial ? '部分结果：存在业务日期未知的记录' : '规范化业务时间（候选口径）'} description={<><div>{summary.timeBasis}</div><div>日期未知排除 {summary.dateFilterUnavailableCount} 件；{Object.entries(summary.excludedByReason).map(([reason, n]) => reason + ' ' + n + ' 件').join('；')}</div>{Object.values(summary.projectionCapabilities).filter(Boolean).map(v => <div key={v}>{v}</div>)}</>} style={{ marginBottom: 16 }}/>
   <Row gutter={[16, 16]}>{[['同筛选诉求数', summary.total], ['接收时间回落数', summary.sourceTimeFallbackCount], ['未定位数', summary.unlocatedCount], ['多网格命中数', summary.multiGridCount]].map(([label, value]) => <Col key={String(label)} xs={12} lg={6}><Card><Statistic title={label} value={value}/></Card></Col>)}</Row>
   <Card title="期间比较（候选政策）" style={{ marginTop: 16 }}><Space size={32} wrap>{summary.comparisons.map(c => <div key={c.kind}><strong>{c.label}：{c.changePercent === null ? '—' : c.changePercent + '%'}</strong><div>基期 {c.from ?? '未定义'} ~ {c.to ?? '未定义'} · {c.baselineCount ?? '—'} 件</div><div>本期 {c.currentDays} 日 / 基期 {c.baselineDays ?? '—'} 日{c.truncated ? '（基期截短）' : ''}</div>{c.reason && <Typography.Text type="secondary">{c.reason}</Typography.Text>}</div>)}</Space></Card>
   <Card title="同筛选业务日趋势" style={{ marginTop: 16 }}><div style={{ overflowX: 'auto' }}><svg role="img" aria-label="业务日诉求趋势" viewBox={'0 0 ' + Math.max(600, summary.trend.length * 18) + ' 120'} style={{ minWidth: 600, width: '100%', height: 140 }}>{summary.trend.map((d, i) => { const max = Math.max(1, ...summary.trend.map(t => t.count)); const h = d.count / max * 90; return <g key={d.date}><title>{d.date + '：' + d.count + '件'}</title><rect x={i * 18 + 2} y={100 - h} width={12} height={h || 1} fill="#1677ff"/><text x={i * 18 + 8} y={114} fontSize={8} textAnchor="middle">{d.date.slice(5)}</text></g>; })}</svg></div></Card>
   <Row gutter={[16, 16]} style={{ marginTop: 16 }}>{groups.map(([dimension, title, level]) => <Col xs={24} lg={12} key={title}><Card title={title}>{dimension === 'grid' && <Typography.Paragraph type="secondary">同一诉求可命中多个授权网格，网格桶非加和；总数仍按诉求唯一键去重。手工网格关联不等同历史空间证据。</Typography.Paragraph>}<Table size="small" pagination={false} rowKey={r => JSON.stringify(bucketSelection(r))} dataSource={summary.dimensions.filter(b => b.dimension === dimension && (!level || b.level === level))} columns={[{ title: '名称', dataIndex: 'name', render: (v: string, b: DimensionBucket) => <>{v}{b.dictionaryVersion && <Tag style={{ marginLeft: 4 }}>字典 v{b.dictionaryVersion}</Tag>}</> }, { title: '件数', dataIndex: 'count', width: 80 }, ...(canDetail ? [{ title: '操作', width: 95, render: (_: unknown, b: DimensionBucket) => <Button size="small" aria-label={'下钻 ' + b.name} onClick={() => drill(b)}>下钻</Button> }] : [])]}/></Card></Col>)}</Row>
   <Card title="企业人口指标（候选期末户数）" style={{ marginTop: 16 }}><Alert type="info" message="企业管理区县是主数据归属，不代表服务人口分布。区划/网格局部统计不能除以整企业户数。"/><Table rowKey="enterpriseCode" size="small" pagination={false} dataSource={summary.rates} columns={[{ title: '企业', dataIndex: 'enterpriseCode' }, { title: '历史户数', render: (_, r) => r.households === null ? '—' : r.households }, { title: '期末/版本', render: (_, r) => r.at + ' / ' + (r.version ?? '—') }, { title: '每万户事件数', render: (_, r) => r.value === null ? '—' : r.value.toFixed(2) }, { title: '依据/不可用原因', render: (_, r) => r.reason ?? r.label }]}/><Typography.Paragraph type="secondary">总体率：—（{summary.overallRate.reason}）；满意率：—（{summary.satisfactionRate.reason}）</Typography.Paragraph></Card>
   <Typography.Paragraph type="secondary">读快照生成时点：{summary.dataCutoffAt}。此时点不是来源系统完整数据水位；所有数字来自当前授权范围。</Typography.Paragraph>
  </>}
  {canDetail && summary && detailQuery && <Card title="同筛选诉求明细" style={{ marginTop: 16 }} extra={detailQuery.bucket ? <Button onClick={() => { setDetailQuery(summary!.query); setPage(1); }}>取消分桶下钻</Button> : null}>{detailQuery.bucket && <Typography.Paragraph>分桶：{detailQuery.bucket.dimension} / {detailQuery.bucket.code ?? '未知'}{detailQuery.bucket.dictionaryVersion ? ' / 字典 v' + detailQuery.bucket.dictionaryVersion : ''}</Typography.Paragraph>}{detailError && <Alert type="error" message="明细加载失败" description={detailError}/>}<Table<StatisticsComplaint> rowKey="complaintId" loading={detailLoading} dataSource={details?.content ?? []} pagination={{ current: page, pageSize: size, total: details?.total ?? 0, showSizeChanger: true, onChange: (p, n) => { setPage(p); setSize(n); } }} columns={[{ title: '诉求', dataIndex: 'complaintNo', render: (v: string, r) => <Button type="link" onClick={() => navigate('/complaints/' + r.id)}>{v}</Button> }, { title: '标题', dataIndex: 'title' }, { title: '业务日', dataIndex: 'businessDay' }, { title: '企业', dataIndex: 'enterpriseName' }, { title: '时间口径', dataIndex: 'timeSource' }, { title: '空间情况', render: (_, r) => r.grids.length ? r.grids.join('、') : r.locationReason ?? '未定位' }]}/></Card>}
 </div>;
}
