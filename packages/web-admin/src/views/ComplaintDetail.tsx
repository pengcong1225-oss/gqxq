import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Empty,
  Result,
  Row,
  Skeleton,
  Space,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from 'antd';
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  EnvironmentOutlined,
  SendOutlined,
} from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { getComplaint, getComplaintTimeline } from '../api/complaints';
import type {
  ApiError,
  ComplaintDetail as ComplaintDetailModel,
  TimelineCategory,
  TimelineItem,
} from '../types/api';

/**
 * 诉求详情（真实接口驱动）。
 *
 * 设计纪律：
 *  - 删除本地示例与「id 不是 1 就回退示例」的逻辑；404 就是「诉求不存在」，绝不回落示例。
 *  - 无坐标时不渲染图表（此前 data.locationLng.toFixed 在无坐标时会崩）。
 *  - 时效统计只显示可算项，算不出的显示 —，不硬编码任何无来源的耗时数字。
 *  - 未实现的按钮 disabled + Tooltip 说明批次，不弹假成功。
 */

/* ---------- 仅用于配色与类别中文名（接口值本身是服务端返回的中文） ---------- */
const CATEGORY_META: Record<TimelineCategory, { color: string; text: string }> = {
  intake: { color: 'blue', text: '接收' },
  field_change: { color: 'purple', text: '字段变更' },
  operation: { color: 'green', text: '人工操作' },
  approval: { color: 'orange', text: '审批' },
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

const CORRECTION_COLOR: Record<string, string> = {
  none: 'default',
  pending: 'warning',
  corrected: 'success',
  failed: 'error',
};

function fmtDateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString('zh-CN') : '—';
}

function fmtDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 1) return '不足1分钟';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? hours + '小时' + minutes + '分' : minutes + '分钟';
}

function isNotFound(err: ApiError): boolean {
  return err?.code === 404 || err?.code === 'NOT_FOUND' || err?.status === 404;
}

const ComplaintDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [detail, setDetail] = useState<ComplaintDetailModel | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) {
      setNotFound(true);
      return;
    }
    setLoading(true);
    setError(null);
    setNotFound(false);
    setTimelineError(null);
    setTimeline([]);
    setDetail(null);

    try {
      const d = await getComplaint(id);
      setDetail(d);
    } catch (err) {
      const e = err as ApiError;
      if (isNotFound(e)) setNotFound(true);
      else setError(e);
      setLoading(false);
      return;
    }

    // 时间线与详情分开：时间线失败不应把整页打成错误态，但必须显式告知
    try {
      const t = await getComplaintTimeline(id);
      setTimeline(t.content);
    } catch (err) {
      setTimelineError((err as ApiError)?.message ?? '处理记录加载失败');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ---------- 时效统计：只算有真实数据支撑的项 ---------- */
  const timing = useMemo(() => {
    const receivedMs = detail?.receivedAt ? new Date(detail.receivedAt).getTime() : null;
    const reportedMs = detail?.sourceReportedAt ? new Date(detail.sourceReportedAt).getTime() : null;
    const receiveDuration =
      receivedMs !== null && reportedMs !== null ? receivedMs - reportedMs : null;
    const elapsed = receivedMs !== null ? Date.now() - receivedMs : null;
    return { receiveDuration, elapsed };
  }, [detail]);

  /* ---------- 坐标 ---------- */
  const hasCoords = detail?.locationLng != null && detail?.locationLat != null;
  const mapOption = useMemo(() => {
    if (!hasCoords || !detail) return null;
    return {
      tooltip: { trigger: 'item' },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      xAxis: { show: false, min: detail.locationLng! - 0.1, max: detail.locationLng! + 0.1 },
      yAxis: { show: false, min: detail.locationLat! - 0.1, max: detail.locationLat! + 0.1 },
      series: [
        {
          type: 'scatter',
          data: [[detail.locationLng, detail.locationLat]],
          symbolSize: 20,
          itemStyle: { color: '#ff4d4f', borderColor: '#fff', borderWidth: 2 },
          label: { show: true, position: 'top', formatter: '诉求位置', color: '#333' },
          emphasis: { scale: 1.5 },
        },
      ],
    };
  }, [detail, hasCoords]);

  const backButton = (
    <Space style={{ marginBottom: 16 }}>
      <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/complaints')}>
        返回列表
      </Button>
    </Space>
  );

  if (notFound) {
    return (
      <div>
        {backButton}
        <Result
          status="404"
          title="诉求不存在"
          subTitle={'未找到 id 为 ' + (id ?? '') + ' 的诉求记录。'}
          extra={
            <Button type="primary" onClick={() => navigate('/complaints')}>
              返回诉求总账
            </Button>
          }
        />
      </div>
    );
  }

  if (error) {
    return (
      <div>
        {backButton}
        <Result
          status="error"
          title="诉求详情加载失败"
          subTitle={error.message}
          extra={
            <Button type="primary" onClick={() => void load()}>
              重试
            </Button>
          }
        />
      </div>
    );
  }

  if (loading && !detail) {
    return (
      <div>
        {backButton}
        <Card>
          <Skeleton active paragraph={{ rows: 8 }} />
        </Card>
      </div>
    );
  }

  if (!detail) {
    return (
      <div>
        {backButton}
        <Card>
          <Empty description="暂无诉求数据" />
        </Card>
      </div>
    );
  }

  return (
    <div>
      {backButton}
      <h2 style={{ marginBottom: 16 }}>诉求详情 - {detail.complaintNo}</h2>

      <Row gutter={[16, 16]}>
        <Col span={16}>
          <Card title="基本信息">
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="诉求编号">{detail.complaintNo}</Descriptions.Item>
              <Descriptions.Item label="督办状态">
                <Tag color={SUPERVISION_COLOR[detail.supervisionStatusCode] ?? 'default'}>
                  {detail.supervisionStatusName}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="标题" span={2}>
                {detail.title}
              </Descriptions.Item>
              <Descriptions.Item label="业务类型">
                <Tag color={detail.businessTypeCode === 'water' ? 'blue' : 'orange'}>
                  {detail.businessTypeName}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="诉求类型">
                <Tag>{detail.complaintTypeName}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="紧急程度">
                <Tag color={detail.urgencyLevelCode === 'critical' ? 'red' : detail.urgencyLevelCode === 'urgent' ? 'orange' : 'blue'}>
                  {detail.urgencyLevelName}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="来源系统">{detail.sourceSystem ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="来源渠道">{detail.sourceChannel ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="来源ID">{detail.sourceId ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="所属区域">{detail.districtName ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="责任企业">
                {detail.enterpriseName ? (
                  detail.enterpriseName
                ) : (
                  <span style={{ color: '#faad14' }}>未匹配</span>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="是否敏感">
                {detail.isSensitive ? (
                  <>
                    <Tag color="red">是</Tag>
                    {detail.sensitiveKeywords.length > 0 && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {detail.sensitiveKeywords.join('、')}
                      </Typography.Text>
                    )}
                  </>
                ) : (
                  <Tag>否</Tag>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="地理位置">
                {hasCoords
                  ? Number(detail.locationLng).toFixed(4) + ', ' + Number(detail.locationLat).toFixed(4)
                  : '无定位信息'}
              </Descriptions.Item>
              <Descriptions.Item label="纠偏状态">
                <Tag color={CORRECTION_COLOR[detail.correctionStatusCode] ?? 'default'}>
                  {detail.correctionStatusName}
                </Tag>
                {detail.correctionConfidence != null && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    置信度 {Math.round(detail.correctionConfidence * 100)}%
                  </Typography.Text>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="来源状态">
                {detail.sourceEventStatusCode === 'unknown' ? (
                  <Tooltip title="宜接就办接口尚未对接（批次 G6），来源处置状态暂不可知">
                    <Tag color="default">{detail.sourceEventStatusName}</Tag>
                  </Tooltip>
                ) : (
                  <Tag color="cyan">{detail.sourceEventStatusName}</Tag>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="填报状态">
                <Tag>{detail.reportingStatusName}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="规则预处理">
                {detail.ruleConfidence != null
                  ? '置信度 ' + Math.round(detail.ruleConfidence * 100) + '%'
                  : '—'}
                {detail.ruleVersion ? '（规则 ' + detail.ruleVersion + '）' : ''}
              </Descriptions.Item>
              <Descriptions.Item label="原始地址">{detail.address ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="纠偏后地址">{detail.correctedAddress ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="诉求时间">{fmtDateTime(detail.createdAt)}</Descriptions.Item>
              <Descriptions.Item label="系统接收时间">{fmtDateTime(detail.receivedAt)}</Descriptions.Item>
              <Descriptions.Item label="来源上报时间">{fmtDateTime(detail.sourceReportedAt)}</Descriptions.Item>
              <Descriptions.Item label="最后更新">{fmtDateTime(detail.updatedAt)}</Descriptions.Item>
              <Descriptions.Item label="诉求内容" span={2}>
                {detail.content ?? '—'}
              </Descriptions.Item>
            </Descriptions>
          </Card>

          <Card title="处理记录" style={{ marginTop: 16 }}>
            {timelineError && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message={'处理记录加载失败：' + timelineError}
              />
            )}
            {timeline.length === 0 ? (
              <Empty description="暂无处理记录" />
            ) : (
              <Timeline
                items={timeline.map((t, idx) => {
                  const meta = CATEGORY_META[t.category];
                  return {
                    color: meta?.color ?? 'gray',
                    key: idx,
                    children: (
                      <div>
                        <Space size={6} wrap>
                          <Tag color={meta?.color ?? 'default'}>{meta?.text ?? t.category}</Tag>
                          <span style={{ fontWeight: 500 }}>{t.action}</span>
                        </Space>
                        <div style={{ color: '#999', fontSize: 12 }}>
                          {fmtDateTime(t.at)} · {t.operatorName ?? '系统'}
                        </div>
                        <div>{t.summary}</div>
                      </div>
                    ),
                  };
                })}
              />
            )}
          </Card>
        </Col>

        <Col span={8}>
          <Card
            title={
              <>
                <SendOutlined /> 交办与办结
              </>
            }
            style={{ marginBottom: 16 }}
          >
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="督办状态">
                <Tag color={SUPERVISION_COLOR[detail.supervisionStatusCode] ?? 'default'}>
                  {detail.supervisionStatusName}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="填报状态">{detail.reportingStatusName}</Descriptions.Item>
              <Descriptions.Item label="责任企业">
                {detail.enterpriseName ?? '未匹配'}
              </Descriptions.Item>
              <Descriptions.Item label="本系统办结">
                {detail.closedInSystem ? (
                  <Tag color="success">已办结</Tag>
                ) : (
                  <Tag>未办结</Tag>
                )}
              </Descriptions.Item>
              {detail.closedInSystem && (
                <>
                  <Descriptions.Item label="办结时间">{fmtDateTime(detail.closedAt)}</Descriptions.Item>
                  <Descriptions.Item label="确认人">{detail.closedByName ?? '—'}</Descriptions.Item>
                  <Descriptions.Item label="办结依据">{detail.closedBasis ?? '—'}</Descriptions.Item>
                </>
              )}
              <Descriptions.Item label="分析入库">
                {detail.analysisIncluded ? '已入库' : '未入库'}
              </Descriptions.Item>
            </Descriptions>
            <Divider />
            <Space>
              <Tooltip title="本系统办结属批次 G5，未实现">
                <span>
                  <Button type="primary" size="small" icon={<CheckCircleOutlined />} disabled>
                    标记办结
                  </Button>
                </span>
              </Tooltip>
              <Tooltip title="请在诉求总账创建交办（批次 G2）">
                <span>
                  <Button size="small" disabled>
                    追加交办
                  </Button>
                </span>
              </Tooltip>
            </Space>
          </Card>

          <Card
            title={
              <>
                <EnvironmentOutlined /> GIS位置
              </>
            }
          >
            {hasCoords && mapOption ? (
              <>
                <ReactECharts option={mapOption} style={{ height: 250 }} />
                <div style={{ marginTop: 8, fontSize: 12, color: '#999' }}>
                  经度: {Number(detail.locationLng).toFixed(4)} 纬度:{' '}
                  {Number(detail.locationLat).toFixed(4)}
                </div>
              </>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="无定位信息（该诉求未提供坐标，可在地址纠偏中补全）"
              />
            )}
          </Card>

          <Card
            title={
              <>
                <ClockCircleOutlined /> 时效统计
              </>
            }
            style={{ marginTop: 16 }}
          >
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="接收耗时">
                {fmtDuration(timing.receiveDuration)}
              </Descriptions.Item>
              <Descriptions.Item label="已处理时长">{fmtDuration(timing.elapsed)}</Descriptions.Item>
              <Descriptions.Item label="交办耗时">
                <Tooltip title="依赖交办记录，批次 G2">
                  <span>—</span>
                </Tooltip>
              </Descriptions.Item>
              <Descriptions.Item label="签收耗时">
                <Tooltip title="依赖填报系统签收回执，批次 G4">
                  <span>—</span>
                </Tooltip>
              </Descriptions.Item>
              <Descriptions.Item label="剩余时限">
                <Tooltip title="依赖交办截止时间，批次 G2">
                  <span>—</span>
                </Tooltip>
              </Descriptions.Item>
            </Descriptions>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              「—」表示所需数据尚未接入：接收耗时 = 系统接收时间 − 来源上报时间。
            </Typography.Text>
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default ComplaintDetail;
