import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Result,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  EyeOutlined,
  RedoOutlined,
  ReloadOutlined,
  SearchOutlined,
  SendOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  cancelDispatch,
  getApprovalTrace,
  getDispatchOrder,
  getPushLogs,
  listDispatchOrders,
  pushDispatch,
  repushDispatch,
} from '../api/dispatch';
import { getDictItems } from '../api/dicts';
import type {
  ApiError,
  ApprovalTraceItem,
  DictItem,
  DispatchOrderDetail,
  DispatchOrderListItem,
  DispatchOrderParams,
  DispatchOrderStatus,
  DispatchRequestLogItem,
  FieldError,
  Paged,
  PushDispatchResult,
} from '../types/api';

/**
 * 敏感交办（真实接口驱动）。
 *
 * 设计纪律：
 *  - 删除页面内本地 25 条 Mock 交办数组与所有假成功提示。
 *  - 列表来自 GET /dispatch/orders 真查表，不是按敏感诉求现场生成。
 *  - 推送 / 重推 已接入真实接口（G3）；审批轨迹与推送记录在详情内展示（G4）。
 *  - 归档仍属 G5：disabled + Tooltip 说明批次，不弹假成功。
 *  - **不提供第二次新建交办**：交办一律在诉求总账发起（设计文档第 2 节）。
 */

/** 仅用于 Tag 配色；文案一律取服务端 statusName。 */
const STATUS_COLOR: Record<string, string> = {
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

/** 交办单可能出现的状态全集（用于筛选下拉，顺序即业务流程顺序） */
const DISPATCH_STATUSES: DispatchOrderStatus[] = [
  'pending',
  'pushed',
  'accepted',
  'processing',
  'returned',
  'completed',
  'rejected',
  'archived',
  'cancelled',
];

/** 终态：不可再撤销（与后端状态机一致） */
const TERMINAL_DISPATCH_STATUSES = new Set<string>([
  'completed',
  'rejected',
  'archived',
  'cancelled',
]);

/** 推送日志里 result 的配色（分类来自后端错误码处置表） */
const PUSH_RESULT_COLOR: Record<string, string> = {
  success: 'success',
  replay: 'warning',
  conflict: 'error',
  auth_failed: 'error',
  payload_too_large: 'error',
  validation_failed: 'error',
  timeout: 'warning',
  network_error: 'warning',
};

/**
 * G4 事件类型的中文名。
 * 注意：枚举只有这四个，**无法表达「企业签收」**（落地计划 §3.2 已标注的契约缺口），
 * 因此不要在这里补造第五种事件或签收文案。
 */
const EVENT_TYPE_LABEL: Record<string, string> = {
  task_submitted: '企业已提交',
  task_returned: '退回补正',
  task_approved: '最终通过',
  task_rejected: '审批不同意',
};

const TIMELINE_COLOR: Record<string, string> = {
  task_submitted: 'blue',
  task_returned: 'orange',
  task_approved: 'green',
  task_rejected: 'red',
};

const CONCLUSION_LABEL: Record<string, string> = {
  agreed: '同意',
  disagreed: '不同意',
  returned: '退回',
};

interface PushFeedback {
  level: 'success' | 'info' | 'warning' | 'error';
  title: string;
  description: string;
}

/**
 * 推送结果分类 -> 界面文案。逐条对应落地计划 §3.1 的错误码处置表。
 * 是否给「重推」按钮由后端返回的 retryable 决定（不在这里自己判断），
 * 因为"能不能重试"是对方的语义，前端不该猜。
 */
function pushFeedback(r: PushDispatchResult): PushFeedback {
  switch (r.result) {
    case 'success':
      // 注意 created 的语义：它描述的是**场景**，不是「本次是否新建」。
      //   契约（落地计划 §3.1）：sceneCode=GQXQ_SENSITIVE_DISPATCH -> created=true 且返回 task；
      //                            sceneCode=GQXQ_ORDINARY_ARCHIVE  -> created=false 且没有 task。
      //   gqxq 只会发敏感交办场景，所以正常路径恒为 created=true。
      //   「是否幂等命中」不能从这里判断——要看任务号是否与既有相同、以及日志里的 attempt。
      return r.created
        ? {
            level: 'success',
            title: r.attempt > 1 ? '重推成功（第 ' + r.attempt + ' 次尝试）' : '推送成功',
            description: '对方已受理为敏感交办任务，任务号已回填。同一请求号重复推送不会新建任务。',
          }
        : {
            level: 'warning',
            title: '对方按「仅归档」处理，未创建任务',
            description:
              '返回 created=false。按契约这表示对方把该场景判为普通归档（sceneCode 非敏感交办）；gqxq 只发送敏感交办场景，出现该结果说明场景编码或对方登记有误，请核对。',
          };
    case 'replay':
      return {
        level: 'warning',
        title: '对方检测到 nonce 重放（409 REPLAY）',
        description: '已换新 nonce 与时间戳重试。若仍失败可重推——请求号与报文保持不变。',
      };
    case 'conflict':
      return {
        level: 'error',
        title: '同请求号但报文不同（409 CONFLICT）',
        description:
          '不可自动重试。需人工核对该请求号下两系统的报文差异，确认后再决定；盲目重试只会继续冲突。',
      };
    case 'auth_failed':
      return {
        level: 'error',
        title: '鉴权失败（401）',
        description:
          '凭证、路径或时钟不符（时间戳容差 ±300 秒）。请检查 keyId/secret 与本机时钟，勿盲目重试。',
      };
    case 'payload_too_large':
      return {
        level: 'error',
        title: '报文超过 1 MiB（413）',
        description: '请精简 prefilledData / metadata 后重推，请求号不变。',
      };
    case 'validation_failed':
      return {
        level: 'error',
        title: '对方校验失败（422）',
        description:
          '请按下方字段错误修正后重推。注意：不要发送 organizationCode——它在对方验签白名单之外，发了必被 422。',
      };
    case 'timeout':
    case 'network_error':
      return {
        level: 'warning',
        title: '结果未知（超时 / 网络错误）',
        description: '将用同一请求号、同一报文重试，换新 nonce，不会新建交办。',
      };
    default:
      return { level: 'error', title: '推送失败：' + r.result, description: r.message ?? '' };
  }
}

const DASH = <span style={{ color: '#bfbfbf' }}>—</span>;

function fmtDateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString('zh-CN') : '—';
}

function fmtDateOnly(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString('zh-CN') : '—';
}

const DispatchOrders: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [statusFilter, setStatusFilter] = useState<DispatchOrderStatus[] | undefined>();
  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState<string | undefined>();

  const [data, setData] = useState<Paged<DispatchOrderListItem> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  /** 请求序号：快速切换筛选时丢弃过期响应，避免旧结果覆盖新结果 */
  const seqRef = useRef(0);

  /** 状态筛选下拉的文案来自服务端字典（supervision_status），前端不建翻译表 */
  const [statusDict, setStatusDict] = useState<DictItem[]>([]);
  const [dictError, setDictError] = useState<string | null>(null);

  /* ---------- 详情 ---------- */
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DispatchOrderDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  /* ---------- 受控撤销 ---------- */
  const [cancelTarget, setCancelTarget] = useState<DispatchOrderListItem | null>(null);
  const [cancelForm] = Form.useForm<{ reason: string }>();
  const [cancelling, setCancelling] = useState(false);

  /* ---------- G3 推送 ---------- */
  /** 正在推送的交办 id（用于按钮 loading，避免重复点击） */
  const [pushBusyId, setPushBusyId] = useState<string | null>(null);
  /**
   * 上一次推送的结果。两种来源都要能展示：
   *   kind='result' -> 后端按错误码处置表返回了分类；
   *   kind='error'  -> 请求本身失败（网络/401/501/409 等），此时必须显示错误态而不是假装成功。
   */
  const [pushOutcome, setPushOutcome] = useState<
    | { kind: 'result'; order: DispatchOrderListItem; result: PushDispatchResult }
    | { kind: 'error'; order: DispatchOrderListItem; message: string; fieldErrors?: FieldError[] }
    | null
  >(null);

  /* ---------- G3/G4 详情内的推送记录与审批轨迹 ---------- */
  const [pushLogs, setPushLogs] = useState<DispatchRequestLogItem[] | null>(null);
  const [pushLogsLoading, setPushLogsLoading] = useState(false);
  const [pushLogsError, setPushLogsError] = useState<string | null>(null);
  const [traces, setTraces] = useState<ApprovalTraceItem[] | null>(null);
  const [tracesLoading, setTracesLoading] = useState(false);
  const [tracesError, setTracesError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDictError(null);
    getDictItems('supervision_status')
      .then((items) => {
        if (alive) setStatusDict(items);
      })
      .catch((err: ApiError) => {
        if (alive) setDictError(err?.message ?? '字典加载失败');
      });
    return () => {
      alive = false;
    };
  }, []);

  const params = useMemo<DispatchOrderParams>(
    () => ({ page, size, keyword, status: statusFilter }),
    [page, size, keyword, statusFilter]
  );

  const load = useCallback(async (p: DispatchOrderParams) => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await listDispatchOrders(p);
      if (seq !== seqRef.current) return;
      setData(res);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError(err as ApiError);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(params);
  }, [params, load]);

  /**
   * 详情内的两块附属数据：推送记录（G3）与审批轨迹（G4）。
   * 与主详情**分开** try/catch：附属数据失败只在那块卡片内提示，不把整页打成错误态，
   * 也绝不因此伪造数据。
   */
  const loadSubLists = useCallback(async (assignmentId: string) => {
    setPushLogsLoading(true);
    setPushLogsError(null);
    setTracesLoading(true);
    setTracesError(null);
    try {
      const logs = await getPushLogs(assignmentId);
      setPushLogs(logs.content);
    } catch (err) {
      setPushLogs(null);
      setPushLogsError((err as ApiError)?.message ?? '推送记录加载失败');
    } finally {
      setPushLogsLoading(false);
    }
    try {
      const tr = await getApprovalTrace(assignmentId);
      setTraces(tr.content);
    } catch (err) {
      setTraces(null);
      setTracesError((err as ApiError)?.message ?? '审批轨迹加载失败');
    } finally {
      setTracesLoading(false);
    }
  }, []);

  /* ---------- 详情：打开时按 assignmentId 拉真实记录 ---------- */
  const openDetail = useCallback(
    async (assignmentId: string) => {
      setDetailId(assignmentId);
      setDetail(null);
      setDetailError(null);
      setDetailLoading(true);
      setPushLogs(null);
      setPushLogsError(null);
      setTraces(null);
      setTracesError(null);
      void loadSubLists(assignmentId);
      try {
        const d = await getDispatchOrder(assignmentId);
        setDetail(d);
      } catch (err) {
        setDetailError((err as ApiError)?.message ?? '交办详情加载失败');
      } finally {
        setDetailLoading(false);
      }
    },
    [loadSubLists]
  );

  const closeDetail = useCallback(() => {
    setDetailId(null);
    setDetail(null);
    setDetailError(null);
    if (searchParams.get('assignmentId')) {
      const next = new URLSearchParams(searchParams);
      next.delete('assignmentId');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  /** 从总账「查看交办」跳过来时带 ?assignmentId=xxx，自动打开详情 */
  const assignmentFromUrl = searchParams.get('assignmentId');
  useEffect(() => {
    if (assignmentFromUrl && assignmentFromUrl !== detailId) {
      void openDetail(assignmentFromUrl);
    }
  }, [assignmentFromUrl, detailId, openDetail]);

  const handleCancel = useCallback(async () => {
    if (!cancelTarget) return;
    let values: { reason: string };
    try {
      values = await cancelForm.validateFields();
    } catch {
      return;
    }
    setCancelling(true);
    const target = cancelTarget;
    try {
      // 忽略响应体：撤销后一律以重新拉取为准（后端未冻结 cancel 的响应形状）
      await cancelDispatch(target.assignmentId, values.reason.trim());
      message.success('已撤销交办 ' + target.orderNo);
      setCancelTarget(null);
      cancelForm.resetFields();
      if (detailId === target.assignmentId) void openDetail(target.assignmentId);
      void load(params);
    } catch (err) {
      message.error('撤销失败：' + ((err as ApiError)?.message ?? '未知错误'));
    } finally {
      setCancelling(false);
    }
  }, [cancelTarget, cancelForm, detailId, openDetail, load, params]);

  /**
   * 推送 / 重推。re=true 走 repush（同一 requestId、同一报文、新 nonce）。
   * 无论成功失败都刷新详情与列表——因为"结果未知"的超时也可能已经在对方建了任务，必须以服务端状态为准。
   */
  const handlePush = useCallback(
    async (order: DispatchOrderListItem, re: boolean) => {
      setPushBusyId(order.assignmentId);
      try {
        const res = re
          ? await repushDispatch(order.assignmentId)
          : await pushDispatch(order.assignmentId);
        setPushOutcome({ kind: 'result', order, result: res });
        if (res.result === 'success') {
          message.success(res.created ? '推送成功' : '对方按仅归档处理，未创建任务');
        }
      } catch (err) {
        const e = err as ApiError;
        setPushOutcome({
          kind: 'error',
          order,
          message: e?.message ?? '推送请求失败',
          fieldErrors: e?.fieldErrors,
        });
      } finally {
        setPushBusyId(null);
        if (detailId === order.assignmentId) void openDetail(order.assignmentId);
        void load(params);
      }
    },
    [detailId, openDetail, load, params]
  );

  const statusFilterOptions = useMemo(
    () =>
      DISPATCH_STATUSES.map((code) => {
        const hit = statusDict.find((d) => d.value === code);
        // 字典缺项时回退显示状态码本身，不编造中文
        return { value: code, label: hit ? hit.label : code };
      }),
    [statusDict]
  );

  const columns: ColumnsType<DispatchOrderListItem> = useMemo(
    () => [
      {
        title: '交办单号',
        dataIndex: 'orderNo',
        width: 160,
        fixed: 'left',
        render: (v: string, r) => <a onClick={() => void openDetail(r.assignmentId)}>{v}</a>,
      },
      {
        title: '诉求编号',
        dataIndex: 'complaintNo',
        width: 160,
        render: (v: string | null, r) =>
          v ? <a onClick={() => navigate('/complaints/' + r.complaintId)}>{v}</a> : DASH,
      },
      {
        title: '诉求标题',
        dataIndex: 'complaintTitle',
        ellipsis: true,
        render: (v: string | null) => (v ? <Tooltip title={v}>{v}</Tooltip> : DASH),
      },
      {
        title: '目标企业',
        dataIndex: 'targetEnterpriseName',
        width: 170,
        ellipsis: true,
        render: (v: string | null) => (v ? <Tooltip title={v}>{v}</Tooltip> : DASH),
      },
      {
        title: '交办方式',
        dataIndex: 'dispatchType',
        width: 100,
        // 契约里没有 dispatchTypeName / triggerTypeName，这里如实显示状态码，不编造中文
        render: (v: string | null) => (v ? <Tag color={v === 'auto' ? 'blue' : 'purple'}>{v}</Tag> : DASH),
      },
      {
        title: '触发类型',
        dataIndex: 'triggerType',
        width: 120,
        render: (v: string | null) => (v ? <Tag>{v}</Tag> : DASH),
      },
      {
        title: '状态',
        dataIndex: 'status',
        width: 120,
        render: (_: unknown, r) => (
          <Tag color={STATUS_COLOR[r.status] ?? 'default'}>{r.statusName}</Tag>
        ),
      },
      {
        title: '截止时间',
        dataIndex: 'deadline',
        width: 150,
        render: (v: string | null) => fmtDateTime(v),
      },
      {
        title: '创建时间',
        dataIndex: 'createdAt',
        width: 150,
        render: (v: string | null) => fmtDateTime(v),
      },
      {
        title: '请求号',
        dataIndex: 'requestId',
        width: 170,
        ellipsis: true,
        render: (v: string | null) => (v ? <Tooltip title={v}>{v}</Tooltip> : DASH),
      },
      {
        title: '填报任务号',
        dataIndex: 'reportingTaskId',
        width: 150,
        ellipsis: true,
        render: (v: string | null) =>
          v ? (
            <Tooltip title={v}>{v}</Tooltip>
          ) : (
            <Tooltip title="填报任务号由批次 G3 推送成功后回填">
              <span style={{ color: '#bfbfbf' }}>—</span>
            </Tooltip>
          ),
      },
      {
        title: '操作',
        width: 330,
        fixed: 'right',
        render: (_: unknown, r) => {
          const terminal = TERMINAL_DISPATCH_STATUSES.has(r.status);
          return (
            <Space size={4} wrap>
              <Button
                type="link"
                size="small"
                icon={<EyeOutlined />}
                onClick={() => void openDetail(r.assignmentId)}
              >
                详情
              </Button>
              {r.status === 'pending' ? (
                <Button
                  type="link"
                  size="small"
                  icon={<SendOutlined />}
                  loading={pushBusyId === r.assignmentId}
                  onClick={() => void handlePush(r, false)}
                >
                  推送
                </Button>
              ) : (
                <Tooltip
                  title={'当前状态为「' + r.statusName + '」，不能首次推送；如需重试请用「重推」'}
                >
                  <span>
                    <Button type="link" size="small" disabled icon={<SendOutlined />}>
                      推送
                    </Button>
                  </span>
                </Tooltip>
              )}
              {r.status === 'pushed' || r.status === 'returned' ? (
                <Button
                  type="link"
                  size="small"
                  icon={<RedoOutlined />}
                  loading={pushBusyId === r.assignmentId}
                  onClick={() => void handlePush(r, true)}
                >
                  重推
                </Button>
              ) : (
                <Tooltip title="仅「已推送」或「退回补正」可重推；重推使用同一请求号、同一报文、新 nonce，不会新建交办">
                  <span>
                    <Button type="link" size="small" disabled icon={<RedoOutlined />}>
                      重推
                    </Button>
                  </span>
                </Tooltip>
              )}
              <Tooltip title="无需手动同步：结果事件由 public-utility 主动回传（批次 G4），已在详情内展示审批轨迹">
                <span>
                  <Button type="link" size="small" disabled>
                    同步
                  </Button>
                </span>
              </Tooltip>
              <Tooltip title="功能未实现（批次 G5）">
                <span>
                  <Button type="link" size="small" disabled>
                    归档
                  </Button>
                </span>
              </Tooltip>
              {terminal ? (
                <Tooltip title={'已是终态（' + r.statusName + '），不可撤销'}>
                  <span>
                    <Button type="link" size="small" danger disabled icon={<StopOutlined />}>
                      撤销
                    </Button>
                  </span>
                </Tooltip>
              ) : (
                <Button
                  type="link"
                  size="small"
                  danger
                  icon={<StopOutlined />}
                  onClick={() => {
                    cancelForm.resetFields();
                    setCancelTarget(r);
                  }}
                >
                  撤销
                </Button>
              )}
            </Space>
          );
        },
      },
    ],
    [navigate, openDetail, cancelForm, handlePush, pushBusyId]
  );

  /** G3 推送记录列（一次尝试一行） */
  const pushLogColumns: ColumnsType<DispatchRequestLogItem> = useMemo(
    () => [
      { title: '尝试', dataIndex: 'attempt', width: 60 },
      {
        title: '结果',
        dataIndex: 'result',
        width: 140,
        render: (v: string) => <Tag color={PUSH_RESULT_COLOR[v] ?? 'default'}>{v}</Tag>,
      },
      {
        title: 'HTTP',
        dataIndex: 'httpStatus',
        width: 70,
        render: (v: number | null) => (v == null ? DASH : v),
      },
      {
        title: '错误码',
        dataIndex: 'errorCode',
        width: 180,
        ellipsis: true,
        render: (v: string | null) => (v ? <Tooltip title={v}>{v}</Tooltip> : DASH),
      },
      {
        title: 'nonce',
        dataIndex: 'nonce',
        width: 190,
        ellipsis: true,
        render: (v: string | null) => (v ? <Tooltip title={v}>{v}</Tooltip> : DASH),
      },
      {
        title: '任务号',
        dataIndex: 'taskId',
        width: 150,
        ellipsis: true,
        render: (v: string | null) => (v ? <Tooltip title={v}>{v}</Tooltip> : DASH),
      },
      {
        title: '耗时',
        width: 90,
        render: (_: unknown, r) => {
          if (!r.startedAt || !r.finishedAt) return DASH;
          const ms = new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime();
          return Number.isFinite(ms) ? ms + ' ms' : DASH;
        },
      },
      {
        title: '时间',
        dataIndex: 'createdAt',
        width: 160,
        render: (v: string | null) => fmtDateTime(v),
      },
    ],
    []
  );

  /** G4 审批轨迹，按 occurredAt 升序 */
  const timelineItems = useMemo(
    () =>
      (traces ?? [])
        .slice()
        .sort(
          (a, b) =>
            new Date(a.occurredAt ?? 0).getTime() - new Date(b.occurredAt ?? 0).getTime()
        )
        .map((t) => ({
          key: t.traceId,
          color: TIMELINE_COLOR[t.eventType] ?? 'blue',
          children: (
            <div>
              <div style={{ fontWeight: 500 }}>
                {EVENT_TYPE_LABEL[t.eventType] ?? t.eventType}
                {t.approvalConclusion
                  ? ' · ' + (CONCLUSION_LABEL[t.approvalConclusion] ?? t.approvalConclusion)
                  : ''}
              </div>
              <div style={{ color: '#999', fontSize: 12 }}>
                {fmtDateTime(t.occurredAt)}
                {t.actorName ? ' · ' + t.actorName : ''}
                {t.submissionVersion != null ? ' · 提交版本 v' + t.submissionVersion : ''}
              </div>
              <div>{t.summary ?? ''}</div>
            </div>
          ),
        })),
    [traces]
  );

  const pushFeedbackView =
    pushOutcome?.kind === 'result' ? pushFeedback(pushOutcome.result) : null;

  const firstLoading = loading && data === null;

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>敏感诉求交办</h2>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="交办一律在诉求总账发起"
        description="本页只展示已产生的交办记录及其进度，不提供第二次新建交办（设计文档第 2 节：进入敏感交办表示已完成交办决定）。如需交办，请到「诉求管理」对目标诉求操作。"
      />

      {dictError && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={'状态字典加载失败：' + dictError}
          description="状态筛选下拉的文案来自服务端字典；加载失败时下拉回退显示状态码本身，表格数据不受影响。"
        />
      )}

      <Card>
        <Space style={{ marginBottom: 16 }} wrap>
          <Input.Search
            placeholder="搜索交办单号/诉求编号/标题"
            prefix={<SearchOutlined />}
            value={keywordInput}
            allowClear
            style={{ width: 280 }}
            onChange={(e) => {
              setKeywordInput(e.target.value);
              if (e.target.value === '') {
                setKeyword(undefined);
                setPage(1);
              }
            }}
            onSearch={(v) => {
              setKeyword(v.trim() === '' ? undefined : v.trim());
              setPage(1);
            }}
          />
          <Select
            mode="multiple"
            placeholder="状态（可多选）"
            allowClear
            style={{ minWidth: 260 }}
            options={statusFilterOptions}
            value={statusFilter}
            onChange={(v: DispatchOrderStatus[]) => {
              setStatusFilter(v && v.length > 0 ? v : undefined);
              setPage(1);
            }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load(params)} loading={loading}>
            刷新
          </Button>
        </Space>

        {error ? (
          <Result
            status="error"
            title="交办列表加载失败"
            subTitle={error.message}
            extra={
              <Space>
                <Button type="primary" onClick={() => void load(params)}>
                  重试
                </Button>
                <Button onClick={() => navigate('/complaints')}>去诉求管理</Button>
              </Space>
            }
          />
        ) : (
          <Table<DispatchOrderListItem>
            rowKey="assignmentId"
            columns={columns}
            dataSource={data?.content ?? []}
            loading={loading}
            size="middle"
            scroll={{ x: 1900 }}
            locale={{
              emptyText: firstLoading ? <span /> : <Empty description="暂无交办记录" />,
            }}
            pagination={{
              current: page,
              pageSize: size,
              total: data?.total ?? 0,
              showSizeChanger: true,
              showTotal: (total) => '共 ' + total + ' 条交办单',
              onChange: (nextPage, nextSize) => {
                if (nextSize !== size) {
                  setSize(nextSize);
                  setPage(1);
                } else {
                  setPage(nextPage);
                }
              },
            }}
          />
        )}
      </Card>

      {/* ---------- 详情 ---------- */}
      <Modal
        title={detail ? '交办详情 - ' + detail.orderNo : '交办详情'}
        open={detailId !== null}
        onCancel={closeDetail}
        footer={
          <Space>
            <Button onClick={closeDetail}>关闭</Button>
            <Button onClick={() => navigate('/complaints/' + (detail ? detail.complaintId : ''))} disabled={!detail}>
              查看关联诉求
            </Button>
          </Space>
        }
        width={900}
      >
        {detailLoading && <Typography.Text type="secondary">加载中…</Typography.Text>}

        {!detailLoading && detailError && (
          <Alert
            type="error"
            showIcon
            message="交办详情加载失败"
            description={detailError}
            action={
              <Button size="small" onClick={() => detailId && void openDetail(detailId)}>
                重试
              </Button>
            }
          />
        )}

        {!detailLoading && !detailError && detail && (
          <>
            <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="交办单号">{detail.orderNo}</Descriptions.Item>
            <Descriptions.Item label="状态">
              <Tag color={STATUS_COLOR[detail.status] ?? 'default'}>{detail.statusName}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="诉求编号">
              {detail.complaintNo ?? DASH}
            </Descriptions.Item>
            <Descriptions.Item label="诉求标题">
              {detail.complaintTitle ?? DASH}
            </Descriptions.Item>
            <Descriptions.Item label="目标企业">
              {detail.targetEnterpriseName ?? DASH}
            </Descriptions.Item>
            <Descriptions.Item label="企业编码">
              {detail.targetEnterpriseCode ?? DASH}
            </Descriptions.Item>
            <Descriptions.Item label="交办方式">{detail.dispatchType ?? DASH}</Descriptions.Item>
            <Descriptions.Item label="触发类型">{detail.triggerType ?? DASH}</Descriptions.Item>
            <Descriptions.Item label="敏感词" span={2}>
              {detail.sensitiveWords.length > 0
                ? detail.sensitiveWords.map((w) => (
                    <Tag color="red" key={w}>
                      {w}
                    </Tag>
                  ))
                : DASH}
            </Descriptions.Item>
            <Descriptions.Item label="交办原因">{detail.reason ?? DASH}</Descriptions.Item>
            <Descriptions.Item label="截止时间">{fmtDateTime(detail.deadline)}</Descriptions.Item>
            <Descriptions.Item label="交办要求" span={2}>
              {detail.requirement ?? DASH}
            </Descriptions.Item>
            <Descriptions.Item label="请求号" span={2}>
              {detail.requestId ?? DASH}
            </Descriptions.Item>
            <Descriptions.Item label="填报任务号">
              {detail.reportingTaskId ?? (
                <Tooltip title="填报任务号由批次 G3 推送成功后回填">
                  <span style={{ color: '#bfbfbf' }}>—</span>
                </Tooltip>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="填报状态">
              {detail.externalStatus ?? DASH}
            </Descriptions.Item>
            <Descriptions.Item label="推送状态">{detail.syncStatus ?? DASH}</Descriptions.Item>
            <Descriptions.Item label="推送时间">{fmtDateTime(detail.pushedAt)}</Descriptions.Item>
            <Descriptions.Item label="完成时间">{fmtDateTime(detail.completedAt)}</Descriptions.Item>
            <Descriptions.Item label="归档时间">{fmtDateTime(detail.archivedAt)}</Descriptions.Item>
            <Descriptions.Item label="模板">
              {detail.templateCode
                ? detail.templateCode + (detail.templateVersion != null ? ' v' + detail.templateVersion : '')
                : DASH}
            </Descriptions.Item>
            <Descriptions.Item label="审批定义">
              {detail.approvalDefinitionCode
                ? detail.approvalDefinitionCode +
                  (detail.approvalDefinitionVersion != null
                    ? ' v' + detail.approvalDefinitionVersion
                    : '')
                : DASH}
            </Descriptions.Item>
            <Descriptions.Item label="结果内容" span={2}>
              {detail.resultContent ?? DASH}
            </Descriptions.Item>
            <Descriptions.Item label="撤销时间">{fmtDateTime(detail.cancelledAt)}</Descriptions.Item>
            <Descriptions.Item label="撤销原因">{detail.cancelReason ?? DASH}</Descriptions.Item>
            <Descriptions.Item label="创建人">{detail.createdByName ?? DASH}</Descriptions.Item>
            <Descriptions.Item label="创建时间">{fmtDateTime(detail.createdAt)}</Descriptions.Item>
            <Descriptions.Item label="最后更新" span={2}>
              {fmtDateTime(detail.updatedAt)}
            </Descriptions.Item>
            </Descriptions>

            {/* G3 推送记录 */}
            <Typography.Title level={5} style={{ marginTop: 20 }}>
              推送记录
            </Typography.Title>
            {pushLogsError ? (
              <Alert
                type="error"
                showIcon
                message="推送记录加载失败"
                description={pushLogsError}
                action={
                  <Button size="small" onClick={() => detailId && void loadSubLists(detailId)}>
                    重试
                  </Button>
                }
              />
            ) : (
              <Table<DispatchRequestLogItem>
                rowKey="requestLogId"
                size="small"
                loading={pushLogsLoading}
                dataSource={pushLogs ?? []}
                columns={pushLogColumns}
                pagination={false}
                scroll={{ x: 1040 }}
                locale={{ emptyText: <Empty description="尚未推送" /> }}
              />
            )}

            {/* G4 审批轨迹 */}
            <Typography.Title level={5} style={{ marginTop: 20 }}>
              审批轨迹
            </Typography.Title>
            {tracesError ? (
              <Alert
                type="error"
                showIcon
                message="审批轨迹加载失败"
                description={tracesError}
                action={
                  <Button size="small" onClick={() => detailId && void loadSubLists(detailId)}>
                    重试
                  </Button>
                }
              />
            ) : tracesLoading ? (
              <Typography.Text type="secondary">加载中…</Typography.Text>
            ) : timelineItems.length === 0 ? (
              <Empty description="暂无审批轨迹" />
            ) : (
              <Timeline items={timelineItems} />
            )}

            <Alert
              style={{ marginTop: 12 }}
              type="info"
              showIcon
              message="签收不在回传事件里"
              description="对方的结果事件只有 提交/退回/通过/不同意 四类，无法表达「企业签收」，因此本轨迹不会出现签收节点（落地计划 §3.2 已标注的契约缺口）。"
            />
          </>
        )}
      </Modal>

      {/* ---------- G3 推送结果 ---------- */}
      <Modal
        title="推送结果"
        open={pushOutcome !== null}
        onCancel={() => setPushOutcome(null)}
        footer={
          <Space>
            <Button onClick={() => setPushOutcome(null)}>关闭</Button>
            {pushOutcome?.kind === 'error' && (
              <Button
                type="primary"
                loading={pushBusyId === pushOutcome.order.assignmentId}
                onClick={() => void handlePush(pushOutcome.order, true)}
              >
                重试（同一请求号、同一报文、新 nonce）
              </Button>
            )}
            {pushOutcome?.kind === 'result' && pushOutcome.result.retryable && (
              <Button
                type="primary"
                loading={pushBusyId === pushOutcome.order.assignmentId}
                onClick={() => void handlePush(pushOutcome.order, true)}
              >
                重推（同一请求号、同一报文、新 nonce）
              </Button>
            )}
          </Space>
        }
        width={660}
      >
        {pushOutcome?.kind === 'error' && (
          <>
            <Alert type="error" showIcon message="推送请求失败" description={pushOutcome.message} />
            {pushOutcome.fieldErrors && pushOutcome.fieldErrors.length > 0 && (
              <ul style={{ marginTop: 12, paddingLeft: 20 }}>
                {pushOutcome.fieldErrors.map((f) => (
                  <li key={f.field}>
                    <Typography.Text code>{f.field}</Typography.Text>：{f.message}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {pushOutcome?.kind === 'result' && pushFeedbackView && (
          <>
            <Alert
              type={pushFeedbackView.level}
              showIcon
              message={pushFeedbackView.title}
              description={pushFeedbackView.description}
            />
            <Descriptions bordered size="small" column={1} style={{ marginTop: 12 }}>
              <Descriptions.Item label="交办单号">{pushOutcome.order.orderNo}</Descriptions.Item>
              <Descriptions.Item label="请求号">{pushOutcome.result.requestId}</Descriptions.Item>
              <Descriptions.Item label="尝试次数">{pushOutcome.result.attempt}</Descriptions.Item>
              <Descriptions.Item label="结果分类">
                <Tag color={PUSH_RESULT_COLOR[pushOutcome.result.result] ?? 'default'}>
                  {pushOutcome.result.result}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="HTTP 状态">
                {pushOutcome.result.httpStatus ?? DASH}
              </Descriptions.Item>
              <Descriptions.Item label="对方错误码">
                {pushOutcome.result.errorCode ?? DASH}
              </Descriptions.Item>
              <Descriptions.Item label="填报任务号">
                {pushOutcome.result.taskId ?? DASH}
              </Descriptions.Item>
              <Descriptions.Item label="可自动重试">
                {pushOutcome.result.retryable ? '是' : '否'}
              </Descriptions.Item>
              {pushOutcome.result.message && (
                <Descriptions.Item label="对方消息">{pushOutcome.result.message}</Descriptions.Item>
              )}
            </Descriptions>
            {!pushOutcome.result.retryable && (
              <Alert
                style={{ marginTop: 12 }}
                type="warning"
                showIcon
                message="该结果不可自动重试"
                description="请先人工核对（凭证与时钟、同请求号的报文差异、或字段错误），确认后再手动重推。"
              />
            )}
          </>
        )}
      </Modal>

      {/* ---------- 受控撤销 ---------- */}
      <Modal
        title={cancelTarget ? '受控撤销交办 ' + cancelTarget.orderNo : '受控撤销交办'}
        open={cancelTarget !== null}
        onCancel={() => {
          setCancelTarget(null);
          cancelForm.resetFields();
        }}
        onOk={() => void handleCancel()}
        confirmLoading={cancelling}
        okText="确认撤销"
        okButtonProps={{ danger: true }}
        width={520}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="撤销后不可复活"
          description="该交办会进入终态「已撤销」，且本次操作会写入审计。如需重新交办，请在诉求总账重新发起。"
        />
        <Form form={cancelForm} layout="vertical">
          <Form.Item
            name="reason"
            label="撤销原因"
            rules={[{ required: true, message: '必须填写撤销原因' }]}
          >
            <Input.TextArea rows={3} placeholder="例如：重复交办 / 交办对象有误 / 业主撤回" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default DispatchOrders;
