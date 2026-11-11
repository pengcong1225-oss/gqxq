import React from 'react';
import {Alert, Col, Form, Input, InputNumber, Modal, Row, Select} from 'antd';
import type {UtilityEvent, UtilityKind, UtilityOptions} from './types';
import {approvalLabel} from './shared';

type Values = Omit<UtilityEvent, 'id' | 'kind' | 'mode' | 'revision' | 'updatedAt'>;
const localDate = (s?: string | null) => {if (!s) return ''; const d = new Date(s); const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 16);};
const toIso = (s?: string | null) => s ? new Date(s).toISOString() : null;
export default function EventForm({kind, record, options, busy, onCancel, onSave}: {kind: UtilityKind; record?: UtilityEvent; options: UtilityOptions; busy: boolean; onCancel: () => void; onSave: (event: Partial<UtilityEvent>) => Promise<void>}) {
  const [form] = Form.useForm<Values>();
  const business = Form.useWatch('businessType', form) ?? record?.businessType ?? 'water';
  const status = Form.useWatch('approvalStatus', form) ?? record?.approvalStatus ?? 'pending';
  const district = Form.useWatch('districtCode', form);
  const districts = [...new Set(options.grids.map(g => g.districtCode))];
  const save = async () => {
    try {
      const v = await form.validateFields();
      if (Date.parse(v.endsAt) <= Date.parse(v.startsAt)) {form.setFields([{name: 'endsAt', errors: ['计划结束时间必须晚于开始时间']}]); return;}
      if (v.restoredAt && Date.parse(v.restoredAt) < Date.parse(v.startsAt)) {form.setFields([{name: 'restoredAt', errors: ['复供／完工时间不能早于开始时间']}]); return;}
      await onSave({...record, ...v, kind, startsAt: toIso(v.startsAt)!, endsAt: toIso(v.endsAt)!, restoredAt: toIso(v.restoredAt), approvedAt: status === 'pending' ? null : toIso(v.approvedAt), approvedBy: status === 'pending' ? '' : v.approvedBy, mode: 'simulation'});
    } catch { /* Field errors are shown by Form; request errors are shown by the owner. */ }
  };
  const required = [{required: true, message: '请填写此项'}];
  return <Modal open title={`【模拟】${record ? '编辑' : '新增'}${kind === 'shutdown' ? '停供记录' : '管道施工记录'}`} width={900} onCancel={onCancel} onOk={() => void save()} confirmLoading={busy} okText="保存模拟记录" cancelText="取消" closable={!busy} maskClosable={!busy} cancelButtonProps={{disabled: busy}}>
    <Alert type="warning" showIcon message="以下填报及审批字段仅用于模拟验收，保存后独立持久化，不生成真实审批" style={{marginBottom: 16}}/>
    <Form form={form} layout="vertical" initialValues={{businessType: 'water', enterpriseId: undefined, gridIds: [], districtCode: districts[0], households: 0, workers: 0, approvalStatus: 'pending', reason: '', area: '', plan: '', housing: '', approvalNote: '', approvedBy: '', relatedTypes: [], sourceApplicationNo: '', ...record, startsAt: localDate(record?.startsAt), endsAt: localDate(record?.endsAt), restoredAt: localDate(record?.restoredAt), approvedAt: localDate(record?.approvedAt)}} disabled={busy}>
      <Form.Item name="title" label="标题" rules={required}><Input maxLength={128}/></Form.Item>
      <Row gutter={16}><Col span={8}><Form.Item name="businessType" label="业务" rules={required}><Select onChange={() => form.setFieldValue('enterpriseId', undefined)} options={[{value: 'water', label: '供水'}, {value: 'gas', label: '燃气'}]}/></Form.Item></Col><Col span={16}><Form.Item name="enterpriseId" label="填报企业" rules={required}><Select showSearch optionFilterProp="label" options={options.enterprises.filter(e => e.businessType === business).map(e => ({value: e.id, label: e.name}))}/></Form.Item></Col></Row>
      <Row gutter={16}><Col span={8}><Form.Item name="districtCode" label="行政区代码" rules={required}><Select onChange={() => form.setFieldValue('gridIds', [])} options={districts.map(value => ({value, label: value}))}/></Form.Item></Col><Col span={16}><Form.Item name="gridIds" label="涉及网格（同一行政区）" rules={[{required: true, type: 'array', min: 1, message: '请选择至少一个网格'}]}><Select mode="multiple" showSearch optionFilterProp="label" options={options.grids.filter(g => g.districtCode === district).map(g => ({value: g.id, label: g.name}))}/></Form.Item></Col></Row>
      <Row gutter={16}><Col span={8}><Form.Item name="startsAt" label="开始时间" rules={required}><Input type="datetime-local"/></Form.Item></Col><Col span={8}><Form.Item name="endsAt" label="计划结束时间" rules={required}><Input type="datetime-local"/></Form.Item></Col><Col span={8}><Form.Item name="restoredAt" label="实际复供／完工时间"><Input type="datetime-local"/></Form.Item></Col></Row>
      <Row gutter={16}><Col span={8}><Form.Item name="households" label="影响户数" rules={required}><InputNumber min={0} precision={0} style={{width: '100%'}}/></Form.Item></Col><Col span={8}><Form.Item name="workers" label="施工／抢修人数" rules={required}><InputNumber min={0} precision={0} style={{width: '100%'}}/></Form.Item></Col><Col span={8}><Form.Item name="sourceApplicationNo" label="模拟来源申请编号" rules={required}><Input maxLength={100}/></Form.Item></Col></Row>
      <Form.Item name="reason" label="停供／施工原因" rules={required}><Input.TextArea rows={2} maxLength={2000}/></Form.Item>
      <Row gutter={16}><Col span={12}><Form.Item name="area" label="影响区域" rules={required}><Input maxLength={500}/></Form.Item></Col><Col span={12}><Form.Item name="housing" label="涉及小区"><Input maxLength={500}/></Form.Item></Col></Row>
      <Form.Item name="plan" label="工作计划" rules={required}><Input.TextArea rows={2} maxLength={2000}/></Form.Item>
      <Form.Item name="relatedTypes" label="关联诉求类型（输入后按回车确认）" rules={[{required: true, type: 'array', min: 1, message: '请填写至少一个诉求类型'}]} extra="填写与来源诉求一致的类型名称或编码，用于精确关联；例如水压问题、气压问题、计划性停供。"><Select mode="tags" options={['水压问题', '气压问题', '计划性停供'].map(value => ({value, label: value}))}/></Form.Item>
      <Row gutter={16}><Col span={8}><Form.Item name="approvalStatus" label="模拟来源审批状态" rules={required}><Select options={Object.entries(approvalLabel).map(([value, label]) => ({value, label}))}/></Form.Item></Col><Col span={8}><Form.Item name="approvedBy" label="模拟来源审批人" rules={status === 'pending' ? [] : required}><Input disabled={status === 'pending'} maxLength={100}/></Form.Item></Col><Col span={8}><Form.Item name="approvedAt" label="模拟来源审批时间" rules={status === 'pending' ? [] : required}><Input type="datetime-local" disabled={status === 'pending'}/></Form.Item></Col></Row>
      <Form.Item name="approvalNote" label="模拟来源审批意见"><Input.TextArea rows={2} maxLength={2000}/></Form.Item>
    </Form>
  </Modal>;
}
