import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, Button, Card, Col, Empty, Result, Row, Select, Skeleton, Space, Statistic, Table, Tag, Tooltip, Typography,
} from 'antd';
import {
  CheckCircleOutlined, ClockCircleOutlined, DatabaseOutlined, FileTextOutlined,
  ReloadOutlined, WarningOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import ReactECharts from 'echarts-for-react';
import { getDashboardOverview } from '../api/dashboard';
import type { ComplaintListItem, DashboardMetrics, DashboardOverview } from '../types/api';

/** 服务端返回 null 表示"该指标当前不可计算"，一律渲染成这个符号，绝不回落成 0 */
const NOT_AVAILABLE = '—';

/** 服务端未给出原因时的兜底提示（只影响提示文案，不影响数值展示） */
const REASON_FALLBACK = '该指标当前不可计算';

/**
 * 趋势窗口可选天数。**不写死 7 天**：历史数据回灌后"最近 7 天"可能整段为空，
 * 必须让使用者自己拉长窗口（服务端按 days 校验 1..365）。
 */
const TREND_RANGE_OPTIONS = [
  { value: 7, label: '近 7 天' },
  { value: 30, label: '近 30 天' },
  { value: 90, label: '近 90 天' },
  { value: 180, label: '近 180 天' },
];
const TREND_DEFAULT_DAYS = 7;

/** 标签配色只由前端决定；**中文名一律用服务端返回的 *Name 字段**，前端不自建翻译表 */
const URGENCY_COLOR: Record<string, string> = {
  normal: 'blue',
  urgent: 'orange',
  critical: 'red',
};

const SUPERVISION_COLOR: Record<string, string> = {
  none: 'default',
  pending_match: 'warning',
  pending: 'processing',
  pushed: 'processing',
  accepted: 'processing',
  processing: 'processing',
  returned: 'warning',
  completed: 'success',
  rejected: 'error',
  archived: 'default',
  cancelled: 'default',
};

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return NOT_AVAILABLE;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return NOT_AVAILABLE;
  return d.toLocaleString('zh-CN');
}

interface MetricCardProps {
  title: string;
  /** null 表示服务端明确表示不可计算 */
  value: number | null;
  icon?: React.ReactNode;
  valueStyle?: React.CSSProperties;
  onClick?: () => void;
  /** value 为 null 时的原因（取自 unavailable[]），用于 Tooltip */
  unavailableReason?: string;
}

/** 指标卡：null -> "—" + 原因提示；0 -> 真实的 0 */
const MetricCard: React.FC<MetricCardProps> = ({
  title, value, icon, valueStyle, onClick, unavailableReason,
}) => {
  const notAvailable = value === null || value === undefined;
  const card = (
    <Card hoverable={Boolean(onClick)} onClick={onClick}>
      <Statistic
        title={title}
        value={notAvailable ? NOT_AVAILABLE : value}
        prefix={icon}
        valueStyle={notAvailable ? { color: '#bfbfbf', ...valueStyle } : valueStyle}
      />
    </Card>
  );
  if (!notAvailable) return card;
  return <Tooltip title={unavailableReason || REASON_FALLBACK}>{card}</Tooltip>;
};

const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [trendDays, setTrendDays] = useState<number>(TREND_DEFAULT_DAYS);
  // 请求序号：丢弃过期响应，避免快速重试时旧结果覆盖新结果
  const requestSeq = useRef<number>(0);

  const load = useCallback(async () => {
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    setLoading(true);
    setError(null);
    try {
      const data = await getDashboardOverview(trendDays);
      if (seq !== requestSeq.current) return;
      setOverview(data);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [trendDays]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !overview) {
    return (
      <div>
        <Row gutter={[16, 16]}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Col span={4} key={i}>
              <Card>
                <Skeleton active title={false} paragraph={{ rows: 1 }} />
              </Card>
            </Col>
          ))}
        </Row>
        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col span={14}>
            <Card>
              <Skeleton active paragraph={{ rows: 6 }} />
            </Card>
          </Col>
          <Col span={10}>
            <Card>
              <Skeleton active paragraph={{ rows: 6 }} />
            </Card>
          </Col>
        </Row>
      </div>
    );
  }

  if (error && !overview) {
    return (
      <Result
        status="error"
        title="仪表盘数据加载失败"
        subTitle={error}
        extra={
          <Button type="primary" icon={<ReloadOutlined />} onClick={() => void load()}>
            重试
          </Button>
        }
      />
    );
  }

  if (!overview) return null;

  const metrics: DashboardMetrics = overview.metrics;
  const reasonOf = (key: keyof DashboardMetrics): string => {
    const hit = overview.unavailable.find((u) => u.key === key);
    return hit ? hit.reason : REASON_FALLBACK;
  };

  const trendOption = {
    tooltip: { trigger: 'axis' },
    legend: { data: ['供水诉求', '燃气诉求'] },
    grid: { left: 50, right: 20, top: 40, bottom: 30 },
    xAxis: { type: 'category', data: overview.trend.dates },
    yAxis: { type: 'value' },
    series: [
      { name: '供水诉求', type: 'line', smooth: true, data: overview.trend.water, itemStyle: { color: '#1677ff' } },
      { name: '燃气诉求', type: 'line', smooth: true, data: overview.trend.gas, itemStyle: { color: '#fa8c16' } },
    ],
  };

  const distribution = overview.complaintTypeDistribution;
  const pieOption = {
    tooltip: { trigger: 'item' },
    legend: { orient: 'vertical', right: 10, top: 'center' },
    series: [{
      type: 'pie',
      radius: ['40%', '65%'],
      center: ['40%', '50%'],
      data: distribution.map((item) => ({ value: item.value, name: item.name })),
    }],
  };

  // ECharts 的类目轴自下而上，反转后最大值排在最上面
  const regionRank = overview.regionRank.slice().reverse();
  const regionOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 90, right: 40, top: 10, bottom: 20 },
    xAxis: { type: 'value' },
    yAxis: { type: 'category', data: regionRank.map((r) => r.districtName || '未知区域') },
    series: [{
      type: 'bar',
      data: regionRank.map((r) => r.value),
      itemStyle: { color: '#1677ff' },
      label: { show: true, position: 'right', color: '#666' },
    }],
  };

  const columns = [
    {
      title: '诉求编号',
      dataIndex: 'complaintNo',
      key: 'complaintNo',
      width: 150,
      render: (v: string, r: ComplaintListItem) => (
        <a onClick={() => navigate('/complaints/' + r.id)}>{v}</a>
      ),
    },
    { title: '标题', dataIndex: 'title', key: 'title', ellipsis: true },
    {
      title: '来源系统',
      dataIndex: 'sourceSystem',
      key: 'sourceSystem',
      width: 110,
      render: (v: string | null) => v || NOT_AVAILABLE,
    },
    {
      title: '诉求类型',
      dataIndex: 'complaintTypeName',
      key: 'complaintTypeName',
      width: 90,
      render: (v: string) => <Tag>{v}</Tag>,
    },
    {
      title: '紧急程度',
      dataIndex: 'urgencyLevelName',
      key: 'urgencyLevelName',
      width: 95,
      render: (v: string, r: ComplaintListItem) => <Tag color={URGENCY_COLOR[r.urgencyLevelCode]}>{v}</Tag>,
    },
    {
      title: '督办状态',
      dataIndex: 'supervisionStatusName',
      key: 'supervisionStatusName',
      width: 110,
      render: (v: string, r: ComplaintListItem) => (
        <Tag color={SUPERVISION_COLOR[r.supervisionStatusCode]}>{v}</Tag>
      ),
    },
    {
      title: '来源状态',
      dataIndex: 'sourceEventStatusName',
      key: 'sourceEventStatusName',
      width: 100,
      // 宜接就办接口尚未对接（批次 G6），服务端返回「未接入」，必须原样展示
      render: (v: string, r: ComplaintListItem) => (
        r.sourceEventStatusCode === 'unknown'
          ? <Tooltip title="宜接就办接口尚未对接（批次 G6），此处不代表任何处置进度"><Tag>{v}</Tag></Tooltip>
          : <Tag color="geekblue">{v}</Tag>
      ),
    },
    {
      title: '接收时间',
      dataIndex: 'receivedAt',
      key: 'receivedAt',
      width: 170,
      render: (v: string | null) => formatDateTime(v),
    },
  ];

  return (
    <div>
      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="刷新失败，以下为上一次成功加载的数据"
          description={error}
          action={<Button size="small" onClick={() => void load()}>重试</Button>}
        />
      ) : null}

      <Row justify="space-between" align="middle" style={{ marginBottom: 12 }}>
        <Col>
          <Space size={16}>
            <Typography.Text type="secondary">
              <DatabaseOutlined /> 数据来源：{overview.source === 'database' ? '数据库' : overview.source}
            </Typography.Text>
            <Typography.Text type="secondary">生成时间：{formatDateTime(overview.generatedAt)}</Typography.Text>
            <Typography.Text type="secondary">
              统计口径：{overview.period.today}（{overview.period.timezone}）
            </Typography.Text>
          </Space>
        </Col>
        <Col>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col span={4}>
          <MetricCard title="今日受理" value={metrics.todayReceived} icon={<FileTextOutlined />} onClick={() => navigate('/complaints')} />
        </Col>
        <Col span={4}>
          <MetricCard title="供水诉求" value={metrics.waterReceived} valueStyle={{ color: '#1677ff' }} onClick={() => navigate('/complaints')} />
        </Col>
        <Col span={4}>
          <MetricCard title="燃气诉求" value={metrics.gasReceived} valueStyle={{ color: '#fa8c16' }} onClick={() => navigate('/complaints')} />
        </Col>
        <Col span={4}>
          <MetricCard title="敏感诉求" value={metrics.sensitiveTotal} icon={<WarningOutlined />} valueStyle={{ color: '#ff4d4f' }} onClick={() => navigate('/dispatch')} />
        </Col>
        <Col span={4}>
          <MetricCard
            title="超时未办结"
            value={metrics.overtimeActive}
            icon={<ClockCircleOutlined />}
            valueStyle={{ color: '#faad14' }}
            onClick={() => navigate('/dispatch')}
            unavailableReason={reasonOf('overtimeActive')}
          />
        </Col>
        <Col span={4}>
          <MetricCard
            title="本系统办结"
            value={metrics.closedInSystem}
            icon={<CheckCircleOutlined />}
            valueStyle={{ color: '#52c41a' }}
          />
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={14}>
          <Card
            title={'诉求趋势（' + overview.trend.from + ' ~ ' + overview.trend.to + '）'}
            extra={
              <Select
                size="small"
                style={{ width: 120 }}
                value={trendDays}
                options={TREND_RANGE_OPTIONS}
                onChange={(v: number) => setTrendDays(v)}
              />
            }
          >
            {overview.trend.dates.length === 0
              ? <Empty description="暂无趋势数据" />
              : <ReactECharts option={trendOption} style={{ height: 280 }} />}
            <div style={{ marginTop: 8, fontSize: 12, color: '#999' }}>
              口径：{overview.period.timeBasisLabel}；区间 {overview.trend.from} ~ {overview.trend.to}（{overview.trend.days} 天）
            </div>
          </Card>
        </Col>
        <Col span={10}>
          <Card title="诉求类型分布">
            {distribution.length === 0
              ? <Empty description="暂无分类数据" />
              : <ReactECharts option={pieOption} style={{ height: 280 }} />}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={24}>
          <Card title="区域诉求排名">
            {regionRank.length === 0
              ? <Empty description="暂无区域数据" />
              : <ReactECharts option={regionOption} style={{ height: 260 }} />}
          </Card>
        </Col>
      </Row>

      <Card
        title="最新诉求"
        style={{ marginTop: 16 }}
        extra={<Button type="link" onClick={() => navigate('/complaints')}>查看全部诉求 →</Button>}
      >
        <Table<ComplaintListItem>
          columns={columns}
          dataSource={overview.latestComplaints}
          rowKey="id"
          pagination={false}
          size="small"
          locale={{ emptyText: <Empty description="暂无诉求数据" /> }}
        />
      </Card>
    </div>
  );
};

export default Dashboard;
