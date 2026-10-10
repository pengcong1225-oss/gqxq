import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Descriptions, Drawer, Empty, Input, Result, Space, Table } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../stores/appStore';
import { listAnalysisRecords, getAnalysisRecord, type AnalysisRecordParams, type AnalysisRecordDetail } from '../api/analysis';
import type { AnalysisRecordItem, BusinessType, Paged } from '../types/api';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const display = (value: string | null | undefined) => value ?? '—';
/** Legacy membership browser: stored entry fields, server filters/order, no dates. */
export default function AnalysisRecordBrowser() {
    const user = useAppStore(s => s.userInfo), token = useAppStore(s => s.token), navigate = useNavigate();
    const canRead = Boolean(user && !user.mustChangePassword && user.permissions.includes('analysis.read'));
    const actorKey = JSON.stringify([token, user?.userId, user?.authorizationVersion, user?.roles, user?.permissions, user?.mustChangePassword]);
    const [draft, setDraft] = useState({ districtCode: '', businessType: '', enterpriseCode: '' }), [filters, setFilters] = useState<AnalysisRecordParams>({});
    const [page, setPage] = useState(1), [size, setSize] = useState(10), [refresh, setRefresh] = useState(0);
    const listKey = JSON.stringify([actorKey, filters, page, size, refresh]);
    const listRef = useRef(listKey), listSequence = useRef(0), detailSequence = useRef(0);
    if (listRef.current !== listKey) {
        listRef.current = listKey;
        listSequence.current++;
        detailSequence.current++;
    }
    const [loaded, setLoaded] = useState<{
        key: string;
        value: Paged<AnalysisRecordItem>;
    } | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<string | null>(null), [detailState, setDetail] = useState<{
        key: string;
        id: string;
        value: AnalysisRecordDetail;
    } | null>(null), [detailLoading, setDetailLoading] = useState(false), [detailError, setDetailError] = useState<string | null>(null);
    const data = canRead && loaded?.key === listKey ? loaded.value : null;
    const detail = canRead && detailState?.key === listKey && detailState.id === selected ? detailState.value.record : null;
    useEffect(() => {
        const sequence = ++listSequence.current;
        setLoaded(null);
        setError(null);
        setSelected(null);
        setDetail(null);
        setDetailError(null);
        setDetailLoading(false);
        if (!canRead) {
            setLoading(false);
            return;
        }
        setLoading(true);
        void listAnalysisRecords({ ...filters, page, size }).then(value => { if (sequence === listSequence.current)
            setLoaded({ key: listKey, value }); }).catch(error => { if (sequence === listSequence.current)
            setError(errorText(error)); }).finally(() => { if (sequence === listSequence.current)
            setLoading(false); });
        return () => { listSequence.current++; detailSequence.current++; };
    }, [listKey, canRead]);
    const openRecord = async (id: string) => {
        if (!canRead)
            return;
        const key = listKey, sequence = ++detailSequence.current;
        const owns = () => key === listRef.current && sequence === detailSequence.current;
        setSelected(id);
        setDetail(null);
        setDetailError(null);
        setDetailLoading(true);
        try {
            const value = await getAnalysisRecord(id);
            if (owns())
                setDetail({ key, id, value });
        }
        catch (error) {
            if (owns())
                setDetailError(errorText(error));
        }
        finally {
            if (owns())
                setDetailLoading(false);
        }
    };
    const close = () => { detailSequence.current++; setSelected(null); setDetail(null); setDetailLoading(false); };
    if (!canRead)
        return <Result status="403" title="当前账号无分析入库记录查询权限"/>;
    return <Card title="入库记录浏览">

  <Space wrap style={{ margin: '16px 0' }}>{(['districtCode', 'businessType', 'enterpriseCode'] as const).map((field, i) => <label key={field}>{['入库区域编码', '入库业务类型编码', '入库企业编码'][i]}<Input aria-label={['入库区域编码', '入库业务类型编码', '入库企业编码'][i]} value={draft[field]} onChange={event => setDraft({ ...draft, [field]: event.target.value })}/></label>)}
   <Button onClick={() => { setPage(1); setFilters({ districtCode: draft.districtCode.trim() || undefined, businessType: (draft.businessType.trim() || undefined) as BusinessType | undefined, enterpriseCode: draft.enterpriseCode.trim() || undefined }); }}>应用入库筛选</Button><Button onClick={() => setRefresh(value => value + 1)}>刷新记录</Button>
  </Space>
  {error && <Alert type="error" message="入库记录加载失败" description={error} action={<Button onClick={() => setRefresh(value => value + 1)}>重试</Button>}/>}
  <Table<AnalysisRecordItem> rowKey="analysisId" loading={loading} dataSource={data?.content ?? []} locale={{ emptyText: <Empty description="当前筛选条件下暂无入库记录"/> }} pagination={{ current: page, pageSize: size, total: data?.total ?? 0, showSizeChanger: true, onChange: (p, n) => { setPage(p); setSize(n); } }} scroll={{ x: 1100 }} columns={[
            { title: '诉求', dataIndex: 'complaintId', render: (value: string) => user?.permissions.includes('complaint.read') ? <Button type="link" onClick={() => navigate('/complaints/' + encodeURIComponent(value))}>{value}</Button> : value },
            { title: '业务类型', dataIndex: 'businessTypeName' }, { title: '诉求类型', dataIndex: 'complaintTypeName' },
            { title: '区域', dataIndex: 'districtName', render: display }, { title: '责任企业', dataIndex: 'enterpriseName', render: display }, { title: '摘要', dataIndex: 'summary', render: display }, { title: '企业处置结果', dataIndex: 'disposalResult', render: display },
            { title: '纠偏确认时间', dataIndex: 'confirmedAt', render: display }, { title: '操作', render: (_, record) => <Button onClick={() => void openRecord(record.analysisId)}>查看入库记录</Button> },
        ]}/>
  <Drawer key={listKey} title="分析入库记录" open={Boolean(selected) && canRead} onClose={close} width={640}>
   {detailLoading && <p>正在读取入库记录…</p>}{detailError && <Alert type="error" message="入库记录读取失败" description={detailError} action={<Button onClick={() => void openRecord(selected!)}>重试</Button>}/>}
   {detail && <Descriptions column={1} items={[
                ['入库编号', detail.analysisId], ['诉求', detail.complaintId], ['业务类型', detail.businessTypeName], ['诉求类型', detail.complaintTypeName], ['区域', detail.districtName], ['责任企业', detail.enterpriseName], ['摘要', detail.summary], ['企业处置结果', detail.disposalResult], ['纠偏确认时间', detail.confirmedAt],
            ].map(([label, value]) => ({ key: label!, label, children: display(value) }))}/>}
  </Drawer>
 </Card>;
}
