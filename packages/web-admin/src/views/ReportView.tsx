import React, { useState } from 'react';
import { Table, Tag, Space, Button, Card, Row, Col, Statistic, Select, DatePicker, Modal, Form, Input, Radio, Tooltip } from 'antd';
import { FilePdfOutlined, FileWordOutlined, FileExcelOutlined, DownloadOutlined, EyeOutlined, ReloadOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import DemoDataNotice from '../components/DemoDataNotice';

const initialReports = [
  { key: 1, title: '2026年5月28日诉求日报', type: 'daily', date: '2026-05-28', period: '2026-05-28', status: 'completed', generatedBy: '系统自动', size: '256KB', complaints: 1247 },
  { key: 2, title: '2026年5月27日诉求日报', type: 'daily', date: '2026-05-27', period: '2026-05-27', status: 'completed', generatedBy: '系统自动', size: '248KB', complaints: 1198 },
  { key: 3, title: '2026年第22周周报', type: 'weekly', date: '2026-05-25', period: '2026-05-19 ~ 2026-05-25', status: 'completed', generatedBy: '系统自动', size: '1.2MB', complaints: 8542 },
  { key: 4, title: '2026年第21周周报', type: 'weekly', date: '2026-05-18', period: '2026-05-12 ~ 2026-05-18', status: 'completed', generatedBy: '系统自动', size: '1.1MB', complaints: 8120 },
  { key: 5, title: '2026年5月月报', type: 'monthly', date: '2026-05-01', period: '2026-05-01 ~ 2026-05-31', status: 'generating', generatedBy: '系统自动', size: '-', complaints: 35200 },
  { key: 6, title: '2026年4月月报', type: 'monthly', date: '2026-04-30', period: '2026-04-01 ~ 2026-04-30', status: 'completed', generatedBy: '系统自动', size: '3.5MB', complaints: 33800 },
  { key: 7, title: '2026年Q1季度分析报告', type: 'custom', date: '2026-04-05', period: '2026-01-01 ~ 2026-03-31', status: 'completed', generatedBy: '管理员', size: '5.8MB', complaints: 98500 },
  { key: 8, title: '西陵区供水诉求专项分析', type: 'custom', date: '2026-05-15', period: '2026-04-15 ~ 2026-05-15', status: 'completed', generatedBy: '管理员', size: '2.1MB', complaints: 4520 },
];

const ReportView: React.FC = () => {
  const [reports, setReports] = useState(initialReports);
  const [formVisible, setFormVisible] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewReport, setPreviewReport] = useState<any>(null);
  const [form] = Form.useForm();

  const handleGenerate = () => {
    form.validateFields().then(vals => {
      const dateRange = vals.dateRange || [dayjs(), dayjs()];
      const typeMap: Record<string, string> = { daily: '日报', weekly: '周报', monthly: '月报', custom: '自定义报告' };
      const title = vals.title || `${dateRange[0].format('YYYY年MM月DD日')} ${typeMap[vals.type]}`;
      const period = vals.type === 'custom' ? `${dateRange[0].format('YYYY-MM-DD')} ~ ${dateRange[1].format('YYYY-MM-DD')}` : dateRange[0].format('YYYY-MM-DD');
      const newKey = Math.max(...reports.map(r => r.key), 0) + 1;
      const newReport = {
        key: newKey, title, type: vals.type, date: dayjs().format('YYYY-MM-DD'), period,
        status: 'generating', generatedBy: '当前用户', size: '-', complaints: Math.floor(Math.random() * 5000) + 500
      };
      setReports([newReport, ...reports]);
      setFormVisible(false); form.resetFields();
      // 本批次不落库：报告生成接口与持久化属批次 G5，“生成报告”按钮已禁用（见 DemoDataNotice）
      setTimeout(() => {
        setReports(prev => prev.map(r => r.key === newKey ? { ...r, status: 'completed', size: (Math.random() * 3 + 0.5).toFixed(1) + 'MB' } : r));
      }, 3000);
    });
  };

  const columns = [
    { title: '报告标题', dataIndex: 'title', ellipsis: true },
    { title: '类型', dataIndex: 'type', width: 80, render: (t: string) => {
      const m: Record<string,{color:string;text:string}> = { daily:{color:'blue',text:'日报'}, weekly:{color:'green',text:'周报'}, monthly:{color:'orange',text:'月报'}, custom:{color:'purple',text:'自定义'} };
      return <Tag color={m[t]?.color}>{m[t]?.text}</Tag>;
    }},
    { title: '统计周期', dataIndex: 'period', width: 220, ellipsis: true },
    { title: '诉求数', dataIndex: 'complaints', width: 80 },
    { title: '生成日期', dataIndex: 'date', width: 110 },
    { title: '生成方式', dataIndex: 'generatedBy', width: 90, render: (t: string) => <Tag>{t}</Tag> },
    { title: '大小', dataIndex: 'size', width: 70 },
    { title: '状态', dataIndex: 'status', width: 80, render: (s: string) => <Tag color={s === 'completed' ? 'success' : 'processing'}>{s === 'completed' ? '已完成' : s === 'generating' ? '生成中' : '失败'}</Tag> },
    { title: '操作', width: 220, fixed: 'right' as const,
      render: (_: any, r: any) => <Space>
        <Button type="link" size="small" icon={<EyeOutlined />} disabled={r.status !== 'completed'} onClick={() => { setPreviewReport(r); setPreviewVisible(true); }}>预览</Button>
        <Tooltip title="功能未实现（批次 G5）"><span><Button type="link" size="small" icon={<FileWordOutlined />} disabled>Word</Button></span></Tooltip>
        <Tooltip title="功能未实现（批次 G5）"><span><Button type="link" size="small" icon={<FileExcelOutlined />} disabled>Excel</Button></span></Tooltip>
      </Space> },
  ];

  return (
    <div>
      <DemoDataNotice batch="G5" />
      <h2 style={{ marginBottom: 16 }}>分析报告</h2>
      <Row gutter={12} style={{ marginBottom: 16 }}>
        <Col span={4}><Card size="small"><Statistic title="报告总数" value={reports.length} prefix={<FilePdfOutlined />} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="日报" value={reports.filter(r=>r.type==='daily').length} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="周报" value={reports.filter(r=>r.type==='weekly').length} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="月报" value={reports.filter(r=>r.type==='monthly').length} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="自定义报告" value={reports.filter(r=>r.type==='custom').length} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="生成中" value={reports.filter(r=>r.status==='generating').length} valueStyle={{color:'#1677ff'}} /></Card></Col>
      </Row>
      <Card>
        <Space style={{ marginBottom: 16 }} wrap>
          <Select defaultValue="all" style={{ width: 100 }} options={[{value:'all',label:'全部类型'},{value:'daily',label:'日报'},{value:'weekly',label:'周报'},{value:'monthly',label:'月报'},{value:'custom',label:'自定义'}]} />
          <DatePicker.RangePicker />
          <Tooltip title="功能未实现（批次 G5）"><span><Button type="primary" icon={<PlusOutlined />} disabled>生成报告</Button></span></Tooltip>
          <Tooltip title="功能未实现（批次 G5）"><span><Button icon={<ReloadOutlined />} disabled>刷新</Button></span></Tooltip>
        </Space>
        <Table columns={columns} dataSource={reports} size="middle" scroll={{ x: 1300 }} pagination={{ defaultPageSize: 10 }} />
      </Card>

      {/* Generate Report Modal */}
      <Modal title="生成新报告" open={formVisible} onOk={handleGenerate} onCancel={() => { setFormVisible(false); form.resetFields(); }} width={550}>
        <Form form={form} layout="vertical" initialValues={{ type: 'daily' }}>
          <Form.Item name="type" label="报告类型" rules={[{required:true}]}>
            <Radio.Group>
              <Radio.Button value="daily">日报</Radio.Button>
              <Radio.Button value="weekly">周报</Radio.Button>
              <Radio.Button value="monthly">月报</Radio.Button>
              <Radio.Button value="custom">自定义</Radio.Button>
            </Radio.Group>
          </Form.Item>
          <Form.Item name="title" label="报告标题（可选）"><Input placeholder="留空则自动生成标题" /></Form.Item>
          <Form.Item name="dateRange" label="统计时间范围" rules={[{required:true}]}><DatePicker.RangePicker style={{width:'100%'}} /></Form.Item>
        </Form>
      </Modal>

      {/* Preview Modal */}
      <Modal title={previewReport?.title} open={previewVisible} onCancel={() => setPreviewVisible(false)} footer={<Button onClick={() => setPreviewVisible(false)}>关闭</Button>} width={700}>
        {previewReport && (
          <div style={{ lineHeight: 2 }}>
            <h3>报告概览</h3>
            <p><strong>报告类型：</strong><Tag>{previewReport.type === 'daily' ? '日报' : previewReport.type === 'weekly' ? '周报' : previewReport.type === 'monthly' ? '月报' : '自定义'}</Tag></p>
            <p><strong>统计周期：</strong>{previewReport.period}</p>
            <p><strong>诉求总量：</strong>{previewReport.complaints.toLocaleString()} 件</p>
            <p><strong>办结率：</strong>{(70 + Math.random() * 25).toFixed(1)}%</p>
            <p><strong>生成时间：</strong>{previewReport.date}</p>
            <p><strong>文件大小：</strong>{previewReport.size}</p>
            <div style={{ background: '#f5f5f5', padding: 16, borderRadius: 8, marginTop: 12 }}>
              <p>【报告正文预览】</p>
              <p>本报告统计期间共受理诉求 {previewReport.complaints.toLocaleString()} 件，其中供水类占比约55%，燃气类占比约45%。</p>
              <p>西陵区、伍家岗区为诉求高发区域，主要问题集中在管道漏水和气压不足两个方面。</p>
              <p>较上一统计周期诉求总量环比上升4.2%，建议加强相关区域的巡检力度。</p>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default ReportView;
