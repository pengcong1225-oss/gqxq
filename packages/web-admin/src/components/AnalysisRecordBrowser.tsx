import {namedLabel,chineseLabel} from '../utils/chineseDisplay';
import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Collapse, Descriptions, Drawer, Empty, Input, Result, Select, Space, Table, Typography } from 'antd';
import {useStatisticsOptions,statisticsFieldStyle} from './StatisticsFilters';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../stores/appStore';
import { listAnalysisRecords, getAnalysisRecord, type AnalysisRecordParams, type AnalysisRecordDetail } from '../api/analysis';
import type { AnalysisRecordItem, BusinessType, Paged } from '../types/api';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const display = (value: string | null | undefined) => value ?? '—';
/** Legacy membership browser: stored entry fields, server filters/order, no dates. */
export default function AnalysisRecordBrowser() {
    const user = useAppStore(s => s.userInfo), token = useAppStore(s => s.token), navigate = useNavigate();
    const options = useStatisticsOptions(false);
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

  <Typography.Paragraph type="secondary">显示入库时保存的记录，包括未留存日期的历史记录；此列表不按日期统计，也不计算同比、环比。企业和区县选项来自现行名录，历史记录仍保留原有名称。</Typography.Paragraph>
  <Space wrap align="end" style={{ margin: '16px 0' }}>
   <label style={statisticsFieldStyle}>入库时所属区县<Select aria-label="入库时所属区县" showSearch optionFilterProp="label" allowClear placeholder="全部" value={draft.districtCode||undefined} options={options.districts} onChange={value=>setDraft({...draft,districtCode:value??''})}/></label>
   <label style={{...statisticsFieldStyle,minWidth:220}}>入库业务类型<Select aria-label="入库业务类型" mode="multiple" allowClear placeholder="全部，可多选" value={draft.businessType?draft.businessType.split(','):[]} onChange={values=>setDraft({...draft,businessType:values.join(',')})} options={['water','gas','lpg'].map(code=>({value:code,label:chineseLabel(code,'business_type')}))}/></label>
   <label style={{...statisticsFieldStyle,minWidth:260}}>入库时责任企业<Select aria-label="入库时责任企业" showSearch filterOption={false} onSearch={options.searchEnterprise} allowClear placeholder="全部，可搜索名称" value={draft.enterpriseCode||undefined} options={options.enterprises} onChange={value=>setDraft({...draft,enterpriseCode:value??''})}/></label>
   <Button type="primary" onClick={() => { setPage(1); setFilters({ districtCode: draft.districtCode || undefined, businessType: (draft.businessType || undefined) as BusinessType | undefined, enterpriseCode: draft.enterpriseCode || undefined }); }}>应用入库筛选</Button><Button onClick={()=>{setDraft({districtCode:'',businessType:'',enterpriseCode:''});setFilters({});setPage(1);}}>重置入库筛选</Button><Button onClick={() => setRefresh(value => value + 1)}>刷新记录</Button>
  </Space>
  <Collapse ghost items={[{key:'codes',label:'按已知编码筛选入库记录',children:<><Typography.Paragraph type="secondary">历史企业或区县不在现行名录时，可输入入库时的真实编码；结果仍按当前账号的数据权限展示。</Typography.Paragraph><Space wrap>{(['districtCode','enterpriseCode'] as const).map((field,i)=><label key={field} style={statisticsFieldStyle}>{['入库区县编码','入库企业编码'][i]}<Input aria-label={['入库区县编码','入库企业编码'][i]} maxLength={64} value={draft[field]} placeholder="可选，输入已知编码" onChange={e=>setDraft({...draft,[field]:e.target.value.trim()})}/></label>)}</Space></>}]} />
  {options.errors.length>0&&<Alert type="warning" showIcon message="部分筛选选项不可用" description={options.errors.join(' ')} action={<Button onClick={options.retry}>重试选项</Button>}/>}
  {error && <Alert type="error" message="入库记录加载失败" description={error} action={<Button onClick={() => setRefresh(value => value + 1)}>重试</Button>}/>}
  <Table<AnalysisRecordItem> rowKey="analysisId" loading={loading} dataSource={data?.content ?? []} locale={{ emptyText: <Empty description="当前筛选条件下暂无入库记录"/> }} pagination={{ current: page, pageSize: size, total: data?.total ?? 0, showSizeChanger: true, onChange: (p, n) => { setPage(p); setSize(n); } }} scroll={{ x: 1100 }} columns={[
            { title: '诉求', dataIndex: 'complaintId', render: (value: string) => user?.permissions.includes('complaint.read') ? <Button type="link" onClick={() => navigate('/complaints/' + encodeURIComponent(value))}>{value}</Button> : value },
            { title: '业务类型', dataIndex: 'businessTypeName',render:(v,r)=>namedLabel(r.businessTypeCode,v,'business_type') }, { title: '诉求类型', dataIndex: 'complaintTypeName',render:(v,r)=>namedLabel(r.complaintTypeCode,v,'complaint_type') },
            { title: '区域', dataIndex: 'districtName', render: display }, { title: '责任企业', dataIndex: 'enterpriseName', render: display }, { title: '摘要', dataIndex: 'summary', render: display }, { title: '企业处置结果', dataIndex: 'disposalResult', render: display },
            { title: '纠偏确认时间', dataIndex: 'confirmedAt', render: display }, { title: '操作', render: (_, record) => <Button onClick={() => void openRecord(record.analysisId)}>查看入库记录</Button> },
        ]}/>
  <Drawer key={listKey} title="分析入库记录" open={Boolean(selected) && canRead} onClose={close} width={640}>
   {detailLoading && <p>正在读取入库记录…</p>}{detailError && <Alert type="error" message="入库记录读取失败" description={detailError} action={<Button onClick={() => void openRecord(selected!)}>重试</Button>}/>}
   {detail && <Descriptions column={1} items={[
                ['入库编号', detail.analysisId], ['诉求', detail.complaintId], ['业务类型', namedLabel(detail.businessTypeCode,detail.businessTypeName,'business_type')], ['诉求类型', namedLabel(detail.complaintTypeCode,detail.complaintTypeName,'complaint_type')], ['区域', detail.districtName], ['责任企业', detail.enterpriseName], ['摘要', detail.summary], ['企业处置结果', detail.disposalResult], ['纠偏确认时间', detail.confirmedAt],
            ].map(([label, value]) => ({ key: label!, label, children: display(value) }))}/>}
  </Drawer>
 </Card>;
}
