import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Descriptions, Tag, Timeline, Row, Col, Button, Space, Divider } from 'antd';
import { ArrowLeftOutlined, EnvironmentOutlined, ClockCircleOutlined, CheckCircleOutlined, SendOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';

const complaintData: Record<string, any> = {
  '1': {
    complaintNo: 'CS202605280001', title: '西陵区水管爆裂导致大面积停水', content: '西陵区沿江大道188号附近供水主管道爆裂，导致周边3个小区大面积停水，涉及约2000户居民，目前已超过6小时未恢复供水，居民生活受到严重影响，希望相关部门尽快抢修。',
    source: '12345热线', businessType: 'water', complaintType: '投诉', urgencyLevel: '特急',
    districtName: '西陵区', companyName: '宜昌市供水总公司', status: 'processing',
    isSensitive: true, locationLng: 111.286, locationLat: 30.708,
    createdAt: '2026-05-28T08:30:00', receivedAt: '2026-05-28T08:32:00',
    dispatchInfo: { orderNo: 'JB202605280001', deadline: '2026-05-29T18:00:00', status: 'processing' },
    processes: [
      { time: '2026-05-28T08:32:00', action: '系统接收', operator: '系统', content: '诉求已自动接入，完成数据清洗和GIS关联', color: 'blue' },
      { time: '2026-05-28T08:35:00', action: 'NLP自动分类', operator: 'AI引擎', content: '自动分类：投诉-供水-特急，责任企业：宜昌市供水总公司，敏感标记：是', color: 'purple' },
      { time: '2026-05-28T08:40:00', action: '交办', operator: '管理员', content: '已自动生成交办单JB202605280001，推送至宜昌市供水总公司，要求24小时内办结', color: 'orange' },
      { time: '2026-05-28T09:00:00', action: '企业签收', operator: '市供水公司-王经理', content: '已签收交办单，立即安排抢修队伍赶赴现场', color: 'blue' },
      { time: '2026-05-28T09:30:00', action: '处理中', operator: '市供水公司-抢修队', content: '抢修人员已到达现场，正在排查漏水点并进行抢修作业', color: 'processing' },
    ]
  }
};

const ComplaintDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const data = complaintData[id || '1'] || complaintData['1'];

  const mapOption = {
    tooltip: { trigger: 'item' },
    grid: { left: 0, right: 0, top: 0, bottom: 0 },
    xAxis: { show: false, min: 111.2, max: 111.45 },
    yAxis: { show: false, min: 30.58, max: 30.78 },
    series: [{
      type: 'scatter', data: [[data.locationLng, data.locationLat]],
      symbolSize: 20, itemStyle: { color: '#ff4d4f', borderColor: '#fff', borderWidth: 2 },
      label: { show: true, position: 'top', formatter: '诉求位置', color: '#333' },
      emphasis: { scale: 1.5 }
    }]
  };

  const statusMap: Record<string, { color: string; text: string }> = {
    pending: { color: 'default', text: '待处理' }, processing: { color: 'processing', text: '处理中' },
    resolved: { color: 'success', text: '已办结' }, closed: { color: 'default', text: '已关闭' }
  };

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/complaints')}>返回列表</Button>
      </Space>
      <h2 style={{ marginBottom: 16 }}>诉求详情 - {data.complaintNo}</h2>

      <Row gutter={[16, 16]}>
        <Col span={16}>
          <Card title="基本信息">
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="诉求编号">{data.complaintNo}</Descriptions.Item>
              <Descriptions.Item label="状态"><Tag color={statusMap[data.status]?.color}>{statusMap[data.status]?.text}</Tag></Descriptions.Item>
              <Descriptions.Item label="标题" span={2}>{data.title}</Descriptions.Item>
              <Descriptions.Item label="业务类型"><Tag color={data.businessType === 'water' ? 'blue' : 'orange'}>{data.businessType === 'water' ? '供水' : '燃气'}</Tag></Descriptions.Item>
              <Descriptions.Item label="诉求类型"><Tag>{data.complaintType}</Tag></Descriptions.Item>
              <Descriptions.Item label="紧急程度"><Tag color="red">{data.urgencyLevel}</Tag></Descriptions.Item>
              <Descriptions.Item label="来源渠道">{data.source}</Descriptions.Item>
              <Descriptions.Item label="所属区域">{data.districtName}</Descriptions.Item>
              <Descriptions.Item label="责任企业">{data.companyName}</Descriptions.Item>
              <Descriptions.Item label="是否敏感">{data.isSensitive ? <Tag color="red">是</Tag> : <Tag>否</Tag>}</Descriptions.Item>
              <Descriptions.Item label="地理位置">{data.locationLng.toFixed(4)}, {data.locationLat.toFixed(4)}</Descriptions.Item>
              <Descriptions.Item label="诉求时间">{new Date(data.createdAt).toLocaleString('zh-CN')}</Descriptions.Item>
              <Descriptions.Item label="系统接收时间">{new Date(data.receivedAt).toLocaleString('zh-CN')}</Descriptions.Item>
              <Descriptions.Item label="诉求内容" span={2}>{data.content}</Descriptions.Item>
            </Descriptions>
          </Card>

          <Card title="处理记录" style={{ marginTop: 16 }}>
            <Timeline items={data.processes.map((p: any) => ({
              color: p.color, children: (
                <div>
                  <div style={{ fontWeight: 500 }}>{p.action} — {p.operator}</div>
                  <div style={{ color: '#999', fontSize: 12 }}>{new Date(p.time).toLocaleString('zh-CN')}</div>
                  <div>{p.content}</div>
                </div>
              )
            }))} />
          </Card>
        </Col>

        <Col span={8}>
          {data.dispatchInfo && (
            <Card title={<><SendOutlined /> 交办信息</>} style={{ marginBottom: 16 }}>
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="交办单号">{data.dispatchInfo.orderNo}</Descriptions.Item>
                <Descriptions.Item label="截止时间">{new Date(data.dispatchInfo.deadline).toLocaleString('zh-CN')}</Descriptions.Item>
                <Descriptions.Item label="交办状态"><Tag color="processing">处理中</Tag></Descriptions.Item>
              </Descriptions>
              <Divider />
              <Space>
                <Button type="primary" size="small" icon={<CheckCircleOutlined />}>标记办结</Button>
                <Button size="small">追加交办</Button>
              </Space>
            </Card>
          )}

          <Card title={<><EnvironmentOutlined /> GIS位置</>}>
            <ReactECharts option={mapOption} style={{ height: 250 }} />
            <div style={{ marginTop: 8, fontSize: 12, color: '#999' }}>
              经度: {data.locationLng.toFixed(4)} 纬度: {data.locationLat.toFixed(4)}
            </div>
          </Card>

          <Card title={<><ClockCircleOutlined /> 时效统计</>} style={{ marginTop: 16 }}>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="接收耗时">2分钟</Descriptions.Item>
              <Descriptions.Item label="交办耗时">8分钟</Descriptions.Item>
              <Descriptions.Item label="签收耗时">28分钟</Descriptions.Item>
              <Descriptions.Item label="已处理时长">1小时30分</Descriptions.Item>
              <Descriptions.Item label="剩余时限">22小时30分</Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default ComplaintDetail;
