import React from 'react';
import { Card, Statistic, Row, Col, Table, Tag, Button } from 'antd';
import { ArrowUpOutlined, FileTextOutlined, WarningOutlined, ClockCircleOutlined, CheckCircleOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import ReactECharts from 'echarts-for-react';

const Dashboard: React.FC = () => {
  const navigate = useNavigate();

  const trendOption = {
    tooltip: { trigger: 'axis' },
    legend: { data: ['供水诉求', '燃气诉求'] },
    grid: { left: 50, right: 20, top: 40, bottom: 30 },
    xAxis: { type: 'category', data: ['5/22','5/23','5/24','5/25','5/26','5/27','5/28'] },
    yAxis: { type: 'value' },
    series: [
      { name: '供水诉求', type: 'line', smooth: true, data: [620, 580, 650, 720, 680, 710, 683], itemStyle: { color: '#1677ff' } },
      { name: '燃气诉求', type: 'line', smooth: true, data: [520, 490, 540, 590, 560, 580, 564], itemStyle: { color: '#fa8c16' } }
    ]
  };

  const pieOption = {
    tooltip: { trigger: 'item' },
    legend: { orient: 'vertical', right: 10, top: 'center' },
    series: [{
      type: 'pie', radius: ['40%', '65%'], center: ['40%', '50%'],
      data: [
        { value: 443, name: '水压/气压不足' }, { value: 342, name: '管道问题' },
        { value: 218, name: '水质/用气安全' }, { value: 154, name: '表具故障' }, { value: 90, name: '其他' }
      ]
    }]
  };

  const recentCols = [
    { title: '诉求编号', dataIndex: 'complaintNo', key: 'no', width: 150, render: (v: string) => <a onClick={() => navigate('/complaints/1')}>{v}</a> },
    { title: '标题', dataIndex: 'title', key: 'title', ellipsis: true },
    { title: '来源', dataIndex: 'source', key: 'source', width: 100 },
    { title: '类型', dataIndex: 'complaintType', key: 'type', width: 80, render: (t: string) => <Tag>{t}</Tag> },
    { title: '紧急程度', dataIndex: 'urgencyLevel', key: 'urgency', width: 100, render: (t: string) => <Tag color={t === '特急' ? 'red' : t === '紧急' ? 'orange' : 'blue'}>{t}</Tag> },
    { title: '状态', dataIndex: 'status', key: 'status', width: 80, render: (s: string) => <Tag color={s === 'resolved' ? 'green' : 'processing'}>{s === 'resolved' ? '已办结' : '处理中'}</Tag> },
    { title: '时间', dataIndex: 'createdAt', key: 'time', width: 120, render: (t: string) => new Date(t).toLocaleDateString('zh-CN') },
  ];

  const recentData = [
    { key: 1, complaintNo: 'CS202605280001', title: '西陵区水管爆裂导致大面积停水', source: '12345热线', complaintType: '投诉', urgencyLevel: '特急', status: 'processing', createdAt: '2026-05-28T08:30:00' },
    { key: 2, complaintNo: 'CS202605280002', title: '伍家岗区燃气气压不足影响做饭', source: '市民之家', complaintType: '投诉', urgencyLevel: '紧急', status: 'resolved', createdAt: '2026-05-28T09:15:00' },
    { key: 3, complaintNo: 'CS202605280003', title: '点军区自来水质浑浊有异味', source: '移动端', complaintType: '投诉', urgencyLevel: '紧急', status: 'processing', createdAt: '2026-05-28T10:00:00' },
    { key: 4, complaintNo: 'CS202605280004', title: '咨询天然气报装流程及费用', source: '网页端', complaintType: '咨询', urgencyLevel: '一般', status: 'resolved', createdAt: '2026-05-28T10:45:00' },
    { key: 5, complaintNo: 'CS202605280005', title: '夷陵区液化气配送时间过长建议', source: '移动端', complaintType: '建议', urgencyLevel: '一般', status: 'resolved', createdAt: '2026-05-28T11:30:00' },
  ];

  return (
    <div>
      <Row gutter={[16, 16]}>
        <Col span={4}><Card hoverable onClick={() => navigate('/complaints')}><Statistic title="今日诉求" value={1247} prefix={<FileTextOutlined />} suffix={<span style={{fontSize:14,color:'#52c41a'}}><ArrowUpOutlined /> 12.3%</span>} /></Card></Col>
        <Col span={4}><Card hoverable onClick={() => navigate('/complaints')}><Statistic title="供水诉求" value={683} valueStyle={{color:'#1677ff'}} /></Card></Col>
        <Col span={4}><Card hoverable onClick={() => navigate('/complaints')}><Statistic title="燃气诉求" value={564} valueStyle={{color:'#fa8c16'}} /></Card></Col>
        <Col span={4}><Card hoverable onClick={() => navigate('/dispatch')}><Statistic title="敏感诉求" value={28} prefix={<WarningOutlined />} valueStyle={{color:'#ff4d4f'}} /></Card></Col>
        <Col span={4}><Card hoverable onClick={() => navigate('/dispatch')}><Statistic title="超时未办结" value={15} prefix={<ClockCircleOutlined />} valueStyle={{color:'#faad14'}} /></Card></Col>
        <Col span={4}><Card hoverable onClick={() => navigate('/analysis')}><Statistic title="已办结率" value={78.5} suffix="%" prefix={<CheckCircleOutlined />} valueStyle={{color:'#52c41a'}} /></Card></Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={14}>
          <Card title="诉求趋势 (近7天)" extra={<Button type="link" size="small" onClick={() => navigate('/analysis')}>查看更多 →</Button>}>
            <ReactECharts option={trendOption} style={{ height: 280 }} />
          </Card>
        </Col>
        <Col span={10}>
          <Card title="诉求分类分布">
            <ReactECharts option={pieOption} style={{ height: 280 }} />
          </Card>
        </Col>
      </Row>

      <Card title="最新诉求" style={{ marginTop: 16 }}
        extra={<Button type="link" onClick={() => navigate('/complaints')}>查看全部诉求 →</Button>}>
        <Table columns={recentCols} dataSource={recentData} pagination={false} size="small" />
      </Card>
    </div>
  );
};

export default Dashboard;
