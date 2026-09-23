import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Divider,
  Empty,
  Form,
  Input,
  Modal,
  Result,
  Row,
  Select,
  Skeleton,
  Space,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  EnvironmentOutlined,
  SendOutlined,
} from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import type { Dayjs } from 'dayjs';
import { getComplaint, getComplaintTimeline } from '../api/complaints';
import { createDispatch, getDispatchOrder } from '../api/dispatch';
import { listEnterprises } from '../api/enterprises';
import { getSourceAdapterState, syncSource } from '../api/source';
import type {
  ApiError,
  ComplaintDetail as ComplaintDetailModel,
  DispatchOrderDetail,
  EnterpriseListItem,
  SourceAdapterState,
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

  /* ---------- G2：该诉求的真实交办（进行中的那条） ---------- */
  const [dispatch, setDispatch] = useState<DispatchOrderDetail | null>(null);
  const [dispatchLoading, setDispatchLoading] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [dispatchForm] = Form.useForm<{
    targetEnterpriseCode: string;
    targetEnterpriseName: string;
    deadline?: Dayjs;
    requirement?: string;
    reason?: string;
  }>();

  /* ---------- 企业主数据：追加交办时的企业选择 ---------- */
  // 清单来自服务端 GET /enterprises，不做本地兜底：手抄编码与登记值不一致会导致交办匹配不到同一主体。
  const [enterpriseOptions, setEnterpriseOptions] = useState<EnterpriseListItem[]>([]);
  const [enterpriseLoading, setEnterpriseLoading] = useState(false);
  const [enterpriseError, setEnterpriseError] = useState<string | null>(null);
  const enterpriseSearchTimer = useRef<number | null>(null);
  const enterpriseFetchSeq = useRef(0);

  const fetchEnterprises = useCallback(async (keyword?: string) => {
    const seq = ++enterpriseFetchSeq.current;
    setEnterpriseLoading(true);
    try {
      const res = await listEnterprises({
        keyword: keyword && keyword.trim() !== '' ? keyword.trim() : undefined,
        size: 50,
      });
      if (seq !== enterpriseFetchSeq.current) return; // 丢弃过期响应
      setEnterpriseOptions(res.content);
      setEnterpriseError(null);
    } catch (err) {
      if (seq !== enterpriseFetchSeq.current) return;
      setEnterpriseOptions([]); // 失败就是空，绝不回落到本地硬编码企业清单
      setEnterpriseError((err as ApiError)?.message ?? '企业列表加载失败');
    } finally {
      if (seq === enterpriseFetchSeq.current) setEnterpriseLoading(false);
    }
  }, []);

  /** 输入即远程搜索，300ms 防抖 */
  const handleEnterpriseSearch = useCallback(
    (keyword: string) => {
      if (enterpriseSearchTimer.current !== null) window.clearTimeout(enterpriseSearchTimer.current);
      enterpriseSearchTimer.current = window.setTimeout(() => {
        void fetchEnterprises(keyword);
      }, 300);
    },
    [fetchEnterprises]
  );

  useEffect(
    () => () => {
      if (enterpriseSearchTimer.current !== null) window.clearTimeout(enterpriseSearchTimer.current);
    },
    []
  );

  const clearEnterpriseError = useCallback(() => setEnterpriseError(null), []);

  const toEnterpriseOptions = useCallback(
    (list: EnterpriseListItem[]) =>
      list.map((e) => ({
        value: e.enterpriseCode,
        label:
          e.enterpriseName +
          '（' + e.enterpriseCode + '）' +
          (e.businessTypeName ? ' · ' + e.businessTypeName : ''),
      })),
    []
  );

  /** 服务端结果里若没有该诉求已登记的企业，补在首位以便回显（值来自该诉求自身，不是前端常量） */
  const withCurrentEnterprise = useCallback(
    (list: EnterpriseListItem[], code?: string | null, name?: string | null): EnterpriseListItem[] => {
      if (!code || list.some((e) => e.enterpriseCode === code)) return list;
      const current: EnterpriseListItem = {
        id: -1,
        enterpriseCode: code,
        enterpriseName: name ?? code,
        businessType: '',
        businessTypeName: '',
        uscc: null,
        contactPerson: null,
        contactPhone: null,
        serviceArea: null,
        status: 'enabled',
      };
      return [current, ...list];
    },
    []
  );

  const loadDispatch = useCallback(async (assignmentId: string) => {
    setDispatchLoading(true);
    setDispatchError(null);
    try {
      const d = await getDispatchOrder(assignmentId);
      setDispatch(d);
    } catch (err) {
      setDispatchError((err as ApiError)?.message ?? '交办信息加载失败');
    } finally {
      setDispatchLoading(false);
    }
  }, []);

  /**
   * 交办信息单独取、单独失败：交办接口不可用不应把整页打成错误态，
   * 但必须在该卡片内显式告知并给重试，绝不编造交办单号或截止时间。
   */
  useEffect(() => {
    const id = detail?.activeDispatchId;
    if (id) {
      void loadDispatch(id);
    } else {
      setDispatch(null);
      setDispatchError(null);
    }
  }, [detail?.activeDispatchId, loadDispatch]);

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

  /* ---------- G6：来源对接状态与手动同步 ----------
   * 适配器默认关闭，来源状态因此一律是「未接入」——那是**真实状态**。
   * 这里只如实呈现服务端返回的状态，绝不用本地常量假装适配器已接入或未接入。 */
  const [sourceState, setSourceState] = useState<SourceAdapterState | null>(null);
  const [sourceStateError, setSourceStateError] = useState<string | null>(null);
  const [sourceSyncing, setSourceSyncing] = useState(false);
  const [sourceSyncNotice, setSourceSyncNotice] = useState<{
    type: 'success' | 'info' | 'warning' | 'error';
    text: string;
  } | null>(null);

  const loadSourceState = useCallback(async () => {
    setSourceStateError(null);
    try {
      setSourceState(await getSourceAdapterState());
    } catch (err) {
      // 获取失败不能当成「未接入」：那是编造适配器状态，与编造来源进度同样不可接受。
      setSourceState(null);
      setSourceStateError((err as ApiError)?.message ?? '来源对接状态获取失败');
    }
  }, []);

  useEffect(() => {
    void loadSourceState();
  }, [loadSourceState]);

  /**
   * 手动同步来源状态。
   * 适配器未启用时服务端返回 **501 NOT_IMPLEMENTED** —— 那是设计如此，不是故障：
   * 必须单独识别并如实说明，既不显示成泛化错误，更不能假装成功。
   */
  const handleSyncSource = useCallback(async () => {
    if (!id) return;
    setSourceSyncing(true);
    setSourceSyncNotice(null);
    try {
      const res = await syncSource(id);
      if (res.updated) {
        setSourceSyncNotice({
          type: 'success',
          text:
            '来源状态已更新为「' + (res.sourceEventStatusName ?? '未知') + '」' +
            (res.overtimeFlagName ? '；超期时效：「' + res.overtimeFlagName + '」' : '') +
            (res.rawStatus ? '（来源原值：' + res.rawStatus + '）' : ''),
        });
        await load();
      } else {
        setSourceSyncNotice({ type: 'info', text: res.message ?? '来源状态未发生变化' });
      }
    } catch (err) {
      const e = err as ApiError;
      const code = e?.code;
      if (code === 501 || code === 'NOT_IMPLEMENTED') {
        setSourceSyncNotice({
          type: 'info',
          text: '来源适配器未启用（批次 G6），真实接口待对接：' + (e?.message ?? ''),
        });
      } else {
        setSourceSyncNotice({
          type: 'error',
          text: '同步来源状态失败：' + (e?.message ?? '未知错误'),
        });
      }
    } finally {
      setSourceSyncing(false);
    }
  }, [id, load]);

  const handleCreateDispatch = useCallback(async () => {
    if (!detail) return;
    let values: {
      targetEnterpriseCode: string;
      targetEnterpriseName: string;
      deadline?: Dayjs;
      requirement?: string;
      reason?: string;
    };
    try {
      values = await dispatchForm.validateFields();
    } catch {
      return;
    }
    setSubmitting(true);
    try {
      const res = await createDispatch({
        complaintId: detail.complaintId,
        targetEnterpriseCode: values.targetEnterpriseCode.trim(),
        targetEnterpriseName: values.targetEnterpriseName.trim(),
        requirement: values.requirement?.trim() || undefined,
        reason: values.reason?.trim() || undefined,
        // 契约要求带时区偏移的 ISO-8601，例如 2026-09-20T18:00:00+08:00
        deadline: values.deadline ? values.deadline.format('YYYY-MM-DDTHH:mm:ssZ') : undefined,
        dispatchType: 'manual',
        triggerType: 'manual_flag',
      });
      if (!res.created) {
        // 并发下已有交办：后端返回既有记录，不再建第二条
        message.warning('该诉求已有交办（' + res.order.orderNo + '），未创建新交办');
      } else {
        message.success('已创建交办 ' + res.order.orderNo);
      }
      setDispatchOpen(false);
      dispatchForm.resetFields();
      void load();
    } catch (err) {
      message.error('创建交办失败：' + ((err as ApiError)?.message ?? '未知错误'));
    } finally {
      setSubmitting(false);
    }
  }, [detail, dispatchForm, load]);

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
      <Tooltip title="从宜接就办同步该诉求的来源处置状态（只读）。适配器未启用时会如实返回未实现，不会展示模拟进度。">
        <Button loading={sourceSyncing} onClick={() => void handleSyncSource()}>
          同步来源状态
        </Button>
      </Tooltip>
    </Space>
  );

  /**
   * G6 来源对接面板。三态必须分清：
   *   状态获取失败 -> 不能假装未接入，给可重试提示；
   *   配置无效     -> 警告级，原样展示服务端 message；
   *   适配器关闭   -> **信息级**（真实状态，不是错误）；
   *   已接入       -> 不显示。
   * 另附手动同步的结果提示（501 单独识别为「未启用」）。
   */
  const sourceStatusPanel = (
    <>
      {sourceStateError !== null && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="来源对接状态获取失败"
          description={
            '无法确认宜接就办来源适配器当前是否已接入：' + sourceStateError + '。（不会用默认值假装未接入）'
          }
          action={
            <Button size="small" onClick={() => void loadSourceState()}>
              重试
            </Button>
          }
        />
      )}

      {sourceState !== null && !sourceState.enabled && (
        <Alert
          type={sourceState.misconfigured ? 'warning' : 'info'}
          showIcon
          style={{ marginBottom: 12 }}
          message={
            sourceState.misconfigured
              ? '来源对接：适配器配置无效（批次 ' + (sourceState.batch ?? 'G6') + '）'
              : '来源对接：未接入（批次 ' + (sourceState.batch ?? 'G6') + '）'
          }
          description={
            <>
              {sourceState.message}
              <br />
              本页的来源状态显示「未接入」，这是真实状态，不代表异常；本平台不展示任何模拟的来源进度。
            </>
          }
        />
      )}

      {sourceSyncNotice !== null && (
        <Alert
          type={sourceSyncNotice.type}
          showIcon
          closable
          style={{ marginBottom: 12 }}
          message={sourceSyncNotice.text}
          onClose={() => setSourceSyncNotice(null)}
        />
      )}
    </>
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

  // 进行中的交办（唯一；为 null 表示尚无交办，可发起）
  const activeDispatchId = detail.activeDispatchId;

  return (
    <div>
      {backButton}
      <h2 style={{ marginBottom: 16 }}>诉求详情 - {detail.complaintNo}</h2>

      {sourceStatusPanel}

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
              <Descriptions.Item label="超期时效">
                {detail.overtimeFlag === 1 ? (
                  <Tag color="red">{detail.overtimeFlagName}</Tag>
                ) : detail.overtimeFlag === 0 ? (
                  <Tag color="green">{detail.overtimeFlagName}</Tag>
                ) : (
                  <Tooltip title="来源未给出时效信息（未同步 / 正常在办 / 状态认不出 / 历史未回填），不等于「未超期」">
                    <Tag color="default">{detail.overtimeFlagName}</Tag>
                  </Tooltip>
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

            <Divider orientation="left" plain>
              交办信息
            </Divider>

            {activeDispatchId === null ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该诉求尚无交办记录" />
            ) : dispatchLoading ? (
              <Typography.Text type="secondary">交办信息加载中…</Typography.Text>
            ) : dispatchError ? (
              <Alert
                type="error"
                showIcon
                message="交办信息加载失败"
                description={dispatchError}
                action={
                  <Button size="small" onClick={() => void loadDispatch(activeDispatchId)}>
                    重试
                  </Button>
                }
              />
            ) : dispatch ? (
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="交办单号">{dispatch.orderNo}</Descriptions.Item>
                <Descriptions.Item label="交办状态">
                  <Tag color={SUPERVISION_COLOR[dispatch.status] ?? 'default'}>
                    {dispatch.statusName}
                  </Tag>
                </Descriptions.Item>
                <Descriptions.Item label="目标企业">
                  {dispatch.targetEnterpriseName ?? '—'}
                </Descriptions.Item>
                <Descriptions.Item label="截止时间">{fmtDateTime(dispatch.deadline)}</Descriptions.Item>
                <Descriptions.Item label="交办要求">{dispatch.requirement ?? '—'}</Descriptions.Item>
                <Descriptions.Item label="请求号">{dispatch.requestId ?? '—'}</Descriptions.Item>
                <Descriptions.Item label="填报任务号">
                  {dispatch.reportingTaskId ?? (
                    <Tooltip title="填报任务号由批次 G3 推送成功后回填">
                      <span>—</span>
                    </Tooltip>
                  )}
                </Descriptions.Item>
              </Descriptions>
            ) : null}

            <Divider />
            <Space wrap>
              <Tooltip title="本系统办结属批次 G5，未实现">
                <span>
                  <Button type="primary" size="small" icon={<CheckCircleOutlined />} disabled>
                    标记办结
                  </Button>
                </span>
              </Tooltip>
              {activeDispatchId !== null ? (
                <Tooltip title="已有进行中交办；同一诉求同一轮只能有一条有效交办">
                  <span>
                    <Button size="small" disabled>
                      追加交办
                    </Button>
                  </span>
                </Tooltip>
              ) : (
                <Button
                  size="small"
                  onClick={() => {
                    dispatchForm.resetFields();
                    dispatchForm.setFieldsValue({
                      targetEnterpriseCode: detail.enterpriseCode ?? '',
                      targetEnterpriseName: detail.enterpriseName ?? '',
                    });
                    clearEnterpriseError();
                    void fetchEnterprises();
                    setDispatchOpen(true);
                  }}
                >
                  追加交办
                </Button>
              )}
              {activeDispatchId !== null && (
                <Button
                  size="small"
                  type="link"
                  onClick={() =>
                    navigate('/dispatch?assignmentId=' + encodeURIComponent(activeDispatchId))
                  }
                >
                  在敏感交办中查看
                </Button>
              )}
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
                description="无定位信息（该诉求未提供坐标，可在整体纠偏中补全）"
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

      {/* ---------- G2：追加交办（该诉求尚无进行中交办时才可发起） ---------- */}
      <Modal
        title={'追加交办 - ' + detail.complaintNo}
        open={dispatchOpen}
        onCancel={() => {
          setDispatchOpen(false);
          dispatchForm.resetFields();
        }}
        onOk={() => void handleCreateDispatch()}
        confirmLoading={submitting}
        okText="创建交办"
        width={560}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="同一诉求同一轮只能有一条有效交办"
          description="该约束由数据库唯一键保证，不依赖前端判断。若并发下已存在交办，后端返回 created=false，此处会提示「该诉求已有交办」并刷新，不会产生第二条。"
        />
        {enterpriseError && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={'企业列表加载失败：' + enterpriseError}
            description="下拉将为空，不会被本地示例企业替代。"
            action={
              <Button size="small" onClick={() => void fetchEnterprises()}>
                重试
              </Button>
            }
          />
        )}
        <Form form={dispatchForm} layout="vertical">
          <Form.Item
            name="targetEnterpriseCode"
            label="交办企业"
            rules={[{ required: true, message: '请选择交办企业' }]}
          >
            <Select
              showSearch
              allowClear
              filterOption={false}
              loading={enterpriseLoading}
              placeholder="输入企业名称或编码搜索"
              onSearch={handleEnterpriseSearch}
              options={toEnterpriseOptions(
                withCurrentEnterprise(
                  enterpriseOptions,
                  detail.enterpriseCode,
                  detail.enterpriseName
                )
              )}
              onChange={(code: string | undefined) => {
                const list = withCurrentEnterprise(
                  enterpriseOptions,
                  detail.enterpriseCode,
                  detail.enterpriseName
                );
                const hit = list.find((e) => e.enterpriseCode === code);
                dispatchForm.setFieldsValue({
                  targetEnterpriseName: hit ? hit.enterpriseName : undefined,
                });
              }}
            />
          </Form.Item>
          <Form.Item
            name="targetEnterpriseName"
            label="交办企业名称（由所选企业自动带出）"
            rules={[{ required: true, message: '请先选择交办企业' }]}
          >
            <Input disabled placeholder="选择交办企业后自动带出" />
          </Form.Item>
          <Form.Item name="deadline" label="截止时间">
            <DatePicker showTime style={{ width: '100%' }} placeholder="可选" />
          </Form.Item>
          <Form.Item name="requirement" label="交办要求">
            <Input.TextArea rows={2} placeholder="可选，例如：请核实情况并填报企业处置结果。" />
          </Form.Item>
          <Form.Item name="reason" label="交办原因">
            <Input.TextArea rows={2} placeholder="可选" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default ComplaintDetail;
