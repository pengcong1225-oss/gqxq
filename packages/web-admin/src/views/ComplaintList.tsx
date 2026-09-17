import React, { useState, useMemo } from 'react';
import { Table, Tag, Space, Input, Select, DatePicker, Button, Card, Row, Col, Statistic, Tooltip } from 'antd';
import { SearchOutlined, ExportOutlined, ImportOutlined, EyeOutlined, FileTextOutlined, WarningOutlined, ClockCircleOutlined, CheckCircleOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';

const { RangePicker } = DatePicker;

const mockComplaints = Array.from({ length: 86 }, (_, i) => {
  const sources = ['市民之家', '12345热线', '移动端', '网页端'];
  const types = ['投诉', '咨询', '建议', '举报'];
  const urgencies = ['一般', '紧急', '特急'];
  const statuses = ['pending', 'processing', 'resolved', 'closed'];
  const correctionStatuses = ['none', 'pending', 'corrected', 'failed'];
  const syncStatuses = ['not_synced', 'syncing', 'success', 'failed'];
  const bizTypes = ['water', 'gas'];
  const biz = bizTypes[i % 2];
  const district = ['西陵区','伍家岗区','点军区','猇亭区','夷陵区','宜都市','枝江市'][i % 7];
  const titles = biz === 'water'
    ? ['水压不足无法用水','自来水有异味','管道漏水无人修','水表计量异常','停水未通知','二次供水水质问题','水费异常高']
    : ['燃气气压不足','燃气管道漏气','燃气表不走字','停气未提前通知','液化气配送超时','燃气灶打不着火','天然气缴费未到账'];
  return {
    key: i + 1,
    complaintNo: 'CS202605' + String(i + 1).padStart(4, '0'),
    title: titles[i % 7],
    source: sources[i % 4],
    sourceSystem: i % 3 === 0 ? '宜接就办' : '本系统',
    sourceId: 'YJJB' + String(2026060000 + i + 1),
    correctionStatus: correctionStatuses[i % 4],
    correctionConfidence: [0.92, 0.43, 0.81, 0.66][i % 4],
    syncStatus: syncStatuses[i % 4],
    ruleResult: '规则引擎: ' + (biz === 'water' ? '供水' : '燃气') + '/' + types[i % 4],
    businessType: biz,
    complaintType: types[i % 4],
    urgencyLevel: urgencies[i % 3],
    districtName: district,
    companyName: biz === 'water' ? ['宜昌市供水总公司','点军区供水有限公司','夷陵区水务公司'][i % 3] : ['宜昌中燃','华润燃气','夷陵区燃气有限公司','宜昌蓝天气体'][i % 4],
    status: statuses[i % 4],
    isSensitive: i % 15 === 0,
    createdAt: new Date(Date.now() - i * 3600000 * (2 + i % 5)).toISOString(),
  };
});

const ComplaintList: React.FC = () => {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<string | undefined>();
  const [filterStatus, setFilterStatus] = useState<string | undefined>();
  const [filterBiz, setFilterBiz] = useState<string | undefined>();

  const filtered = useMemo(() => {
    let data = mockComplaints;
    if (search) data = data.filter(c => c.title.includes(search) || c.complaintNo.includes(search));
    if (filterType) data = data.filter(c => c.complaintType === filterType);
    if (filterStatus) data = data.filter(c => c.status === filterStatus);
    if (filterBiz) data = data.filter(c => c.businessType === filterBiz);
    return data;
  }, [search, filterType, filterStatus, filterBiz]);

  const stats = {
    total: mockComplaints.length,
    pending: mockComplaints.filter(c => c.status === 'pending').length,
    processing: mockComplaints.filter(c => c.status === 'processing').length,
    resolved: mockComplaints.filter(c => c.status === 'resolved').length,
    sensitive: mockComplaints.filter(c => c.isSensitive).length,
  };

  const columns = [
    { title: '诉求编号', dataIndex: 'complaintNo', width: 150, render: (v: string) => <a onClick={() => navigate('/complaints/1')}>{v}</a> },
    { title: '标题', dataIndex: 'title', ellipsis: true,
      render: (t: string, r: any) => <>{r.isSensitive && <Tag color="red" style={{marginRight:4}}>敏感</Tag>}<Tooltip title={t}>{t}</Tooltip></> },
    { title: '业务类型', dataIndex: 'businessType', width: 80, render: (t: string) => <Tag color={t === 'water' ? 'blue' : 'orange'}>{t === 'water' ? '供水' : '燃气'}</Tag> },
    { title: '诉求类型', dataIndex: 'complaintType', width: 80, render: (t: string) => <Tag>{t}</Tag> },
    { title: '紧急程度', dataIndex: 'urgencyLevel', width: 90,
      render: (t: string) => <Tag color={t === '特急' ? 'red' : t === '紧急' ? 'orange' : 'blue'}>{t}</Tag> },
    { title: '来源', dataIndex: 'source', width: 90 },
    { title: '来源系统', dataIndex: 'sourceSystem', width: 100, render: (v: string) => <Tag color={v === '宜接就办' ? 'blue' : 'default'}>{v}</Tag> },
    { title: '纠偏', dataIndex: 'correctionStatus', width: 90, render: (v: string, r: any) => {
      const map: Record<string, { color: string; text: string }> = { none:{color:'default',text:'无需'}, pending:{color:'warning',text:'待纠偏'}, corrected:{color:'success',text:'已纠偏'}, failed:{color:'error',text:'失败'} };
      return <Tooltip title={`置信度 ${Math.round(r.correctionConfidence * 100)}%`}><Tag color={map[v].color}>{map[v].text}</Tag></Tooltip>;
    } },
    { title: '同步', dataIndex: 'syncStatus', width: 90, render: (v: string) => {
      const map: Record<string, { color: string; text: string }> = { not_synced:{color:'default',text:'未同步'}, syncing:{color:'processing',text:'同步中'}, success:{color:'success',text:'成功'}, failed:{color:'error',text:'失败'} };
      return <Tag color={map[v].color}>{map[v].text}</Tag>;
    } },
    { title: '区域', dataIndex: 'districtName', width: 80 },
    { title: '责任企业', dataIndex: 'companyName', width: 140, ellipsis: true },
    { title: '状态', dataIndex: 'status', width: 80,
      render: (s: string) => {
        const map: Record<string, { color: string; text: string }> = { pending: {color:'default',text:'待处理'}, processing: {color:'processing',text:'处理中'}, resolved: {color:'success',text:'已办结'}, closed: {color:'default',text:'已关闭'} };
        return <Tag color={map[s]?.color}>{map[s]?.text}</Tag>;
      } },
    { title: '时间', dataIndex: 'createdAt', width: 110, render: (t: string) => new Date(t).toLocaleDateString('zh-CN') },
    { title: '操作', width: 60, fixed: 'right' as const, render: () => <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => navigate('/complaints/1')}>详情</Button> },
  ];

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>诉求管理</h2>
      <Row gutter={12} style={{ marginBottom: 16 }}>
        <Col span={4}><Card size="small"><Statistic title="总诉求" value={stats.total} prefix={<FileTextOutlined />} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="待处理" value={stats.pending} valueStyle={{color:'#faad14'}} prefix={<ClockCircleOutlined />} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="处理中" value={stats.processing} valueStyle={{color:'#1677ff'}} prefix={<FileTextOutlined />} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="已办结" value={stats.resolved} valueStyle={{color:'#52c41a'}} prefix={<CheckCircleOutlined />} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="敏感诉求" value={stats.sensitive} valueStyle={{color:'#ff4d4f'}} prefix={<WarningOutlined />} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="办结率" value={78.5} suffix="%" valueStyle={{color:'#52c41a'}} /></Card></Col>
      </Row>
      <Card>
        <Space style={{ marginBottom: 16 }} wrap>
          <Input placeholder="搜索编号/标题" prefix={<SearchOutlined />} value={search} onChange={e => setSearch(e.target.value)} style={{ width: 220 }} allowClear />
          <Select placeholder="业务类型" allowClear style={{ width: 110 }} onChange={setFilterBiz} options={[{value:'water',label:'供水'},{value:'gas',label:'燃气'}]} />
          <Select placeholder="诉求类型" allowClear style={{ width: 110 }} onChange={setFilterType} options={[{value:'投诉',label:'投诉'},{value:'咨询',label:'咨询'},{value:'建议',label:'建议'},{value:'举报',label:'举报'}]} />
          <Select placeholder="状态" allowClear style={{ width: 110 }} onChange={setFilterStatus} options={[{value:'pending',label:'待处理'},{value:'processing',label:'处理中'},{value:'resolved',label:'已办结'},{value:'closed',label:'已关闭'}]} />
          <RangePicker />
          <Button type="primary" icon={<ExportOutlined />}>导出Excel</Button>
          <Button icon={<ImportOutlined />}>批量导入</Button>
        </Space>
        <Table columns={columns} dataSource={filtered} size="middle" scroll={{ x: 1400 }}
          pagination={{ defaultPageSize: 15, showSizeChanger: true, showTotal: (total) => `共 ${total} 条诉求` }} />
      </Card>
    </div>
  );
};

export default ComplaintList;
