import React, { useState } from 'react';
import { Table, Tag, Space, Input, Button, Card, Row, Col, Statistic, Progress, Modal, Form, Select, message, Tooltip } from 'antd';
import { SearchOutlined, AppstoreOutlined, EnvironmentOutlined, CheckCircleOutlined, WarningOutlined, PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import DemoDataNotice from '../components/DemoDataNotice';

const initialGrids = [
  { key: 1, gridCode: 'GRID001', gridName: '西陵区中心网格', districtName: '西陵区', businessType: 'both', companyName: '宜昌市供水总公司', managerName: '赵伟', managerPhone: '13800001001', totalComplaints: 356, resolvedComplaints: 298, overtime: 12, status: 1 },
  { key: 2, gridCode: 'GRID002', gridName: '西陵区城东网格', districtName: '西陵区', businessType: 'gas', companyName: '宜昌中燃', managerName: '钱明', managerPhone: '13800001002', totalComplaints: 245, resolvedComplaints: 200, overtime: 8, status: 1 },
  { key: 3, gridCode: 'GRID003', gridName: '伍家岗区中心网格', districtName: '伍家岗区', businessType: 'both', companyName: '华润燃气', managerName: '孙磊', managerPhone: '13800001003', totalComplaints: 298, resolvedComplaints: 250, overtime: 15, status: 1 },
  { key: 4, gridCode: 'GRID004', gridName: '点军区主网格', districtName: '点军区', businessType: 'water', companyName: '点军区供水有限公司', managerName: '李刚', managerPhone: '13800001004', totalComplaints: 215, resolvedComplaints: 185, overtime: 5, status: 1 },
  { key: 5, gridCode: 'GRID005', gridName: '猇亭区工业网格', districtName: '猇亭区', businessType: 'gas', companyName: '宜昌蓝天气体', managerName: '周强', managerPhone: '13800001005', totalComplaints: 178, resolvedComplaints: 160, overtime: 3, status: 1 },
  { key: 6, gridCode: 'GRID006', gridName: '夷陵区城区网格', districtName: '夷陵区', businessType: 'both', companyName: '夷陵区水务公司', managerName: '吴志远', managerPhone: '13800001006', totalComplaints: 200, resolvedComplaints: 172, overtime: 10, status: 1 },
  { key: 7, gridCode: 'GRID007', gridName: '夷陵区乡镇网格', districtName: '夷陵区', businessType: 'water', companyName: '夷陵区水务公司', managerName: '郑大伟', managerPhone: '13800001007', totalComplaints: 135, resolvedComplaints: 118, overtime: 6, status: 1 },
  { key: 8, gridCode: 'GRID008', gridName: '宜昌高新区网格', districtName: '西陵区', businessType: 'both', companyName: '宜昌市供水总公司', managerName: '冯志强', managerPhone: '13800001008', totalComplaints: 168, resolvedComplaints: 145, overtime: 7, status: 1 },
];

const GridManager: React.FC = () => {
  const [grids, setGrids] = useState(initialGrids);
  const [search, setSearch] = useState('');
  const [formVisible, setFormVisible] = useState(false);
  const [editingGrid, setEditingGrid] = useState<any>(null);
  const [form] = Form.useForm();

  const filtered = grids.filter(g => !search || g.gridName.includes(search) || g.districtName.includes(search) || g.companyName.includes(search));

  const total = grids.reduce((s, g) => s + g.totalComplaints, 0);
  const resolved = grids.reduce((s, g) => s + g.resolvedComplaints, 0);
  const rate = total > 0 ? (resolved / total * 100).toFixed(1) : '0';

  const handleSave = () => {
    form.validateFields().then(vals => {
      if (editingGrid) {
        setGrids(grids.map(g => g.key === editingGrid.key ? { ...g, ...vals } : g));
      } else {
        const newKey = Math.max(...grids.map(g => g.key), 0) + 1;
        setGrids([...grids, { key: newKey, gridCode: 'GRID' + String(newKey).padStart(3,'0'), ...vals, totalComplaints: 0, resolvedComplaints: 0, overtime: 0, status: 1 }]);
      }
      setFormVisible(false); setEditingGrid(null); form.resetFields();
    });
  };

  const columns = [
    { title: '网格编码', dataIndex: 'gridCode', width: 100 },
    { title: '网格名称', dataIndex: 'gridName', width: 160 },
    { title: '所属区域', dataIndex: 'districtName', width: 100 },
    { title: '业务类型', dataIndex: 'businessType', width: 80, render: (t: string) => <Tag color={t === 'both' ? 'green' : t === 'water' ? 'blue' : 'orange'}>{t === 'both' ? '供水+燃气' : t === 'water' ? '供水' : '燃气'}</Tag> },
    { title: '责任企业', dataIndex: 'companyName', width: 180, ellipsis: true },
    { title: '负责人', dataIndex: 'managerName', width: 80 },
    { title: '联系电话', dataIndex: 'managerPhone', width: 120 },
    { title: '总诉求', dataIndex: 'totalComplaints', width: 80, sorter: (a: any, b: any) => a.totalComplaints - b.totalComplaints },
    { title: '已办结', dataIndex: 'resolvedComplaints', width: 80 },
    { title: '办结率', width: 120, render: (_: any, r: any) => <Progress percent={Math.round(r.resolvedComplaints / r.totalComplaints * 100)} size="small" /> },
    { title: '超时', dataIndex: 'overtime', width: 60, render: (v: number) => v > 0 ? <Tag color="red">{v}</Tag> : <Tag color="green">0</Tag> },
    { title: '操作', width: 120, fixed: 'right' as const,
      render: (_: any, r: any) => <Space>
        <Tooltip title="功能未实现（批次 G2 之后）"><span><Button type="link" size="small" icon={<EditOutlined />} onClick={() => { setEditingGrid(r); form.setFieldsValue(r); setFormVisible(true); }} disabled>编辑</Button></span></Tooltip>
        <Tooltip title="功能未实现（批次 G2 之后）"><span><Button type="link" size="small" danger icon={<DeleteOutlined />} disabled>删除</Button></span></Tooltip>
      </Space> },
  ];

  return (
    <div>
      <DemoDataNotice batch="G2 之后" />
      <h2 style={{ marginBottom: 16 }}>网格管理</h2>
      <Row gutter={12} style={{ marginBottom: 16 }}>
        <Col span={4}><Card size="small"><Statistic title="网格总数" value={grids.length} prefix={<AppstoreOutlined />} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="覆盖区域" value={5} prefix={<EnvironmentOutlined />} suffix="个区" /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="总体办结率" value={rate} suffix="%" valueStyle={{color:'#52c41a'}} prefix={<CheckCircleOutlined />} /></Card></Col>
        <Col span={5}><Card size="small"><Statistic title="诉求总量" value={total} /></Card></Col>
        <Col span={5}><Card size="small"><Statistic title="超时未办结" value={grids.reduce((s, g) => s + g.overtime, 0)} prefix={<WarningOutlined />} valueStyle={{color:'#ff4d4f'}} /></Card></Col>
      </Row>
      <Card>
        <Space style={{ marginBottom: 16 }} wrap>
          <Input placeholder="搜索网格/区域/企业" prefix={<SearchOutlined />} value={search} onChange={e => setSearch(e.target.value)} style={{ width: 260 }} allowClear />
          <Tooltip title="功能未实现（批次 G2 之后）"><span><Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditingGrid(null); form.resetFields(); setFormVisible(true); }} disabled>新增网格</Button></span></Tooltip>
          <Tooltip title="功能未实现（批次 G2 之后）"><span><Button icon={<EnvironmentOutlined />} onClick={() => message.info('GIS边界绘制功能 - 需要集成天地图API，当前为Demo演示')} disabled>GIS边界绘制</Button></span></Tooltip>
        </Space>
        <Table columns={columns} dataSource={filtered} size="middle" scroll={{ x: 1400 }} pagination={false} />
      </Card>

      <Modal title={editingGrid ? '编辑网格' : '新增网格'} open={formVisible} onOk={handleSave} onCancel={() => { setFormVisible(false); setEditingGrid(null); form.resetFields(); }} width={550}>
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={12}><Form.Item name="gridName" label="网格名称" rules={[{required:true}]}><Input placeholder="如：西陵区中心网格" /></Form.Item></Col>
            <Col span={12}><Form.Item name="districtName" label="所属区域" rules={[{required:true}]}><Select options={['西陵区','伍家岗区','点军区','猇亭区','夷陵区','宜都市','枝江市'].map(d=>({value:d,label:d}))} /></Form.Item></Col>
          </Row>
          <Form.Item name="businessType" label="业务类型" rules={[{required:true}]}><Select options={[{value:'water',label:'供水'},{value:'gas',label:'燃气'},{value:'both',label:'供水+燃气'}]} /></Form.Item>
          <Form.Item name="companyName" label="责任企业" rules={[{required:true}]}><Select options={['宜昌市供水总公司','点军区供水有限公司','夷陵区水务公司','宜昌中燃','华润燃气','夷陵区燃气有限公司','宜昌蓝天气体'].map(c=>({value:c,label:c}))} /></Form.Item>
          <Row gutter={16}>
            <Col span={12}><Form.Item name="managerName" label="负责人姓名"><Input placeholder="负责人" /></Form.Item></Col>
            <Col span={12}><Form.Item name="managerPhone" label="负责人电话"><Input placeholder="手机号码" /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>
    </div>
  );
};

export default GridManager;
