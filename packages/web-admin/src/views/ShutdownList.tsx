import React, { useState } from 'react';
import { Table, Tag, Space, Input, Select, Button, Card, Row, Col, Statistic, Modal, Form, DatePicker, Tooltip } from 'antd';
import { SearchOutlined, PauseCircleOutlined, ClockCircleOutlined, CheckCircleOutlined, WarningOutlined, PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import DemoDataNotice from '../components/DemoDataNotice';
import dayjs from 'dayjs';

const initialShutdowns = Array.from({ length: 18 }, (_, i) => {
  const biz = i % 2 === 0 ? 'water' : 'gas';
  const plannedStart = dayjs().subtract((i % 5), 'day');
  const plannedEnd = plannedStart.add((i % 3 + 1), 'day');
  return {
    key: i + 1, appNo: 'SD202605' + String(i + 1).padStart(3, '0'),
    companyName: biz === 'water' ? ['宜昌市供水总公司','点军区供水有限公司','夷陵区水务公司'][i % 3] : ['宜昌中燃','华润燃气'][i % 2],
    businessType: biz, shutdownType: i % 4 === 0 ? 'emergency' : 'planned',
    reason: biz === 'water' ? ['管道检修','新户接驳','老旧管网改造','阀门更换'][i % 4] : ['管道维修','安全检测','管网更新','调压器更换'][i % 4],
    plannedStartTime: plannedStart.format('YYYY-MM-DD'), plannedEndTime: plannedEnd.format('YYYY-MM-DD'),
    actualEndTime: i % 3 === 0 ? null : plannedEnd.subtract(i % 4, 'hour').format('YYYY-MM-DD HH:mm'),
    isOvertime: i % 7 === 0, status: ['draft','pending_approval','approved','in_progress','completed'][i % 5],
    affectedArea: ['西陵区沿江大道','伍家岗区中南路','点军区江南大道','夷陵区发展大道','猇亭区先锋路'][i % 5],
    affectedHouseholds: Math.floor(Math.random() * 3000) + 100,
    submitter: '操作员' + (i % 3 + 1),
  };
});

const ShutdownList: React.FC = () => {
  const [shutdowns, setShutdowns] = useState(initialShutdowns);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<string | undefined>();
  const [formVisible, setFormVisible] = useState(false);
  const [editingItem, setEditingItem] = useState<any>(null);
  const [form] = Form.useForm();

  const filtered = shutdowns.filter(s => {
    if (search && !s.appNo.includes(search) && !s.companyName.includes(search) && !s.affectedArea.includes(search)) return false;
    if (filterStatus && s.status !== filterStatus) return false;
    return true;
  });

  const statusMap: Record<string,{color:string;text:string}> = {
    draft:{color:'default',text:'草稿'}, pending_approval:{color:'processing',text:'待审批'}, approved:{color:'blue',text:'已审批'},
    in_progress:{color:'orange',text:'执行中'}, completed:{color:'success',text:'已完成'}
  };

  const handleSave = () => {
    form.validateFields().then(vals => {
      const data = { ...vals, plannedStartTime: vals.plannedStartTime?.format('YYYY-MM-DD'), plannedEndTime: vals.plannedEndTime?.format('YYYY-MM-DD') };
      if (editingItem) {
        setShutdowns(shutdowns.map(s => s.key === editingItem.key ? { ...s, ...data } : s));
      } else {
        const newKey = Math.max(...shutdowns.map(s => s.key), 0) + 1;
        setShutdowns([...shutdowns, { key: newKey, appNo: 'SD202605' + String(newKey).padStart(3,'0'), ...data, isOvertime: false, status: 'draft', actualEndTime: null, submitter: '当前用户' }]);
      }
      setFormVisible(false); setEditingItem(null); form.resetFields();
    });
  };

  const columns = [
    { title: '申请编号', dataIndex: 'appNo', width: 130, render: (v: string) => <a>{v}</a> },
    { title: '企业', dataIndex: 'companyName', width: 160, ellipsis: true },
    { title: '类型', dataIndex: 'businessType', width: 60, render: (t: string) => <Tag color={t === 'water' ? 'blue' : 'orange'}>{t === 'water' ? '供水' : '燃气'}</Tag> },
    { title: '停供类型', dataIndex: 'shutdownType', width: 80, render: (t: string) => <Tag color={t === 'emergency' ? 'red' : 'blue'}>{t === 'emergency' ? '紧急' : '计划'}</Tag> },
    { title: '停供原因', dataIndex: 'reason', ellipsis: true },
    { title: '影响区域', dataIndex: 'affectedArea', width: 140, ellipsis: true },
    { title: '影响户数', dataIndex: 'affectedHouseholds', width: 80 },
    { title: '计划开始', dataIndex: 'plannedStartTime', width: 110 },
    { title: '计划恢复', dataIndex: 'plannedEndTime', width: 110 },
    { title: '实际恢复', dataIndex: 'actualEndTime', width: 130, render: (t: string|null) => t || <Tag>未恢复</Tag> },
    { title: '超时', dataIndex: 'isOvertime', width: 60, render: (v: boolean) => v ? <Tag color="red">超时</Tag> : <Tag color="green">正常</Tag> },
    { title: '状态', dataIndex: 'status', width: 80, render: (s: string) => <Tag color={statusMap[s]?.color}>{statusMap[s]?.text}</Tag> },
    { title: '操作', width: 120,
      render: (_: any, r: any) => <Space>
        <Tooltip title="功能未实现（批次 另立批次）"><span><Button type="link" size="small" icon={<EditOutlined />} onClick={() => { setEditingItem(r); form.setFieldsValue({...r, plannedStartTime: dayjs(r.plannedStartTime), plannedEndTime: dayjs(r.plannedEndTime)}); setFormVisible(true); }} disabled>编辑</Button></span></Tooltip>
        <Tooltip title="功能未实现（批次 另立批次）"><span><Button type="link" size="small" danger icon={<DeleteOutlined />} disabled>删除</Button></span></Tooltip>
      </Space> },
  ];

  return (
    <div>
      <DemoDataNotice batch="另立批次" />
      <h2 style={{ marginBottom: 16 }}>停供管理</h2>
      <Row gutter={12} style={{ marginBottom: 16 }}>
        <Col span={4}><Card size="small"><Statistic title="总申请" value={shutdowns.length} prefix={<PauseCircleOutlined />} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="待审批" value={shutdowns.filter(s=>s.status==='pending_approval').length} valueStyle={{color:'#faad14'}} prefix={<ClockCircleOutlined />} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="执行中" value={shutdowns.filter(s=>s.status==='in_progress').length} valueStyle={{color:'#1677ff'}} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="已完成" value={shutdowns.filter(s=>s.status==='completed').length} valueStyle={{color:'#52c41a'}} prefix={<CheckCircleOutlined />} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="超时预警" value={shutdowns.filter(s=>s.isOvertime).length} valueStyle={{color:'#ff4d4f'}} prefix={<WarningOutlined />} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="今日恢复" value={2} valueStyle={{color:'#52c41a'}} /></Card></Col>
      </Row>
      <Card>
        <Space style={{ marginBottom: 16 }} wrap>
          <Input placeholder="搜索编号/企业/区域" prefix={<SearchOutlined />} value={search} onChange={e => setSearch(e.target.value)} style={{ width: 260 }} allowClear />
          <Select placeholder="状态筛选" allowClear style={{ width: 120 }} onChange={setFilterStatus} options={Object.entries(statusMap).map(([k,v]) => ({value:k, label:v.text}))} />
          <Tooltip title="功能未实现（批次 另立批次）"><span><Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditingItem(null); form.resetFields(); setFormVisible(true); }} disabled>新建申请</Button></span></Tooltip>
        </Space>
        <Table columns={columns} dataSource={filtered} size="middle" scroll={{ x: 1600 }} pagination={{ defaultPageSize: 12 }} />
      </Card>

      <Modal title={editingItem ? '编辑停供申请' : '新建停供申请'} open={formVisible} onOk={handleSave} onCancel={() => { setFormVisible(false); setEditingItem(null); form.resetFields(); }} width={600}>
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={12}><Form.Item name="companyName" label="申请企业" rules={[{required:true}]}><Select options={['宜昌市供水总公司','点军区供水有限公司','夷陵区水务公司','宜昌中燃','华润燃气','夷陵区燃气有限公司'].map(c=>({value:c,label:c}))} /></Form.Item></Col>
            <Col span={12}><Form.Item name="businessType" label="业务类型" rules={[{required:true}]}><Select options={[{value:'water',label:'供水'},{value:'gas',label:'燃气'}]} /></Form.Item></Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}><Form.Item name="shutdownType" label="停供类型" rules={[{required:true}]}><Select options={[{value:'planned',label:'计划停供'},{value:'emergency',label:'紧急停供'}]} /></Form.Item></Col>
            <Col span={12}><Form.Item name="affectedHouseholds" label="影响户数"><Input type="number" /></Form.Item></Col>
          </Row>
          <Form.Item name="reason" label="停供原因" rules={[{required:true}]}><Input.TextArea rows={2} placeholder="请描述停供原因" /></Form.Item>
          <Form.Item name="affectedArea" label="影响区域" rules={[{required:true}]}><Input placeholder="如：西陵区沿江大道189号附近" /></Form.Item>
          <Row gutter={16}>
            <Col span={12}><Form.Item name="plannedStartTime" label="计划开始时间" rules={[{required:true}]}><DatePicker showTime style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="plannedEndTime" label="计划恢复时间" rules={[{required:true}]}><DatePicker showTime style={{ width: '100%' }} /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>
    </div>
  );
};

export default ShutdownList;
