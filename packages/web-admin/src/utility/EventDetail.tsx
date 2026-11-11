import React, {useEffect, useState} from 'react';
import {Alert, Button, Descriptions, Modal, Select, Space, Spin, Table, Tabs, Tag} from 'antd';
import {getUtilityDetail} from './api';
import ComplaintTable from './ComplaintTable';
import {approvalLabel, complaintTypeLabel, formatUtilityTime} from './shared';
import type {UtilityDetail, UtilityEvent, UtilityMode, UtilityOptions} from './types';

export default function EventDetail({id, mode, options, canReadComplaints, onClose}: {id: string; mode: UtilityMode; options?: UtilityOptions; canReadComplaints: boolean; onClose: () => void}) {
  const [detail, setDetail] = useState<UtilityDetail>();
  const [error, setError] = useState('');
  const [version, setVersion] = useState<number>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {let active = true; setDetail(undefined); setError(''); setVersion(undefined);
    void getUtilityDetail(mode, id).then(data => {if (active) setDetail(data);}).catch(e => {if (active) setError(e.message || '详情加载失败');});
    return () => {active = false;};
  }, [id, mode, retry]);
  const history = detail?.history ?? [];
  const event = version === undefined ? detail?.event : history.find(item => item.revision === version)?.event;
  const fields = (e: UtilityEvent) => [
    {key: 'id', label: '记录编号', children: e.id}, {key: 'revision', label: '记录版本', children: e.revision},
    {key: 'title', label: '标题', children: e.title, span: 2},
    {key: 'business', label: '业务', children: e.businessType === 'gas' ? '燃气' : '供水'},
    {key: 'enterprise', label: '填报企业', children: options?.enterprises.find(i => i.id === e.enterpriseId)?.name ?? e.enterpriseId},
    {key: 'sourceNo', label: '来源申请编号', children: e.sourceApplicationNo}, {key: 'district', label: '行政区代码', children: e.districtCode},
    {key: 'grid', label: '涉及网格', span: 2, children: e.gridIds.map(id => options?.grids.find(i => i.id === id)?.name ?? id).join('、')},
    {key: 'starts', label: '开始时间', children: formatUtilityTime(e.startsAt)}, {key: 'ends', label: '计划结束时间', children: formatUtilityTime(e.endsAt)},
    {key: 'restored', label: '填报复供／完工', children: formatUtilityTime(e.restoredAt)}, {key: 'households', label: '影响户数', children: e.households},
    {key: 'workers', label: '施工／抢修人数', children: e.workers}, {key: 'housing', label: '涉及小区', children: e.housing || '—'},
    {key: 'reason', label: '原因', span: 2, children: e.reason}, {key: 'area', label: '影响区域', span: 2, children: e.area},
    {key: 'plan', label: '工作计划', span: 2, children: e.plan}, {key: 'types', label: '关联诉求类型', span: 2, children: e.relatedTypes.join('、')},
    {key: 'status', label: '来源审批状态', children: approvalLabel[e.approvalStatus]}, {key: 'approver', label: '来源审批人', children: e.approvedBy || '—'},
    {key: 'approvedAt', label: '来源审批时间', children: formatUtilityTime(e.approvedAt)}, {key: 'updated', label: '更新时间', children: formatUtilityTime(e.updatedAt)},
    {key: 'note', label: '来源审批意见', span: 2, children: e.approvalNote || '—'},
  ];
  return <Modal open title={`${mode === 'simulation' ? '【模拟】' : ''}公共事业记录详情`} width={1000} onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
    {error ? <Alert type="error" message={error} action={<Button onClick={() => setRetry(n => n + 1)}>重试</Button>}/> : !detail ? <Spin/> : <Tabs items={[
      {key: 'detail', label: '填报及审批详情', children: <><Tag color={mode === 'simulation' ? 'orange' : 'blue'}>来源：公共事业管理的填报系统</Tag>{event && <Descriptions bordered size="small" column={2} style={{marginTop: 12}} items={fields(detail.event)}/>}</>},
      {key: 'history', label: `修改历史（${history.length}）`, children: <><Alert type="info" message="展示最近100个数据版本内保留的记录修订；选择版本查看当时保存的完整记录" style={{marginBottom: 12}}/><Space style={{marginBottom: 12}}>查看版本<Select aria-label="历史版本" placeholder="选择历史版本" style={{width: 330}} value={version} onChange={setVersion} options={history.map(item => ({value: item.revision, label: `版本 ${item.revision} · ${formatUtilityTime(item.updatedAt)}`}))}/></Space>{event && version !== undefined ? <Descriptions bordered size="small" column={2} items={fields(event)}/> : null}</>},
      {key: 'complaints', label: `关联诉求（${detail.complaints.length}）`, children: <>{!canReadComplaints ? <Alert type="info" message="当前账号没有诉求明细查询权限，关联明细不展示"/> : <><Alert type="info" message="仅展示服务端按本事件网格、业务、诉求类型与时间窗口匹配的诉求；点击诉求内容可打开明细" style={{marginBottom: 12}}/><ComplaintTable complaints={detail.complaints} mode={mode} options={options}/></>}</>},
    ]}/>}
  </Modal>;
}
