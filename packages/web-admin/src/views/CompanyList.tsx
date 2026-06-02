import React, { useState } from 'react';
import { Table, Tag, Space, Input, Select, Button, Card, Row, Col, Statistic, Modal, Descriptions, Badge, Form, message, Popconfirm } from 'antd';
import { SearchOutlined, TeamOutlined, SafetyCertificateOutlined, StarOutlined, PlusOutlined, EyeOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';

const qualifications = [
  { certName: '城市供水经营许可证', certNo: 'GS-2022-001', issueDate: '2022-06-15', expiryDate: '2027-06-14' },
  { certName: '燃气经营许可证', certNo: 'RQ-2023-008', issueDate: '2023-03-20', expiryDate: '2028-03-19' },
  { certName: '安全生产许可证', certNo: 'AQ-2021-035', issueDate: '2021-09-01', expiryDate: '2026-08-31' },
];

const initialCompanies = [
  { key: 1, name: '宜昌市供水总公司', shortName: '市供水公司', businessType: 'water', uscc: '91420500MA12345678', legalPerson: '张建国', contactPerson: '王经理', contactPhone: '0717-6230001', address: '宜昌市西陵区沿江大道189号', serviceArea: '西陵区、伍家岗区', status: 1, annualScore: 92.5, certCount: 5 },
  { key: 2, name: '点军区供水有限公司', shortName: '点军供水', businessType: 'water', uscc: '91420500MA12345679', legalPerson: '李明华', contactPerson: '赵主管', contactPhone: '0717-6671000', address: '宜昌市点军区江南大道55号', serviceArea: '点军区', status: 1, annualScore: 88.0, certCount: 3 },
  { key: 3, name: '夷陵区水务公司', shortName: '夷陵水务', businessType: 'water', uscc: '91420500MA12345680', legalPerson: '陈志远', contactPerson: '孙主任', contactPhone: '0717-7820000', address: '宜昌市夷陵区发展大道120号', serviceArea: '夷陵区', status: 1, annualScore: 85.5, certCount: 4 },
  { key: 4, name: '宜昌中燃城市燃气有限公司', shortName: '宜昌中燃', businessType: 'gas', uscc: '91420500MA12345681', legalPerson: '刘宏', contactPerson: '周经理', contactPhone: '0717-6350001', address: '宜昌市西陵区城东大道22号', serviceArea: '全市', status: 1, annualScore: 90.0, certCount: 6 },
  { key: 5, name: '宜昌华润燃气有限公司', shortName: '华润燃气', businessType: 'gas', uscc: '91420500MA12345682', legalPerson: '黄伟', contactPerson: '吴主管', contactPhone: '0717-6360002', address: '宜昌市伍家岗区中南路88号', serviceArea: '西陵区、伍家岗区', status: 1, annualScore: 91.2, certCount: 5 },
  { key: 6, name: '夷陵区燃气有限公司', shortName: '夷陵燃气', businessType: 'gas', uscc: '91420500MA12345683', legalPerson: '郑国强', contactPerson: '钱主任', contactPhone: '0717-7830001', address: '宜昌市夷陵区平湖大道33号', serviceArea: '夷陵区', status: 1, annualScore: 83.0, certCount: 3 },
  { key: 7, name: '宜昌蓝天气体有限公司', shortName: '蓝天气体', businessType: 'lpg', uscc: '91420500MA12345684', legalPerson: '冯涛', contactPerson: '马经理', contactPhone: '0717-6440003', address: '宜昌市猇亭区先锋路16号', serviceArea: '全市', status: 1, annualScore: 86.8, certCount: 4 },
];

const CompanyList: React.FC = () => {
  const [companies, setCompanies] = useState(initialCompanies);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<string | undefined>();
  const [detailVisible, setDetailVisible] = useState(false);
  const [certVisible, setCertVisible] = useState(false);
  const [formVisible, setFormVisible] = useState(false);
  const [selectedCompany, setSelectedCompany] = useState<any>(null);
  const [editingCompany, setEditingCompany] = useState<any>(null);
  const [form] = Form.useForm();

  const filtered = companies.filter(c => {
    if (search && !c.name.includes(search) && !c.shortName.includes(search)) return false;
    if (filterType && c.businessType !== filterType) return false;
    return true;
  });

  const scoreColor = (s: number) => s >= 90 ? '#52c41a' : s >= 85 ? '#faad14' : '#ff4d4f';

  const handleSave = () => {
    form.validateFields().then(vals => {
      if (editingCompany) {
        setCompanies(companies.map(c => c.key === editingCompany.key ? { ...c, ...vals } : c));
        message.success('企业信息已更新');
      } else {
        const newKey = Math.max(...companies.map(c => c.key), 0) + 1;
        setCompanies([...companies, { key: newKey, ...vals, status: 1, annualScore: 80, certCount: 0 }]);
        message.success('企业已添加');
      }
      setFormVisible(false); setEditingCompany(null); form.resetFields();
    });
  };

  const handleDelete = (record: any) => {
    setCompanies(companies.filter(c => c.key !== record.key));
    message.success('已删除企业：' + record.name);
  };

  const columns = [
    { title: '企业名称', dataIndex: 'name', width: 200, render: (n: string, r: any) => <a onClick={() => { setSelectedCompany(r); setDetailVisible(true); }}>{n}</a> },
    { title: '简称', dataIndex: 'shortName', width: 120 },
    { title: '业务类型', dataIndex: 'businessType', width: 80, render: (t: string) => <Tag color={t === 'water' ? 'blue' : t === 'gas' ? 'orange' : 'purple'}>{t === 'water' ? '供水' : t === 'gas' ? '燃气' : '液化气'}</Tag> },
    { title: '法人', dataIndex: 'legalPerson', width: 80 },
    { title: '联系人', dataIndex: 'contactPerson', width: 80 },
    { title: '联系电话', dataIndex: 'contactPhone', width: 120 },
    { title: '服务范围', dataIndex: 'serviceArea', width: 150, ellipsis: true },
    { title: '状态', dataIndex: 'status', width: 70, render: (s: number) => <Badge status={s === 1 ? 'success' : 'error'} text={s === 1 ? '正常' : '停用'} /> },
    { title: '年度评分', dataIndex: 'annualScore', width: 90, sorter: (a: any, b: any) => a.annualScore - b.annualScore, render: (s: number) => <span style={{color: scoreColor(s), fontWeight: 600}}>{s}</span> },
    { title: '资质数', dataIndex: 'certCount', width: 70 },
    { title: '操作', width: 180, fixed: 'right' as const,
      render: (_: any, r: any) => <Space>
        <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => { setSelectedCompany(r); setDetailVisible(true); }}>详情</Button>
        <Button type="link" size="small" icon={<EditOutlined />} onClick={() => { setEditingCompany(r); form.setFieldsValue(r); setFormVisible(true); }}>编辑</Button>
        <Button type="link" size="small" icon={<SafetyCertificateOutlined />} onClick={() => { setSelectedCompany(r); setCertVisible(true); }}>资质</Button>
        <Popconfirm title="确认删除？" onConfirm={() => handleDelete(r)}><Button type="link" size="small" danger icon={<DeleteOutlined />}>删除</Button></Popconfirm>
      </Space> },
  ];

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>企业管理</h2>
      <Row gutter={12} style={{ marginBottom: 16 }}>
        <Col span={4}><Card size="small"><Statistic title="企业总数" value={companies.length} prefix={<TeamOutlined />} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="供水企业" value={companies.filter(c=>c.businessType==='water').length} valueStyle={{color:'#1677ff'}} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="燃气企业" value={companies.filter(c=>c.businessType==='gas').length} valueStyle={{color:'#fa8c16'}} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="液化气企业" value={companies.filter(c=>c.businessType==='lpg').length} valueStyle={{color:'#722ed1'}} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="平均评分" value={(companies.reduce((a,c)=>a+c.annualScore,0)/companies.length).toFixed(1)} prefix={<StarOutlined />} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="资质临期" value={2} valueStyle={{color:'#faad14'}} prefix={<Badge status="warning" />} /></Card></Col>
      </Row>
      <Card>
        <Space style={{ marginBottom: 16 }} wrap>
          <Input placeholder="搜索企业名称" prefix={<SearchOutlined />} value={search} onChange={e => setSearch(e.target.value)} style={{ width: 240 }} allowClear />
          <Select placeholder="业务类型" allowClear style={{ width: 120 }} onChange={setFilterType} options={[{value:'water',label:'供水'},{value:'gas',label:'燃气'},{value:'lpg',label:'液化气'}]} />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditingCompany(null); form.resetFields(); setFormVisible(true); }}>新增企业</Button>
        </Space>
        <Table columns={columns} dataSource={filtered} size="middle" scroll={{ x: 1500 }} pagination={false} />
      </Card>

      {/* Detail Modal */}
      <Modal title="企业详情" open={detailVisible} onCancel={() => setDetailVisible(false)} footer={null} width={700}>
        {selectedCompany && <Descriptions bordered size="small" column={2}>
          <Descriptions.Item label="企业名称" span={2}>{selectedCompany.name}</Descriptions.Item>
          <Descriptions.Item label="简称">{selectedCompany.shortName}</Descriptions.Item>
          <Descriptions.Item label="业务类型"><Tag>{selectedCompany.businessType === 'water' ? '供水' : selectedCompany.businessType === 'gas' ? '燃气' : '液化气'}</Tag></Descriptions.Item>
          <Descriptions.Item label="信用代码" span={2}>{selectedCompany.uscc}</Descriptions.Item>
          <Descriptions.Item label="法人代表">{selectedCompany.legalPerson}</Descriptions.Item>
          <Descriptions.Item label="联系人">{selectedCompany.contactPerson}</Descriptions.Item>
          <Descriptions.Item label="联系电话">{selectedCompany.contactPhone}</Descriptions.Item>
          <Descriptions.Item label="状态"><Badge status="success" text="正常" /></Descriptions.Item>
          <Descriptions.Item label="注册地址" span={2}>{selectedCompany.address}</Descriptions.Item>
          <Descriptions.Item label="服务范围" span={2}>{selectedCompany.serviceArea}</Descriptions.Item>
          <Descriptions.Item label="年度评分"><span style={{color: scoreColor(selectedCompany.annualScore), fontWeight: 600}}>{selectedCompany.annualScore}</span></Descriptions.Item>
          <Descriptions.Item label="资质数量">{selectedCompany.certCount}</Descriptions.Item>
        </Descriptions>}
      </Modal>

      {/* Cert Modal */}
      <Modal title={selectedCompany?.name + ' - 资质证书'} open={certVisible} onCancel={() => setCertVisible(false)} footer={null} width={650}>
        <Table dataSource={qualifications} size="small" pagination={false} columns={[
          { title: '资质名称', dataIndex: 'certName' }, { title: '证书编号', dataIndex: 'certNo' },
          { title: '发证日期', dataIndex: 'issueDate' },
          { title: '有效期至', dataIndex: 'expiryDate', render: (d: string) => <span style={{color: new Date(d) < new Date(Date.now() + 90*86400000) ? '#faad14' : '#52c41a'}}>{d} {new Date(d) < new Date(Date.now() + 90*86400000) && <Tag color="warning" style={{marginLeft:4}}>临期</Tag>}</span> },
          { title: '状态', render: () => <Tag color="success">有效</Tag> },
        ]} />
      </Modal>

      {/* Add/Edit Form Modal */}
      <Modal title={editingCompany ? '编辑企业' : '新增企业'} open={formVisible} onOk={handleSave} onCancel={() => { setFormVisible(false); setEditingCompany(null); form.resetFields(); }} width={600}>
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={12}><Form.Item name="name" label="企业全称" rules={[{required:true}]}><Input placeholder="如：宜昌市供水总公司" /></Form.Item></Col>
            <Col span={12}><Form.Item name="shortName" label="简称" rules={[{required:true}]}><Input placeholder="如：市供水公司" /></Form.Item></Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}><Form.Item name="businessType" label="业务类型" rules={[{required:true}]}><Select options={[{value:'water',label:'供水'},{value:'gas',label:'燃气'},{value:'lpg',label:'液化气'}]} /></Form.Item></Col>
            <Col span={12}><Form.Item name="uscc" label="统一社会信用代码"><Input placeholder="18位信用代码" /></Form.Item></Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}><Form.Item name="legalPerson" label="法定代表人"><Input placeholder="法人姓名" /></Form.Item></Col>
            <Col span={12}><Form.Item name="contactPerson" label="联系人"><Input placeholder="联系人姓名" /></Form.Item></Col>
          </Row>
          <Form.Item name="contactPhone" label="联系电话"><Input placeholder="联系电话" /></Form.Item>
          <Form.Item name="address" label="注册地址"><Input placeholder="企业注册地址" /></Form.Item>
          <Form.Item name="serviceArea" label="服务范围"><Input.TextArea rows={2} placeholder="服务范围描述" /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default CompanyList;
