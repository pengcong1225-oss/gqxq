import React from 'react';
import { Card, Row, Col, Statistic, Table, Tag, Select, DatePicker, Space } from 'antd';
import { ArrowUpOutlined, FileTextOutlined, CheckCircleOutlined, ClockCircleOutlined, WarningOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import DemoDataNotice from '../components/DemoDataNotice';

const trendOption = {
  tooltip: { trigger: 'axis' },
  legend: { data: ['供水诉求', '燃气诉求', '办结量'] },
  grid: { left: 60, right: 30, top: 40, bottom: 30 },
  xAxis: { type: 'category', data: ['5/1','5/5','5/10','5/15','5/20','5/25','5/28'] },
  yAxis: { type: 'value' },
  series: [
    { name: '供水诉求', type: 'line', smooth: true, data: [580,620,650,710,680,700,683], itemStyle: { color: '#1677ff' }, areaStyle: { color: { type: 'linear', x:0,y:0,x2:0,y2:1, colorStops: [{offset:0,color:'rgba(22,119,255,0.3)'},{offset:1,color:'rgba(22,119,255,0.02)'}] } } },
    { name: '燃气诉求', type: 'line', smooth: true, data: [480,510,540,580,560,570,564], itemStyle: { color: '#fa8c16' }, areaStyle: { color: { type: 'linear', x:0,y:0,x2:0,y2:1, colorStops: [{offset:0,color:'rgba(250,140,22,0.3)'},{offset:1,color:'rgba(250,140,22,0.02)'}] } } },
    { name: '办结量', type: 'line', smooth: true, data: [420,480,510,560,530,550,540], itemStyle: { color: '#52c41a' }, lineStyle: { type: 'dashed' } },
  ]
};

const regionOption = {
  tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
  grid: { left: 80, right: 40, top: 10, bottom: 20 },
  xAxis: { type: 'value' },
  yAxis: { type: 'category', data: ['西陵区','伍家岗区','点军区','猇亭区','夷陵区','宜都市','枝江市'] },
  series: [{
    type: 'bar', data: [356,298,215,178,200,165,142],
    itemStyle: { color: (p: any) => ['#ff4d4f','#ff8c42','#ffd54f','#50d0a0','#ffd54f','#50d0a0','#50d0a0'][p.dataIndex] },
    label: { show: true, position: 'right', color: '#666' }
  }]
};

const pieOption = {
  tooltip: { trigger: 'item' },
  legend: { bottom: 0 },
  series: [{
    type: 'pie', radius: ['45%', '70%'], center: ['50%', '45%'],
    label: { formatter: '{b}\n{d}%' },
    data: [
      { value: 443, name: '水压/气压不足' }, { value: 342, name: '管道问题' },
      { value: 218, name: '水质/用气安全' }, { value: 154, name: '表具故障' },
      { value: 90, name: '其他' }
    ]
  }]
};

const hotTopics = [
  { key: 1, keyword: '水压不足', count: 245, trend: '↑12%', relatedCompany: '宜昌市供水总公司' },
  { key: 2, keyword: '燃气气压不足', count: 198, trend: '↑8%', relatedCompany: '宜昌中燃' },
  { key: 3, keyword: '管道漏水', count: 186, trend: '↓3%', relatedCompany: '点军区供水有限公司' },
  { key: 4, keyword: '管道漏气', count: 156, trend: '↑15%', relatedCompany: '华润燃气' },
  { key: 5, keyword: '水质问题', count: 120, trend: '↓5%', relatedCompany: '夷陵区水务公司' },
  { key: 6, keyword: '液化气配送', count: 98, trend: '↑20%', relatedCompany: '宜昌蓝天气体' },
  { key: 7, keyword: '停水未通知', count: 85, trend: '↑10%', relatedCompany: '宜昌市供水总公司' },
];

const Analysis: React.FC = () => (
  <div>
    <DemoDataNotice batch="G5/G6" />
    <h2 style={{ marginBottom: 16 }}>数据分析</h2>
    <Row gutter={12} style={{ marginBottom: 16 }}>
      <Col span={4}><Card size="small"><Statistic title="本月诉求总量" value={1247} prefix={<FileTextOutlined />} suffix={<span style={{fontSize:13,color:'#ff4d4f'}}><ArrowUpOutlined /> 12.3%</span>} /></Card></Col>
      <Col span={4}><Card size="small"><Statistic title="已办结" value={978} prefix={<CheckCircleOutlined />} valueStyle={{color:'#52c41a'}} /></Card></Col>
      <Col span={4}><Card size="small"><Statistic title="办结率" value={78.4} suffix="%" valueStyle={{color:'#52c41a'}} /></Card></Col>
      <Col span={4}><Card size="small"><Statistic title="平均处理时长" value={4.2} suffix="h" prefix={<ClockCircleOutlined />} /></Card></Col>
      <Col span={4}><Card size="small"><Statistic title="超时未办结" value={15} prefix={<WarningOutlined />} valueStyle={{color:'#faad14'}} /></Card></Col>
      <Col span={4}><Card size="small"><Statistic title="敏感诉求" value={28} prefix={<WarningOutlined />} valueStyle={{color:'#ff4d4f'}} /></Card></Col>
    </Row>
    <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
      <Col span={14}><Card title="诉求趋势"><ReactECharts option={trendOption} style={{ height: 300 }} /></Card></Col>
      <Col span={10}><Card title="诉求分类分布"><ReactECharts option={pieOption} style={{ height: 300 }} /></Card></Col>
    </Row>
    <Row gutter={[16, 16]}>
      <Col span={14}><Card title="区域诉求排名"><ReactECharts option={regionOption} style={{ height: 280 }} /></Card></Col>
      <Col span={10}>
        <Card title="热点问题" extra={<Space><Select size="small" defaultValue="week" options={[{value:'week',label:'近7天'},{value:'month',label:'近30天'}]} /><DatePicker size="small" /></Space>}>
          <Table dataSource={hotTopics} size="small" pagination={false} columns={[
            { title: '关键词', dataIndex: 'keyword', width: 120 },
            { title: '数量', dataIndex: 'count', width: 60, sorter: (a:any,b:any) => a.count - b.count },
            { title: '趋势', dataIndex: 'trend', width: 60, render: (t:string) => <span style={{color: t.includes('↑') ? '#ff4d4f' : '#52c41a'}}>{t}</span> },
            { title: '关联企业', dataIndex: 'relatedCompany', ellipsis: true },
          ]} />
        </Card>
      </Col>
    </Row>
  </div>
);

export default Analysis;
