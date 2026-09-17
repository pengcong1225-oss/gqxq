import React, { useState } from 'react';
import { Table, Tag, Space, Input, Select, Button, Card, Row, Col, Statistic, Progress, Modal, Form, DatePicker, InputNumber, Tooltip } from 'antd';
import { SearchOutlined, ToolOutlined, CheckCircleOutlined, ClockCircleOutlined, EnvironmentOutlined, PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import DemoDataNotice from '../components/DemoDataNotice';
import dayjs from 'dayjs';

const initialProjects = [
  { key: 1, projectNo: 'PJ2026001', projectName: '西陵区供水管网改造一期', companyName: '宜昌市供水总公司', businessType: 'water', pipelineType: 'water_main', pipelineLength: 2800, startDate: '2026-03-15', plannedEndDate: '2026-08-30', progress: 65, budget: 5800000, status: 'in_progress', description: '对西陵区沿江大道、城东大道老旧供水主管道进行更新改造' },
  { key: 2, projectNo: 'PJ2026002', projectName: '伍家岗区燃气管道更新工程', companyName: '宜昌中燃', businessType: 'gas', pipelineType: 'gas_main', pipelineLength: 3500, startDate: '2026-04-01', plannedEndDate: '2026-09-15', progress: 42, budget: 7800000, status: 'in_progress', description: '更新伍家岗区中南路沿线老旧燃气管网' },
  { key: 3, projectNo: 'PJ2026003', projectName: '点军区供水支管扩建', companyName: '点军区供水有限公司', businessType: 'water', pipelineType: 'water_branch', pipelineLength: 1200, startDate: '2026-05-10', plannedEndDate: '2026-07-20', progress: 18, budget: 2200000, status: 'in_progress', description: '点军区江南大道南段供水支管扩建' },
  { key: 4, projectNo: 'PJ2026004', projectName: '夷陵区老旧燃气管网更换', companyName: '夷陵区燃气有限公司', businessType: 'gas', pipelineType: 'gas_branch', pipelineLength: 1800, startDate: '2026-01-20', plannedEndDate: '2026-06-30', progress: 92, budget: 4500000, status: 'in_progress', description: '夷陵区平湖大道周边老旧管网整体更换' },
  { key: 5, projectNo: 'PJ2026005', projectName: '猇亭区工业供水管道项目', companyName: '宜昌市供水总公司', businessType: 'water', pipelineType: 'water_main', pipelineLength: 4200, startDate: '2025-11-01', plannedEndDate: '2026-04-30', progress: 100, budget: 9800000, status: 'completed', description: '猇亭区工业园区供水专用管线建设' },
  { key: 6, projectNo: 'PJ2026006', projectName: '西陵区燃气管网安全改造', companyName: '华润燃气', businessType: 'gas', pipelineType: 'gas_main', pipelineLength: 2500, startDate: '2026-06-01', plannedEndDate: '2026-12-31', progress: 0, budget: 6200000, status: 'pending', description: '西陵区核心区域燃气管网安全升级改造' },
  { key: 7, projectNo: 'PJ2026007', projectName: '宜都市供水管网延伸工程', companyName: '夷陵区水务公司', businessType: 'water', pipelineType: 'water_branch', pipelineLength: 5600, startDate: '2026-02-15', plannedEndDate: '2026-10-30', progress: 35, budget: 12000000, status: 'in_progress', description: '宜都市新区供水管网延伸敷设' },
];

const PipelineList: React.FC = () => {
  const [projects, setProjects] = useState(initialProjects);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<string | undefined>();
  const [formVisible, setFormVisible] = useState(false);
  const [editingItem, setEditingItem] = useState<any>(null);
  const [form] = Form.useForm();

  const filtered = projects.filter(p => {
    if (search && !p.projectNo.includes(search) && !p.projectName.includes(search) && !p.companyName.includes(search)) return false;
    if (filterStatus && p.status !== filterStatus) return false;
    return true;
  });

  const totalBudget = projects.reduce((s, p) => s + p.budget, 0);
  const totalLength = projects.reduce((s, p) => s + p.pipelineLength, 0);

  const handleSave = () => {
    form.validateFields().then(vals => {
      const data = { ...vals, startDate: vals.startDate?.format('YYYY-MM-DD'), plannedEndDate: vals.plannedEndDate?.format('YYYY-MM-DD') };
      if (editingItem) {
        setProjects(projects.map(p => p.key === editingItem.key ? { ...p, ...data } : p));
      } else {
        const newKey = Math.max(...projects.map(p => p.key), 0) + 1;
        setProjects([...projects, { key: newKey, projectNo: 'PJ2026' + String(newKey).padStart(3,'0'), ...data, progress: 0, status: 'pending' }]);
      }
      setFormVisible(false); setEditingItem(null); form.resetFields();
    });
  };

  const columns = [
    { title: '项目编号', dataIndex: 'projectNo', width: 110 },
    { title: '项目名称', dataIndex: 'projectName', width: 220, ellipsis: true },
    { title: '施工单位', dataIndex: 'companyName', width: 180, ellipsis: true },
    { title: '类型', dataIndex: 'businessType', width: 60, render: (t: string) => <Tag color={t === 'water' ? 'blue' : 'orange'}>{t === 'water' ? '供水' : '燃气'}</Tag> },
    { title: '管线类型', dataIndex: 'pipelineType', width: 80, render: (t: string) => <Tag>{t.includes('main') ? '干管' : '支管'}</Tag> },
    { title: '长度(m)', dataIndex: 'pipelineLength', width: 80, render: (v: number) => v.toLocaleString() },
    { title: '开工', dataIndex: 'startDate', width: 100 },
    { title: '计划完工', dataIndex: 'plannedEndDate', width: 100 },
    { title: '进度', width: 140, render: (_: any, r: any) => <Progress percent={r.progress} size="small" status={r.progress === 100 ? 'success' : r.status === 'pending' ? 'normal' : 'active'} /> },
    { title: '预算(万元)', dataIndex: 'budget', width: 100, render: (v: number) => (v / 10000).toFixed(0) },
    { title: '状态', dataIndex: 'status', width: 80,
      render: (s: string) => {
        const m: Record<string,{color:string;text:string}> = { pending:{color:'default',text:'待开工'}, in_progress:{color:'processing',text:'施工中'}, completed:{color:'success',text:'已完工'}, suspended:{color:'warning',text:'暂停'} };
        return <Tag color={m[s]?.color}>{m[s]?.text}</Tag>;
      } },
    { title: '操作', width: 120,
      render: (_: any, r: any) => <Space>
        <Tooltip title="功能未实现（批次 另立批次）"><span><Button type="link" size="small" icon={<EditOutlined />} onClick={() => { setEditingItem(r); form.setFieldsValue({...r, startDate: dayjs(r.startDate), plannedEndDate: dayjs(r.plannedEndDate)}); setFormVisible(true); }} disabled>编辑</Button></span></Tooltip>
        <Tooltip title="功能未实现（批次 另立批次）"><span><Button type="link" size="small" danger icon={<DeleteOutlined />} disabled>删除</Button></span></Tooltip>
      </Space> },
  ];

  return (
    <div>
      <DemoDataNotice batch="另立批次" />
      <h2 style={{ marginBottom: 16 }}>管道施工改造</h2>
      <Row gutter={12} style={{ marginBottom: 16 }}>
        <Col span={4}><Card size="small"><Statistic title="项目总数" value={projects.length} prefix={<ToolOutlined />} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="施工中" value={projects.filter(p=>p.status==='in_progress').length} valueStyle={{color:'#1677ff'}} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="已完工" value={projects.filter(p=>p.status==='completed').length} valueStyle={{color:'#52c41a'}} prefix={<CheckCircleOutlined />} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="管线总长" value={totalLength.toLocaleString()} suffix="m" prefix={<EnvironmentOutlined />} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="总投资" value={(totalBudget/10000).toFixed(0)} suffix="万元" /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="待开工" value={projects.filter(p=>p.status==='pending').length} prefix={<ClockCircleOutlined />} /></Card></Col>
      </Row>
      <Card>
        <Space style={{ marginBottom: 16 }} wrap>
          <Input placeholder="搜索项目名称/编号/企业" prefix={<SearchOutlined />} value={search} onChange={e => setSearch(e.target.value)} style={{ width: 280 }} allowClear />
          <Select placeholder="状态筛选" allowClear style={{ width: 120 }} onChange={setFilterStatus} options={[{value:'pending',label:'待开工'},{value:'in_progress',label:'施工中'},{value:'completed',label:'已完工'},{value:'suspended',label:'暂停'}]} />
          <Tooltip title="功能未实现（批次 另立批次）"><span><Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditingItem(null); form.resetFields(); setFormVisible(true); }} disabled>新增项目</Button></span></Tooltip>
        </Space>
        <Table columns={columns} dataSource={filtered} size="middle" scroll={{ x: 1500 }} pagination={{ defaultPageSize: 10 }} />
      </Card>

      <Modal title={editingItem ? '编辑项目' : '新增项目'} open={formVisible} onOk={handleSave} onCancel={() => { setFormVisible(false); setEditingItem(null); form.resetFields(); }} width={650}>
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={16}><Form.Item name="projectName" label="项目名称" rules={[{required:true}]}><Input placeholder="如：西陵区供水管网改造一期" /></Form.Item></Col>
            <Col span={8}><Form.Item name="businessType" label="业务类型" rules={[{required:true}]}><Select options={[{value:'water',label:'供水'},{value:'gas',label:'燃气'}]} /></Form.Item></Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}><Form.Item name="companyName" label="施工单位" rules={[{required:true}]}><Select options={['宜昌市供水总公司','点军区供水有限公司','夷陵区水务公司','宜昌中燃','华润燃气','夷陵区燃气有限公司','宜昌蓝天气体'].map(c=>({value:c,label:c}))} /></Form.Item></Col>
            <Col span={12}><Form.Item name="pipelineType" label="管线类型"><Select options={[{value:'water_main',label:'供水干管'},{value:'water_branch',label:'供水支管'},{value:'gas_main',label:'燃气干管'},{value:'gas_branch',label:'燃气支管'}]} /></Form.Item></Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}><Form.Item name="pipelineLength" label="管线长度(m)" rules={[{required:true}]}><InputNumber style={{width:'100%'}} min={1} /></Form.Item></Col>
            <Col span={8}><Form.Item name="budget" label="预算金额(元)" rules={[{required:true}]}><InputNumber style={{width:'100%'}} min={0} step={10000} /></Form.Item></Col>
            <Col span={8}><Form.Item name="status" label="状态"><Select options={[{value:'pending',label:'待开工'},{value:'in_progress',label:'施工中'},{value:'completed',label:'已完工'}]} /></Form.Item></Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}><Form.Item name="startDate" label="开工日期"><DatePicker style={{width:'100%'}} /></Form.Item></Col>
            <Col span={12}><Form.Item name="plannedEndDate" label="计划完工日期"><DatePicker style={{width:'100%'}} /></Form.Item></Col>
          </Row>
          <Form.Item name="description" label="项目描述"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default PipelineList;
