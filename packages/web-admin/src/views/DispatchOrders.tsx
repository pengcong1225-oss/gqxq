import React, { useState } from 'react';
import { Table, Tag, Space, Input, Select, Button, Card, Row, Col, Statistic, Modal, Timeline, Form, Tooltip, Badge } from 'antd';
import { SearchOutlined, WarningOutlined, CheckCircleOutlined, ClockCircleOutlined, SendOutlined, EyeOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import DemoDataNotice from '../components/DemoDataNotice';

const initialOrders = Array.from({ length: 25 }, (_, i) => {
  const statuses = ['pending', 'processing', 'completed', 'rejected'];
  const urgency = ['一般', '紧急', '特急'][i % 3];
  return {
    key: i + 1, orderNo: 'JB202605' + String(i + 1).padStart(4, '0'),
    complaintTitle: ['西陵区大面积停水','伍家岗区燃气泄漏','点军区水质污染','猇亭区管道爆裂','夷陵区液化气站安全隐患'][i % 5],
    dispatchType: i % 3 === 0 ? 'manual' : 'auto',
    triggerType: i % 3 === 0 ? 'manual_flag' : 'sensitive_word',
    sensitiveWords: ['停水','泄漏','污染','爆裂','安全'][i % 5],
    urgencyLevel: urgency,
    targetCompany: ['宜昌市供水总公司','宜昌中燃','点军区供水有限公司','华润燃气','宜昌蓝天气体'][i % 5],
    deadline: new Date(Date.now() + (i % 5 + 1) * 86400000).toISOString(),
    status: statuses[i % 4],
    syncStatus: ['not_synced', 'success', 'failed', 'syncing'][i % 4],
    externalStatus: ['pending', 'accepted', 'processing', 'completed', 'overtime'][i % 5],
    dispatcher: '管理员' + (i % 3 + 1),
    createdAt: new Date(Date.now() - i * 86400000).toISOString(),
  };
});

const DispatchOrders: React.FC = () => {
  const [orders, setOrders] = useState(initialOrders);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<string | undefined>();
  const [detailVisible, setDetailVisible] = useState(false);
  const [formVisible, setFormVisible] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<any>(null);
  const [form] = Form.useForm();

  const filtered = orders.filter(o => {
    if (search && !o.orderNo.includes(search) && !o.complaintTitle.includes(search)) return false;
    if (filterStatus && o.status !== filterStatus) return false;
    return true;
  });

  const stats = { total: orders.length, pending: orders.filter(o => o.status === 'pending').length, processing: orders.filter(o => o.status === 'processing').length, completed: orders.filter(o => o.status === 'completed').length };

  const handleCreateDispatch = () => {
    form.validateFields().then(vals => {
      const newKey = Math.max(...orders.map(o => o.key), 0) + 1;
      setOrders([...orders, {
        key: newKey, orderNo: 'JB202605' + String(newKey).padStart(4, '0'),
        complaintTitle: vals.complaintTitle, dispatchType: 'manual', triggerType: 'manual_flag',
        sensitiveWords: vals.sensitiveWords || '人工标记',
        urgencyLevel: vals.urgencyLevel, targetCompany: vals.targetCompany,
        deadline: vals.deadline?.toISOString() || new Date(Date.now() + 3 * 86400000).toISOString(),
        status: 'pending', syncStatus: 'not_synced', externalStatus: 'pending', dispatcher: '当前用户', createdAt: new Date().toISOString(),
      }]);
      setFormVisible(false); form.resetFields();
    });
  };

  const columns = [
    { title: '交办编号', dataIndex: 'orderNo', width: 140, render: (v: string) => <a onClick={() => { setSelectedOrder(orders.find(o => o.orderNo === v)); setDetailVisible(true); }}>{v}</a> },
    { title: '关联诉求', dataIndex: 'complaintTitle', ellipsis: true },
    { title: '交办方式', dataIndex: 'dispatchType', width: 80, render: (t: string) => <Tag color={t === 'auto' ? 'blue' : 'purple'}>{t === 'auto' ? '自动' : '人工'}</Tag> },
    { title: '触发词', dataIndex: 'sensitiveWords', width: 80, render: (w: string) => <Tag color="red">{w}</Tag> },
    { title: '紧急程度', dataIndex: 'urgencyLevel', width: 80, render: (t: string) => <Tag color={t === '特急' ? 'red' : t === '紧急' ? 'orange' : 'blue'}>{t}</Tag> },
    { title: '目标企业', dataIndex: 'targetCompany', width: 140, ellipsis: true },
    { title: '截止时间', dataIndex: 'deadline', width: 110, render: (t: string) => new Date(t).toLocaleDateString('zh-CN') },
    { title: '状态', dataIndex: 'status', width: 80,
      render: (s: string) => {
        const m: Record<string,{color:string;text:string}> = { pending:{color:'default',text:'待签收'}, processing:{color:'processing',text:'处理中'}, completed:{color:'success',text:'已完成'}, rejected:{color:'error',text:'已退回'} };
        return <Tag color={m[s]?.color}>{m[s]?.text}</Tag>;
      } },
    { title: '同步状态', dataIndex: 'syncStatus', width: 90, render: (s: string) => {
      const m: Record<string,{color:string;text:string}> = { not_synced:{color:'default',text:'未推送'}, success:{color:'success',text:'成功'}, failed:{color:'error',text:'失败'}, syncing:{color:'processing',text:'同步中'} };
      return <Tag color={m[s]?.color}>{m[s]?.text}</Tag>;
    } },
    { title: '填报状态', dataIndex: 'externalStatus', width: 90, render: (s: string) => <Tag>{s}</Tag> },
    { title: '操作', width: 220, fixed: 'right' as const,
      render: (_: any, r: any) => <Space>
        <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => { setSelectedOrder(r); setDetailVisible(true); }}>详情</Button>
        <Tooltip title="功能未实现（批次 G2/G3）"><span><Button type="link" size="small" icon={<SendOutlined />} disabled>推送</Button></span></Tooltip>
        <Tooltip title="功能未实现（批次 G2/G3）"><span><Button type="link" size="small" disabled>同步</Button></span></Tooltip>
        <Tooltip title="功能未实现（批次 G2/G3）"><span><Button type="link" size="small" danger icon={<DeleteOutlined />} disabled>删除</Button></span></Tooltip>
      </Space> },
  ];

  return (
    <div>
      <DemoDataNotice batch="G2/G3" />
      <h2 style={{ marginBottom: 16 }}>敏感诉求交办</h2>
      <Row gutter={12} style={{ marginBottom: 16 }}>
        <Col span={4}><Card size="small"><Statistic title="交办总数" value={stats.total} prefix={<SendOutlined />} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="待签收" value={stats.pending} valueStyle={{color:'#faad14'}} prefix={<ClockCircleOutlined />} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="处理中" value={stats.processing} valueStyle={{color:'#1677ff'}} prefix={<WarningOutlined />} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="已完成" value={stats.completed} valueStyle={{color:'#52c41a'}} prefix={<CheckCircleOutlined />} /></Card></Col>
        <Col span={8}><Card size="small"><Statistic title="超时预警" value={3} valueStyle={{color:'#ff4d4f'}} prefix={<Badge status="error" />} suffix={<span style={{fontSize:12}}>件即将超时</span>} /></Card></Col>
      </Row>
      <Card>
        <Space style={{ marginBottom: 16 }} wrap>
          <Input placeholder="搜索编号/诉求标题" prefix={<SearchOutlined />} value={search} onChange={e => setSearch(e.target.value)} style={{ width: 260 }} allowClear />
          <Select placeholder="状态筛选" allowClear style={{ width: 120 }} onChange={setFilterStatus} options={[{value:'pending',label:'待签收'},{value:'processing',label:'处理中'},{value:'completed',label:'已完成'},{value:'rejected',label:'已退回'}]} />
          <Tooltip title="功能未实现（批次 G2/G3）"><span><Button type="primary" icon={<PlusOutlined />} disabled>手动交办</Button></span></Tooltip>
        </Space>
        <Table columns={columns} dataSource={filtered} size="middle" scroll={{ x: 1200 }} pagination={{ defaultPageSize: 12, showTotal: t => `共 ${t} 条交办单` }} />
      </Card>

      {/* Detail Modal */}
      <Modal title="交办详情" open={detailVisible} onCancel={() => setDetailVisible(false)} footer={null} width={600}>
        {selectedOrder && (
          <div>
            <p><strong>交办编号：</strong>{selectedOrder.orderNo}</p>
            <p><strong>关联诉求：</strong>{selectedOrder.complaintTitle}</p>
            <p><strong>目标企业：</strong>{selectedOrder.targetCompany}</p>
            <p><strong>截止时间：</strong>{new Date(selectedOrder.deadline).toLocaleString('zh-CN')}</p>
            <p><strong>触发词：</strong><Tag color="red">{selectedOrder.sensitiveWords}</Tag></p>
            <p><strong>交办方式：</strong><Tag color={selectedOrder.dispatchType === 'auto' ? 'blue' : 'purple'}>{selectedOrder.dispatchType === 'auto' ? '自动识别' : '人工标记'}</Tag></p>
            <p><strong>处理轨迹：</strong></p>
            <Timeline items={[
              { color: 'green', children: `${new Date(selectedOrder.createdAt).toLocaleString('zh-CN')} — ${selectedOrder.dispatchType === 'auto' ? '系统自动识别敏感词并生成交办单' : '人工标记并生成交办单'}` },
              { color: 'blue', children: selectedOrder.status !== 'pending' ? '目标企业已签收' : '等待企业签收...' },
              { color: selectedOrder.status === 'completed' ? 'green' : 'gray', children: selectedOrder.status === 'completed' ? '已办结' : selectedOrder.status === 'rejected' ? '已退回' : '待办结' },
            ]} />
          </div>
        )}
      </Modal>

      {/* Create Dispatch Modal */}
      <Modal title="手动交办" open={formVisible} onOk={handleCreateDispatch} onCancel={() => { setFormVisible(false); form.resetFields(); }} width={550}>
        <Form form={form} layout="vertical">
          <Form.Item name="complaintTitle" label="诉求标题" rules={[{required:true,message:'请输入'}]}><Input placeholder="关联的诉求标题" /></Form.Item>
          <Form.Item name="sensitiveWords" label="敏感词" rules={[{required:true}]}><Input placeholder="如：停水、泄漏、安全" /></Form.Item>
          <Form.Item name="urgencyLevel" label="紧急程度" rules={[{required:true}]}><Select options={[{value:'一般',label:'一般'},{value:'紧急',label:'紧急'},{value:'特急',label:'特急'}]} /></Form.Item>
          <Form.Item name="targetCompany" label="交办企业" rules={[{required:true}]}><Select options={['宜昌市供水总公司','宜昌中燃','点军区供水有限公司','华润燃气','夷陵区燃气有限公司','宜昌蓝天气体'].map(c=>({value:c,label:c}))} /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default DispatchOrders;
