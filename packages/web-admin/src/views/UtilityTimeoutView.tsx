import React, {useEffect, useRef, useState} from 'react';
import {Alert, Button, Descriptions, Modal, Space, Spin, Table, Tag, Typography, message} from 'antd';
import {useAppStore} from '../stores/appStore';
import {usePermissionAccess, useWriteAccess, WriteGate} from '../stores/roleAccess';
import {getUtilityTimeouts, pushUtilityTimeout} from '../utility/api';
import EventDetail from '../utility/EventDetail';
import ComplaintTable from '../utility/ComplaintTable';
import {complaintTypeLabel, formatUtilityTime, UtilityModeBar} from '../utility/shared';
import type {TimeoutItem, UtilityMode, UtilityTimeouts} from '../utility/types';

const labels = {pending: '待推送', failed: '发送失败，等待重试', simulated: '本地模拟成功', blocked: '发送被阻止', sent: '填报系统已接收', superseded: '来源已修订，任务失效'};
export default function UtilityTimeoutView() {
  const user = useAppStore(s => s.userInfo), token = useAppStore(s => s.token);
  const read = usePermissionAccess('shutdown.read'), write = useWriteAccess('masterdata.import'), complaintRead = usePermissionAccess('complaint.read');
  const [mode, setMode] = useState<UtilityMode>('simulation'), [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<{key: string; data?: UtilityTimeouts; error?: string}>();
  const [selected, setSelected] = useState<TimeoutItem>(), [eventId, setEventId] = useState<string>(), [busy, setBusy] = useState<string>();
  const auth = JSON.stringify([token, user?.userId, user?.authorizationVersion, user?.mustChangePassword, user?.roles, user?.permissions]);
  const key = JSON.stringify([mode, auth, refresh]), keyRef = useRef(key); keyRef.current = key;
  const current = state?.key === key ? state : undefined, data = current?.data;
  useEffect(() => {let active = true; setSelected(undefined); setEventId(undefined); setBusy(undefined);
    if (read.can && complaintRead.can) void getUtilityTimeouts(mode).then(data => {if (active) setState({key, data});}).catch(e => {if (active) setState({key, error: e.message || '超时任务加载失败'});});
    return () => {active = false;};
  }, [key, read.can, complaintRead.can]);
  const push = async (item: TimeoutItem, outcome: 'success' | 'failure') => {
    if (!write.can || !data || !token || busy || ['sent','simulated','superseded'].includes(item.status)) return;
    const expected = key; setBusy(item.id);
    try {await pushUtilityTimeout(mode, item.id, data.revision, outcome, token); if (keyRef.current === expected) {message.info('已处理推送请求，请查看任务回执'); setRefresh(n => n + 1);}}
    catch (e) {if (keyRef.current === expected) message.error(e instanceof Error ? e.message : '模拟推送失败');}
    finally {if (keyRef.current === expected) setBusy(undefined);}
  };
  if (!read.can) return <Alert type="warning" message={read.tip}/>;
  if (!complaintRead.can) return <Alert type="warning" message="停供超时匹配需要诉求查询权限，请联系管理员开通"/>;
  return <div><Typography.Title level={3}>停供超时推送</Typography.Title><UtilityModeBar mode={mode} onChange={setMode}/>
    <Space style={{marginBottom: 16}}><Button disabled={!!busy} onClick={() => setRefresh(n => n + 1)}>重新评估／刷新任务</Button>{data && <><Tag>版本 {data.revision}</Tag><span>评估时间：{formatUtilityTime(data.evaluatedAt)}</span></>}</Space>
    {current?.error ? <Alert type="error" message={current.error} action={<Button onClick={() => setRefresh(n => n + 1)}>重试</Button>}/> : !data ? <Spin/> : <>
      <Alert showIcon type="info" message="超时关联口径" description={data.windowDescription} style={{marginBottom: 16}}/>
      <Alert type="info" showIcon message="已自动同步的来源申请由后台自动推送与重试" description="签名接口回执与本地模拟结果分别记录；来源修订或诉求变化后会生成新的匹配任务。" style={{marginBottom:16}}/>
      <Table<TimeoutItem> rowKey="id" dataSource={data.items} scroll={{x: 1100}} pagination={{pageSize: 10}} columns={[
        {title: '停供事件', dataIndex: 'eventTitle', render: (title, item) => <Button type="link" onClick={() => setEventId(item.eventId)}>{title}</Button>},
        {title: '关联窗口开始', dataIndex: 'from', render: formatUtilityTime}, {title: '关联窗口结束', dataIndex: 'to', render: formatUtilityTime},
        {title: '关联诉求', render: (_, item) => complaintRead.can ? <Button type="link" onClick={() => setSelected(item)}>{item.complaints.length} 条</Button> : '无明细权限'},
        {title: '状态', dataIndex: 'status', render: (status: TimeoutItem['status']) => <Tag color={status === 'simulated' ? 'green' : status === 'failed' ? 'red' : 'orange'}>{labels[status]}</Tag>},
        {title: '尝试次数', render: (_, item) => item.attempts.length},
        {title: '操作', width: 300, fixed: 'right', render: (_, item) => <Space wrap><Button size="small" onClick={() => setSelected(item)}>任务详情</Button>{mode === 'simulation' && item.sourceSystem !== 'public-utility' ? <><WriteGate allowed={write.can} tip={write.tip}><Button size="small" type="primary" loading={busy === item.id} disabled={!!busy || ['sent','simulated','superseded'].includes(item.status)} onClick={() => void push(item, 'success')}>{item.status === 'failed' ? '模拟重试成功' : '模拟推送成功'}</Button></WriteGate><WriteGate allowed={write.can} tip={write.tip}><Button size="small" disabled={!!busy || ['sent','simulated','superseded'].includes(item.status)} onClick={() => void push(item, 'failure')}>模拟失败</Button></WriteGate></> : <WriteGate allowed={write.can} tip={write.tip}><Button size="small" loading={busy===item.id} disabled={!!busy || ['sent','superseded'].includes(item.status)} onClick={()=>void push(item,'success')}>推送／重试</Button></WriteGate>}</Space>},
      ]}/>
    </>}
    {selected && current?.data && <Modal open title={`${mode === 'simulation' ? '【模拟】' : ''}超时任务详情`} width={1000} onCancel={() => setSelected(undefined)} footer={<Button onClick={() => setSelected(undefined)}>关闭</Button>}>
      <Descriptions bordered column={2} size="small" items={[{key: 'id', label: '任务编号', children: selected.id}, {key: 'eventVersion', label: '关联事件版本', children: selected.eventRevision}, {key: 'event', label: '事件标题', span: 2, children: selected.eventTitle}, {key: 'from', label: '关联开始', children: formatUtilityTime(selected.from)}, {key: 'to', label: '关联结束', children: formatUtilityTime(selected.to)}]}/>
      <Typography.Title level={5}>关联诉求</Typography.Title>
      {!complaintRead.can ? <Alert type="info" message="当前账号没有诉求明细查询权限"/> : <ComplaintTable complaints={selected.complaints} mode={mode}/>}
      <Typography.Title level={5}>推送尝试与回执</Typography.Title><Table size="small" rowKey={(_, index) => String(index)} dataSource={selected.attempts} pagination={false} columns={[{title: '时间', dataIndex: 'at', render: formatUtilityTime}, {title: '结果', dataIndex: 'result', render: (v: string) => ({success: '模拟成功', failure: '模拟失败', simulated: '模拟成功', failed: '模拟失败', blocked: '发送被阻止', sent: '填报系统已接收', superseded: '来源修订失效', sending: '发送中'}[v] ?? v)}, {title: '回执说明', dataIndex: 'message'}]}/>
    </Modal>}
    {eventId && current?.data && <EventDetail key={`${key}-${eventId}`} id={eventId} mode={mode} canReadComplaints={complaintRead.can} onClose={() => setEventId(undefined)}/>}
  </div>;
}
