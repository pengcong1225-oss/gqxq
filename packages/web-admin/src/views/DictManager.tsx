import React, { useState } from 'react';
import { Tabs, Table, Tag, Space, Button, Input, Modal, Form, Tooltip } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, SearchOutlined } from '@ant-design/icons';
import DemoDataNotice from '../components/DemoDataNotice';

const dictData: Record<string, { key: number; label: string; value: string; sort: number; status: number }[]> = {
  complaint_type: [
    { key: 1, label: '投诉', value: 'complaint', sort: 1, status: 1 },
    { key: 2, label: '咨询', value: 'consult', sort: 2, status: 1 },
    { key: 3, label: '建议', value: 'suggest', sort: 3, status: 1 },
    { key: 4, label: '举报', value: 'report', sort: 4, status: 1 },
    { key: 5, label: '求助', value: 'help', sort: 5, status: 1 },
    { key: 6, label: '其他', value: 'other', sort: 6, status: 1 },
    { key: 7, label: '表扬', value: 'praise', sort: 7, status: 1 },
  ],
  business_type: [
    { key: 1, label: '供水', value: 'water', sort: 1, status: 1 },
    { key: 2, label: '燃气', value: 'gas', sort: 2, status: 1 },
    { key: 3, label: '液化气', value: 'lpg', sort: 3, status: 1 },
  ],
  urgency_level: [
    { key: 1, label: '一般', value: 'normal', sort: 1, status: 1 },
    { key: 2, label: '紧急', value: 'urgent', sort: 2, status: 1 },
    { key: 3, label: '特急', value: 'critical', sort: 3, status: 1 },
  ],
  sensitive_word: [
    { key: 1, label: '群体性投诉', value: 'group_complaint', sort: 1, status: 1 },
    { key: 2, label: '安全隐患', value: 'safety_hazard', sort: 2, status: 1 },
    { key: 3, label: '重大事故', value: 'major_accident', sort: 3, status: 1 },
    { key: 4, label: '停水停电', value: 'utility_outage', sort: 4, status: 1 },
    { key: 5, label: '水质污染', value: 'water_pollution', sort: 5, status: 1 },
    { key: 6, label: '燃气泄漏', value: 'gas_leak', sort: 6, status: 1 },
    { key: 7, label: '爆炸', value: 'explosion', sort: 7, status: 1 },
  ],
  source: [
    { key: 1, label: '市民之家', value: 'citizen_hall', sort: 1, status: 1 },
    { key: 2, label: '12345热线', value: 'hotline_12345', sort: 2, status: 1 },
    { key: 3, label: '移动端', value: 'mobile_app', sort: 3, status: 1 },
    { key: 4, label: '网页端', value: 'web', sort: 4, status: 1 },
  ],
  grid_district: [
    { key: 1, label: '西陵区', value: 'xiling', sort: 1, status: 1 },
    { key: 2, label: '伍家岗区', value: 'wujiagang', sort: 2, status: 1 },
    { key: 3, label: '点军区', value: 'dianjun', sort: 3, status: 1 },
    { key: 4, label: '猇亭区', value: 'xiaoting', sort: 4, status: 1 },
    { key: 5, label: '夷陵区', value: 'yiling', sort: 5, status: 1 },
  ],
};

const dictTabs = [
  { key: 'complaint_type', label: '诉求类型' },
  { key: 'business_type', label: '业务类型' },
  { key: 'urgency_level', label: '紧急程度' },
  { key: 'sensitive_word', label: '敏感词' },
  { key: 'source', label: '诉求来源' },
  { key: 'grid_district', label: '区域划分' },
];

const DictManager: React.FC = () => {
  const [activeTab, setActiveTab] = useState('complaint_type');
  const [search, setSearch] = useState('');
  const [modalVisible, setModalVisible] = useState(false);
  const [editingItem, setEditingItem] = useState<any>(null);
  const [form] = Form.useForm();
  const [localData, setLocalData] = useState(dictData);

  const currentData = localData[activeTab] || [];

  const filtered = currentData.filter(d =>
    !search || d.label.includes(search) || d.value.includes(search)
  );

  const columns = [
    { title: '排序', dataIndex: 'sort', width: 60 },
    { title: '标签', dataIndex: 'label', width: 200 },
    { title: '编码值', dataIndex: 'value', width: 200 },
    { title: '状态', dataIndex: 'status', width: 80,
      render: (s: number) => <Tag color={s === 1 ? 'success' : 'error'}>{s === 1 ? '启用' : '禁用'}</Tag> },
    { title: '操作', width: 120,
      render: (_: any, r: any) => <Space>
        <Tooltip title="功能未实现（批次 G1）"><span><Button type="link" size="small" icon={<EditOutlined />} onClick={() => { setEditingItem(r); form.setFieldsValue(r); setModalVisible(true); }} disabled>编辑</Button></span></Tooltip>
        <Tooltip title="功能未实现（批次 G1）"><span><Button type="link" size="small" danger icon={<DeleteOutlined />} disabled>删除</Button></span></Tooltip>
      </Space> },
  ];

  const handleSave = () => {
    form.validateFields().then(vals => {
      if (editingItem) {
        const newData = localData[activeTab].map(d => d.key === editingItem.key ? { ...d, ...vals } : d);
        setLocalData({ ...localData, [activeTab]: newData });
      } else {
        const newKey = Math.max(...localData[activeTab].map(d => d.key), 0) + 1;
        setLocalData({ ...localData, [activeTab]: [...localData[activeTab], { key: newKey, ...vals, status: 1 }] });
      }
      setModalVisible(false);
      setEditingItem(null);
      form.resetFields();
    });
  };

  return (
    <div>
      <DemoDataNotice batch="G1" />
      <h2 style={{ marginBottom: 16 }}>字典管理</h2>
      <Tabs activeKey={activeTab} onChange={setActiveTab} items={dictTabs.map(t => ({ key: t.key, label: t.label }))} />
      <Space style={{ marginBottom: 16 }}>
        <Input placeholder="搜索字典项" prefix={<SearchOutlined />} value={search} onChange={e => setSearch(e.target.value)} style={{ width: 220 }} allowClear />
        <Tooltip title="功能未实现（批次 G1）"><span><Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditingItem(null); form.resetFields(); setModalVisible(true); }} disabled>新增字典项</Button></span></Tooltip>
        <Tag>共 {filtered.length} 条</Tag>
      </Space>
      <Table columns={columns} dataSource={filtered} size="middle" pagination={false} />

      <Modal title={editingItem ? '编辑字典项' : '新增字典项'} open={modalVisible} onOk={handleSave} onCancel={() => { setModalVisible(false); setEditingItem(null); form.resetFields(); }}>
        <Form form={form} layout="vertical">
          <Form.Item name="label" label="显示标签" rules={[{ required: true, message: '请输入' }]}><Input placeholder="如：投诉" /></Form.Item>
          <Form.Item name="value" label="编码值" rules={[{ required: true, message: '请输入' }]}><Input placeholder="如：complaint" /></Form.Item>
          <Form.Item name="sort" label="排序"><Input type="number" /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default DictManager;
