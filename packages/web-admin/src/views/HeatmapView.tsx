import React, { useState } from 'react';
import { Card, Row, Col, Select, DatePicker, Space, Table, Tag, Statistic, Slider } from 'antd';
import { FireOutlined, EnvironmentOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import DemoDataNotice from '../components/DemoDataNotice';

const heatData = Array.from({ length: 120 }, () => [111.2 + Math.random() * 0.5, 30.6 + Math.random() * 0.4, Math.floor(Math.random() * 80)]);
const facilities = [
  { name: '一水厂', value: [111.28, 30.70] }, { name: '二水厂', value: [111.32, 30.68] }, { name: '三水厂', value: [111.35, 30.66] },
  { name: '伍家岗门站', value: [111.35, 30.65] }, { name: '点军门站', value: [111.25, 30.62] },
  { name: '中心泵站', value: [111.30, 30.69] }, { name: '猇亭调压站', value: [111.40, 30.60] },
];

const hotAreas = [
  { key: 1, area: '西陵区沿江大道片区', count: 156, level: '高', trend: '↑', complaints: ['水压不足','管道老化'] },
  { key: 2, area: '伍家岗区中南路片区', count: 128, level: '高', trend: '↑', complaints: ['燃气气压','施工影响'] },
  { key: 3, area: '西陵区城东大道片区', count: 98, level: '中', trend: '→', complaints: ['水质问题','水表故障'] },
  { key: 4, area: '点军区江南大道片区', count: 85, level: '中', trend: '↓', complaints: ['停水通知','管道维修'] },
  { key: 5, area: '夷陵区发展大道片区', count: 72, level: '中', trend: '↑', complaints: ['液化气配送','气价问题'] },
  { key: 6, area: '猇亭区先锋路片区', count: 58, level: '低', trend: '↓', complaints: ['工业用气','安全巡检'] },
];

const HeatmapView: React.FC = () => {
  const [timeRange, setTimeRange] = useState('7');
  const [complaintType, setComplaintType] = useState<string | undefined>();

  const mapOption = {
    tooltip: { trigger: 'item' },
    grid: { left: 0, right: 0, top: 0, bottom: 0 },
    xAxis: { show: false, min: 111.15, max: 111.55 },
    yAxis: { show: false, min: 30.55, max: 30.78 },
    series: [
      { type: 'scatter', data: heatData, symbolSize: (v: number[]) => Math.max(v[2] * 0.2, 3),
        itemStyle: { color: 'rgba(255,80,40,0.45)' }, emphasis: { scale: 1.5 } },
      { type: 'scatter', data: facilities, symbolSize: 14,
        itemStyle: { color: '#1677ff', borderColor: '#fff', borderWidth: 1 },
        label: { show: true, position: 'right', fontSize: 10, color: '#333', formatter: '{b}' } },
    ]
  };

  return (
    <div>
      <DemoDataNotice batch="G6 之后" />
      <h2 style={{ marginBottom: 16 }}>热力图管理</h2>
      <Row gutter={12} style={{ marginBottom: 16 }}>
        <Col span={4}><Card size="small"><Statistic title="热区总数" value={6} prefix={<FireOutlined />} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="高发热区" value={2} valueStyle={{color:'#ff4d4f'}} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="中发热区" value={3} valueStyle={{color:'#fa8c16'}} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="低发热区" value={1} valueStyle={{color:'#52c41a'}} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="设施点位" value={facilities.length} prefix={<EnvironmentOutlined />} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="诉求密度" value={42} suffix="件/km²" /></Card></Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col span={16}>
          <Card title="GIS热力图" extra={
            <Space>
              <Select value={timeRange} onChange={setTimeRange} size="small" style={{ width: 100 }}
                options={[{value:'7',label:'近7天'},{value:'30',label:'近30天'},{value:'custom',label:'自定义'}]} />
              <Select placeholder="诉求类型" allowClear size="small" style={{ width: 100 }} onChange={setComplaintType}
                options={[{value:'complaint',label:'投诉'},{value:'consult',label:'咨询'},{value:'suggest',label:'建议'}]} />
            </Space>
          }>
            <ReactECharts option={mapOption} style={{ height: 400 }} />
            <div style={{marginTop:8, fontSize:12, color:'#999'}}>图例：<span style={{color:'#ff5028'}}>●</span> 诉求高密度  <span style={{color:'#ffa080'}}>●</span> 诉求低密度  <span style={{color:'#1677ff'}}>●</span> 重要设施</div>
          </Card>
        </Col>
        <Col span={8}>
          <Card title="热区详情">
            <Table dataSource={hotAreas} size="small" pagination={false} columns={[
              { title: '热区', dataIndex: 'area', width: 140, ellipsis: true },
              { title: '数量', dataIndex: 'count', width: 50 },
              { title: '等级', dataIndex: 'level', width: 50, render: (l: string) => <Tag color={l==='高'?'red':l==='中'?'orange':'green'}>{l}</Tag> },
              { title: '趋势', dataIndex: 'trend', width: 40, render: (t: string) => <span style={{color:t==='↑'?'#ff4d4f':t==='↓'?'#52c41a':'#999'}}>{t}</span> },
              { title: '主要问题', dataIndex: 'complaints', render: (c: string[]) => c.map(x => <Tag key={x} style={{marginBottom:2}}>{x}</Tag>) },
            ]} />
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default HeatmapView;
