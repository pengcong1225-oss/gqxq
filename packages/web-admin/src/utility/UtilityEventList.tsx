import SourceApplicationDetails from './SourceApplicationDetails';
import React, {useEffect, useRef, useState} from 'react';
import {Alert, Button, Card, Input, Select, Space, Spin, Table, Tag, Typography, message} from 'antd';
import {useAppStore} from '../stores/appStore';
import {usePermissionAccess, useWriteAccess, WriteGate} from '../stores/roleAccess';
import {getUtilityEvents, saveUtilityEvent} from './api';
import EventForm from './EventForm';
import EventDetail from './EventDetail';
import {approvalLabel, formatUtilityTime, UtilityModeBar} from './shared';
import type {UtilityEvent, UtilityKind, UtilityList, UtilityMode} from './types';

export default function UtilityEventList({kind}: {kind: UtilityKind}) {
  const user = useAppStore(s => s.userInfo), token = useAppStore(s => s.token);
  const read = usePermissionAccess(`${kind}.read`), write = useWriteAccess('masterdata.import'), complaintRead = usePermissionAccess('complaint.read');
  const [mode, setMode] = useState<UtilityMode>('simulation');
  const [refresh, setRefresh] = useState(0), [query, setQuery] = useState(''), [status, setStatus] = useState<string>();
  const [state, setState] = useState<{key: string; data?: UtilityList; error?: string}>();
  const [editing, setEditing] = useState<{key: string; record?: UtilityEvent}>(), [detailId, setDetailId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const auth = JSON.stringify([token, user?.userId, user?.authorizationVersion, user?.mustChangePassword, user?.roles, user?.permissions]);
  const key = JSON.stringify([auth, mode, kind, refresh]), keyRef = useRef(key); keyRef.current = key;
  const current = state?.key === key ? state : undefined, data = current?.data;
  const canWrite = write.can && Boolean(token);
  useEffect(() => {
    let active = true; setEditing(undefined); setDetailId(undefined); setBusy(false);
    if (read.can) void getUtilityEvents(mode, kind).then(data => {if (active) setState({key, data});}).catch(e => {if (active) setState({key, error: e.message || '记录加载失败'});});
    return () => {active = false;};
  }, [key, read.can]);
  const save = async (event: Partial<UtilityEvent>) => {
    if (!canWrite || mode !== 'simulation' || !data || editing?.key !== key || !token) return;
    const expected = key; setBusy(true);
    try {await saveUtilityEvent(mode, data.revision, event, token); if (keyRef.current === expected) {message.success('模拟记录已保存，可在详情中查看修改历史'); setEditing(undefined); setRefresh(n => n + 1);}}
    catch (e) {if (keyRef.current === expected) message.error(e instanceof Error ? e.message : '保存失败');}
    finally {if (keyRef.current === expected) setBusy(false);}
  };
  const filtered = data?.events.filter(e => (!status || e.approvalStatus === status) && `${e.title} ${e.sourceApplicationNo} ${e.area} ${data.options.enterprises.find(c => c.id === e.enterpriseId)?.name ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  if (!read.can) return <Alert type="warning" message={read.tip}/>;
  return <div><Typography.Title level={3}>{kind === 'shutdown' ? '停供管理' : '管道施工管理'}</Typography.Title>
    <UtilityModeBar mode={mode} onChange={setMode}/>
    <Space wrap style={{marginBottom: 16}}><Input.Search aria-label="搜索填报记录" placeholder="标题、企业、区域或申请编号" value={query} allowClear onChange={e => setQuery(e.target.value)} style={{width: 320}}/><Select aria-label="审批状态筛选" placeholder="全部审批状态" allowClear value={status} onChange={setStatus} style={{width: 170}} options={Object.entries(approvalLabel).map(([value, label]) => ({value, label}))}/><Button onClick={() => setRefresh(n => n + 1)} disabled={busy}>刷新</Button>
      {mode === 'simulation' && <WriteGate allowed={canWrite} tip={write.tip}><Button type="primary" disabled={!data || busy} onClick={() => setEditing({key})}>新增模拟{kind === 'shutdown' ? '停供' : '施工'}</Button></WriteGate>}
    </Space>
    {current?.error ? <Alert type="error" message={current.error} action={<Button onClick={() => setRefresh(n => n + 1)}>重试</Button>}/> : !data ? <Spin/> : <>
      <Space style={{marginBottom: 12}}><Tag>数据版本 {data.revision}</Tag><Tag>共 {filtered?.length ?? 0} 条</Tag></Space>
      <Table<UtilityEvent> rowKey="id" dataSource={filtered} scroll={{x: 1250}} pagination={{pageSize: 10, showSizeChanger: true}} columns={[
        {title: '标题／来源申请', dataIndex: 'title', width: 240, render: (v, e) => <><Button type="link" style={{padding: 0}} onClick={() => setDetailId(e.id)}>{v}</Button><div><Typography.Text type="secondary">{e.sourceApplicationNo}</Typography.Text></div></>},
        {title: '业务', dataIndex: 'businessType', render: v => v === 'gas' ? '燃气' : '供水'},
        {title: '填报企业', dataIndex: 'enterpriseId', render: id => data.options.enterprises.find(c => c.id === id)?.name ?? id},
        {title: '影响区域', dataIndex: 'area', width: 160}, {title: '影响户数', dataIndex: 'households'},
        {title: '开始时间', dataIndex: 'startsAt', render: formatUtilityTime}, {title: '计划结束', dataIndex: 'endsAt', render: formatUtilityTime},
        {title: '来源审批', dataIndex: 'approvalStatus', render: (v: UtilityEvent['approvalStatus']) => <Tag color={v === 'approved' ? 'green' : v === 'rejected' ? 'red' : 'orange'}>{approvalLabel[v]}</Tag>},
        {title: '操作', fixed: 'right', width: 160, render: (_, e) => <Space><Button size="small" onClick={() => setDetailId(e.id)}>详情</Button>{mode === 'simulation' && !e.sourceSystem && <WriteGate allowed={canWrite} tip={write.tip}><Button size="small" disabled={busy} onClick={() => setEditing({key, record: e})}>编辑</Button></WriteGate>}</Space>},
      ]}/>
      {data.integration && <Alert showIcon type={data.integration.lastError ? 'warning' : data.integration.enabled ? 'info' : 'warning'} message={`来源：公共事业管理的填报系统 · ${data.integration.enabled ? '自动同步已开启（约30秒）' : '自动同步未开启'}`} description={<Space wrap><span>已映射 {data.integration.mapped} 条，待映射 {data.integration.pendingMapping} 条，来源未分类 {data.integration.unclassifiedCount} 条</span><span>最近内容同步：{data.integration.syncedAt ? formatUtilityTime(data.integration.syncedAt) : '尚无快照变化'}</span>{data.integration.lastError && <span>{data.integration.lastError}</span>}</Space>} style={{marginTop:16}}/>}
      {!!data.sourceRows?.length && <Card title="来源申请与同步状态" style={{marginTop:16}}><Typography.Paragraph>申请、审批及修改直接取自公共事业管理的填报系统。缺少企业、网格、坐标系或审批证据的来源记录保留在这里；完成对应后自动重评估。未分类记录由来源系统确认分类后才同步。</Typography.Paragraph><Table rowKey="sourceApplicationNo" dataSource={data.sourceRows} pagination={{pageSize:5}} expandable={{expandedRowRender: row => <SourceApplicationDetails fields={row.fields} traces={row.approvalTraces}/>}} columns={[{title:'来源申请',dataIndex:'sourceApplicationNo'},{title:'来源状态',dataIndex:'sourceStatus',render:value=>({'00':'草稿','10':'审批中','11':'已通过','90':'已退回'}[String(value)]||String(value))},{title:'同步状态',render:(_,row)=><Tag color={row.syncStatus==='mapped'?'green':'orange'}>{row.syncStatus==='mapped'?'已关联':'待映射'}</Tag>},{title:'待处理事项',render:(_,row)=>row.issues.join('；')||'来源修订已同步'}]}/></Card>}
      {editing?.key === key && mode === 'simulation' && canWrite && <EventForm key={`${key}-${editing.record?.id ?? 'new'}`} kind={kind} record={editing.record} options={data.options} busy={busy} onCancel={() => setEditing(undefined)} onSave={save}/>}
      {detailId && <EventDetail key={`${key}-${detailId}`} id={detailId} mode={mode} options={data.options} canReadComplaints={complaintRead.can} onClose={() => setDetailId(undefined)}/>}
    </>}
  </div>;
}
