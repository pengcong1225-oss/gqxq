import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Result,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  EyeOutlined,
  ExportOutlined,
  FileTextOutlined,
  ImportOutlined,
  InboxOutlined,
  SearchOutlined,
  SendOutlined,
  UserOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import type { Dayjs } from 'dayjs';
import { listComplaints } from '../api/complaints';
import { applyDisposition, assignEnterprise } from '../api/complaintActions';
import { createDispatch } from '../api/dispatch';
import { getDictItems } from '../api/dicts';
import { listEnterprises } from '../api/enterprises';
import { getSourceAdapterState } from '../api/source';
import type {
  ApiError,
  BusinessType,
  ComplaintListItem,
  ComplaintListParams,
  ComplaintListResult,
  ComplaintType,
  CorrectionStatus,
  DictCode,
  DictItem,
  DispositionKind,
  EnterpriseListItem,
  OvertimeFilter,
  SourceAdapterState,
  SourceEventStatus,
  SupervisionStatus,
  UrgencyLevel,
} from '../types/api';

const { RangePicker } = DatePicker;

/**
 * 诉求总账（真实接口驱动）。
 *
 * 设计纪律（《2026-09-17-诉求平台G1详细实施方案》§0 交付纪律）：
 *  - 无 Mock、无 || 兜底：接口失败就是失败态，绝不回落到示例数据。
 *  - 中文名一律用服务端返回的 *Name 字段，前端不建翻译表（这里只保留按 code 取色的色板）。
 *  - 未实现的按钮 disabled + Tooltip 说明归属批次，不弹假成功。
 */

/* ---------------- 筛选条件 ---------------- */

interface Filters {
  keyword?: string;
  businessType?: BusinessType;
  complaintType?: ComplaintType;
  urgencyLevel?: UrgencyLevel;
  supervisionStatus?: SupervisionStatus;
  sourceEventStatus?: SourceEventStatus;
  /** 超期时效筛选；undefined = 全部（不传该参数） */
  overtime?: OvertimeFilter;
  isSensitive?: 0 | 1;
  correctionStatus?: CorrectionStatus;
  districtCode?: string;
  range?: [Dayjs | null, Dayjs | null] | null;
}

/** 仅用于 Tag 配色；文案一律取服务端 *Name 字段。 */
const BUSINESS_COLOR: Record<string, string> = { water: 'blue', gas: 'orange', lpg: 'purple' };
const URGENCY_COLOR: Record<string, string> = { normal: 'blue', urgent: 'orange', critical: 'red' };
const CORRECTION_COLOR: Record<string, string> = {
  none: 'default',
  pending: 'warning',
  corrected: 'success',
  failed: 'error',
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

/**
 * 超期时效三态的 Tag 配色（**只配色，不配文案**——文案取服务端 overtimeFlagName）。
 * 键是筛选口径而不是库值：'none' 代表 overtime_flag IS NULL。
 * NULL 用中性灰而不是绿色：它的意思是"来源没给时效信息"，画成绿色会被读成"没超期"。
 */
const OVERTIME_COLOR: Record<'1' | '0' | 'none', string> = {
  '1': 'red',
  '0': 'green',
  none: 'default',
};

/** 筛选下拉用的字典类型（标签来自服务端 /dicts/:code/items，不在前端硬编码）。 */
const DICT_CODES: DictCode[] = [
  'business_type',
  'complaint_type',
  'urgency_level',
  'supervision_status',
  'source_event_status',
  'correction_status',
  'district',
];

/* ---------------- 小工具 ---------------- */

const DASH = <span style={{ color: '#bfbfbf' }}>—</span>;

function fmtDateTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('zh-CN') : '—';
}

const ComplaintList: React.FC = () => {
  const navigate = useNavigate();

  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [filters, setFilters] = useState<Filters>({});
  const [keywordInput, setKeywordInput] = useState('');
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);

  const [data, setData] = useState<ComplaintListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const [dicts, setDicts] = useState<Partial<Record<DictCode, DictItem[]>>>({});
  const [dictError, setDictError] = useState<string | null>(null);

  /** 请求序号：快速切换筛选时，过期响应必须被丢弃，否则旧结果会覆盖新结果。 */
  const seqRef = useRef(0);

  /* ---------- 字典：筛选下拉的标签一律来自服务端 ---------- */
  useEffect(() => {
    let alive = true;
    setDictError(null);
    Promise.all(DICT_CODES.map(async (code) => [code, await getDictItems(code)] as const))
      .then((entries) => {
        if (!alive) return;
        setDicts(Object.fromEntries(entries) as Partial<Record<DictCode, DictItem[]>>);
      })
      .catch((err: ApiError) => {
        if (!alive) return;
        setDictError(err?.message ?? '字典加载失败');
      });
    return () => {
      alive = false;
    };
  }, []);

  const dictOptions = useCallback(
    (code: DictCode) => (dicts[code] ?? []).map((d) => ({ value: d.value, label: d.label })),
    [dicts]
  );

  /* ---------- G6：来源对接状态 ----------
   * 适配器默认关闭，列表里的来源状态因此一律是「未接入」——那是**真实状态**，不是异常。
   * 这里只如实呈现服务端返回的状态：绝不用本地常量假装适配器已接入或未接入。 */
  const [sourceState, setSourceState] = useState<SourceAdapterState | null>(null);
  const [sourceStateError, setSourceStateError] = useState<string | null>(null);

  const loadSourceState = useCallback(async () => {
    setSourceStateError(null);
    try {
      setSourceState(await getSourceAdapterState());
    } catch (err) {
      // 获取失败时**不能**当成「未接入」——那是编造适配器状态，与编造来源进度同样不可接受。
      setSourceState(null);
      setSourceStateError((err as ApiError)?.message ?? '来源对接状态获取失败');
    }
  }, []);

  useEffect(() => {
    void loadSourceState();
  }, [loadSourceState]);

  /* ---------- 查询参数 ---------- */
  const params = useMemo<ComplaintListParams>(
    () => ({
      page,
      size,
      keyword: filters.keyword,
      businessType: filters.businessType,
      complaintType: filters.complaintType,
      urgencyLevel: filters.urgencyLevel,
      supervisionStatus: filters.supervisionStatus,
      sourceEventStatus: filters.sourceEventStatus,
      overtime: filters.overtime,
      isSensitive: filters.isSensitive,
      correctionStatus: filters.correctionStatus,
      startDate: filters.range?.[0] ? filters.range[0].format('YYYY-MM-DD') : undefined,
      endDate: filters.range?.[1] ? filters.range[1].format('YYYY-MM-DD') : undefined,
    }),
    [page, size, filters]
  );

  const load = useCallback(async (p: ComplaintListParams) => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await listComplaints(p);
      if (seq !== seqRef.current) return; // 过期响应，丢弃
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

  /** 任一筛选变化都回到第 1 页 */
  const applyFilter = useCallback((patch: Partial<Filters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setPage(1);
  }, []);

  const stats = data?.stats;
  const firstLoading = loading && data === null;

  /* ---------- G2：匹配单位 / 发起交办 / 归库 ---------- */
  const [assignTarget, setAssignTarget] = useState<ComplaintListItem | null>(null);
  const [dispatchTarget, setDispatchTarget] = useState<ComplaintListItem | null>(null);
  const [dispositionTarget, setDispositionTarget] = useState<{
    row: ComplaintListItem;
    kind: DispositionKind;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [assignForm] = Form.useForm<{
    enterpriseCode: string;
    enterpriseName: string;
    reason?: string;
  }>();
  const [dispatchForm] = Form.useForm<{
    targetEnterpriseCode: string;
    targetEnterpriseName: string;
    deadline?: Dayjs;
    requirement?: string;
    reason?: string;
  }>();
  const [dispositionForm] = Form.useForm<{ reason: string }>();

  /* ---------- 企业主数据：匹配单位 / 发起交办时的企业选择 ---------- */
  // 企业清单来自服务端 GET /enterprises。这里**不做本地兜底**：
  // 手抄 enterprise_code 一旦与登记值不一致，后续交办就匹配不到同一主体。
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

  /** 选项文本：企业名称（编码）· 业务类型 */
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

  /**
   * 服务端结果里若没有该诉求已登记的企业，把它补在首位以便回显。
   * 注意这不是「硬编码企业清单」：值来自这条诉求自身已登记的责任单位，不是前端常量。
   */
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

  /** 企业列表加载失败时的统一提示（可重试，且明确说明不会用本地示例企业替代） */
  const enterpriseErrorAlert = enterpriseError ? (
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
  ) : null;

  /**
   * G6 来源对接状态提示。三态必须分清，不能混成一个"出错了"：
   *   * 状态获取失败 -> 不能假装未接入（那是编造适配器状态），给可重试提示；
   *   * 配置无效     -> 警告级，原样展示服务端 message；
   *   * 适配器关闭   -> **信息级**（这是真实状态，不是错误），并说明列表里显示「未接入」的原因；
   *   * 已接入       -> 不显示任何提示条。
   */
  const sourceStatusAlert = (() => {
    if (sourceStateError !== null) {
      return (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
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
      );
    }
    if (sourceState === null) return null; // 尚未取到：不做任何断言，避免误报
    if (sourceState.enabled) return null; // 已接入：不显示提示条

    if (sourceState.misconfigured) {
      return (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={'来源对接：适配器配置无效（批次 ' + (sourceState.batch ?? 'G6') + '）'}
          description={
            <>
              {sourceState.message}
              <br />
              列表中的来源状态一律显示「未接入」，这是真实状态，不代表异常。
            </>
          }
        />
      );
    }
    return (
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={'来源对接：未接入（批次 ' + (sourceState.batch ?? 'G6') + '）'}
        description={
          <>
            {sourceState.message}
            <br />
            列表中的来源状态一律显示「未接入」，这是真实状态，不代表异常；本平台不展示任何模拟的来源进度。
          </>
        }
      />
    );
  })();

  const reload = useCallback(() => {
    void load(params);
  }, [load, params]);

  const handleAssign = useCallback(async () => {
    if (!assignTarget) return;
    let values: { enterpriseCode: string; enterpriseName: string; reason?: string };
    try {
      values = await assignForm.validateFields();
    } catch {
      return;
    }
    setSubmitting(true);
    try {
      const res = await assignEnterprise(assignTarget.complaintId, {
        enterpriseCode: values.enterpriseCode.trim(),
        enterpriseName: values.enterpriseName.trim(),
        reason: values.reason?.trim() || undefined,
      });
      message.success('已匹配责任单位：' + (res.afterEnterpriseName ?? values.enterpriseName.trim()));
      setAssignTarget(null);
      assignForm.resetFields();
      reload();
    } catch (err) {
      message.error('匹配责任单位失败：' + ((err as ApiError)?.message ?? '未知错误'));
    } finally {
      setSubmitting(false);
    }
  }, [assignTarget, assignForm, reload]);

  const handleCreateDispatch = useCallback(async () => {
    if (!dispatchTarget) return;
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
        complaintId: dispatchTarget.complaintId,
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
        // 并发下已有交办：后端返回既有记录，不得再建第二条
        message.warning('该诉求已有交办（' + res.order.orderNo + '），未创建新交办');
      } else {
        message.success('已创建交办 ' + res.order.orderNo);
      }
      setDispatchTarget(null);
      dispatchForm.resetFields();
      reload();
    } catch (err) {
      message.error('创建交办失败：' + ((err as ApiError)?.message ?? '未知错误'));
    } finally {
      setSubmitting(false);
    }
  }, [dispatchTarget, dispatchForm, reload]);

  const handleDisposition = useCallback(async () => {
    if (!dispositionTarget) return;
    let values: { reason: string };
    try {
      values = await dispositionForm.validateFields();
    } catch {
      return;
    }
    setSubmitting(true);
    const target = dispositionTarget;
    try {
      await applyDisposition(target.row.complaintId, {
        disposition: target.kind,
        reason: values.reason.trim(),
      });
      message.success(
        target.kind === 'false_positive' ? '已按误报归库' : '已按无需交办归库'
      );
      setDispositionTarget(null);
      dispositionForm.resetFields();
      reload();
    } catch (err) {
      message.error('归库失败：' + ((err as ApiError)?.message ?? '未知错误'));
    } finally {
      setSubmitting(false);
    }
  }, [dispositionTarget, dispositionForm, reload]);

  /* ---------- 列 ---------- */
  const columns: ColumnsType<ComplaintListItem> = useMemo(
    () => [
      {
        title: '诉求编号',
        dataIndex: 'complaintNo',
        width: 160,
        fixed: 'left',
        render: (v: string, r) => <a onClick={() => navigate('/complaints/' + r.id)}>{v}</a>,
      },
      {
        title: '标题',
        dataIndex: 'title',
        ellipsis: true,
        render: (t: string, r) => (
          <>
            {r.isSensitive && (
              <Tag color="red" style={{ marginRight: 4 }}>
                敏感
              </Tag>
            )}
            <Tooltip title={t}>{t}</Tooltip>
          </>
        ),
      },
      {
        title: '业务类型',
        dataIndex: 'businessTypeCode',
        width: 90,
        render: (_: unknown, r) => (
          <Tag color={BUSINESS_COLOR[r.businessTypeCode] ?? 'default'}>{r.businessTypeName}</Tag>
        ),
      },
      {
        title: '诉求类型',
        dataIndex: 'complaintTypeCode',
        width: 90,
        render: (_: unknown, r) => <Tag>{r.complaintTypeName}</Tag>,
      },
      {
        title: '紧急程度',
        dataIndex: 'urgencyLevelCode',
        width: 90,
        render: (_: unknown, r) => (
          <Tag color={URGENCY_COLOR[r.urgencyLevelCode] ?? 'default'}>{r.urgencyLevelName}</Tag>
        ),
      },
      {
        title: '来源系统',
        dataIndex: 'sourceSystem',
        width: 110,
        render: (v: string | null) => (v ? <Tag color="blue">{v}</Tag> : DASH),
      },
      {
        title: '来源渠道',
        dataIndex: 'sourceChannel',
        width: 100,
        render: (v: string | null) => v ?? DASH,
      },
      {
        title: '督办状态',
        dataIndex: 'supervisionStatusCode',
        width: 130,
        render: (_: unknown, r) => (
          <Tag color={SUPERVISION_COLOR[r.supervisionStatusCode] ?? 'default'}>
            {r.supervisionStatusName}
          </Tag>
        ),
      },
      {
        title: '来源状态',
        dataIndex: 'sourceEventStatusCode',
        width: 110,
        render: (_: unknown, r) =>
          r.sourceEventStatusCode === 'unknown' ? (
            <Tooltip title="宜接就办接口尚未对接（批次 G6），来源处置状态暂不可知">
              <Tag color="default">{r.sourceEventStatusName}</Tag>
            </Tooltip>
          ) : (
            <Tag color="cyan">{r.sourceEventStatusName}</Tag>
          ),
      },
      {
        title: '超期',
        dataIndex: 'overtimeFlag',
        width: 110,
        render: (_: unknown, r) => {
          const key = r.overtimeFlag === 1 ? '1' : r.overtimeFlag === 0 ? '0' : 'none';
          const tag = <Tag color={OVERTIME_COLOR[key]}>{r.overtimeFlagName}</Tag>;
          return key === 'none' ? (
            <Tooltip title="来源未给出时效信息（未同步 / 正常在办 / 状态认不出 / 历史未回填），不等于「未超期」">
              {tag}
            </Tooltip>
          ) : (
            tag
          );
        },
      },
      {
        title: '区域',
        dataIndex: 'districtName',
        width: 90,
        render: (v: string | null) => v ?? DASH,
      },
      {
        title: '责任企业',
        dataIndex: 'enterpriseName',
        width: 180,
        ellipsis: true,
        render: (v: string | null) =>
          v ? <Tooltip title={v}>{v}</Tooltip> : <span style={{ color: '#faad14' }}>未匹配</span>,
      },
      {
        // 业务口径时间（与服务端 complaintRepo.BUSINESS_TIME 一致）：
        // 来源给了受理时间就用它，否则回落接收时间。
        // 与下面的「接收时间」并列展示——历史数据一次性回灌时，两列会明显分离，
        // 让"这批件其实是 3~9 月受理、今天才入库"在台账里直接可见。
        title: '受理时间',
        dataIndex: 'sourceReportedAt',
        width: 165,
        render: (v: string | null) =>
          v ? fmtDateTime(v) : <Tooltip title="来源未提供受理时间"><span style={{ color: '#bfbfbf' }}>—</span></Tooltip>,
      },
      {
        title: '接收时间',
        dataIndex: 'receivedAt',
        width: 165,
        render: (v: string | null) => fmtDateTime(v),
      },
      {
        title: '操作',
        width: 300,
        fixed: 'right',
        render: (_: unknown, r) => (
          <Space size={0} wrap>
            <Button
              type="link"
              size="small"
              icon={<EyeOutlined />}
              onClick={() => navigate('/complaints/' + r.id)}
            >
              详情
            </Button>
            <Button
              type="link"
              size="small"
              icon={<UserOutlined />}
              onClick={() => {
                assignForm.resetFields();
                assignForm.setFieldsValue({
                  enterpriseCode: r.enterpriseCode ?? '',
                  enterpriseName: r.enterpriseName ?? '',
                });
                clearEnterpriseError();
                void fetchEnterprises();
                setAssignTarget(r);
              }}
            >
              匹配单位
            </Button>
            {r.activeDispatchId ? (
              // 已有进行中交办：不再提供第二次交办，只能查看
              <Button
                type="link"
                size="small"
                icon={<SendOutlined />}
                onClick={() =>
                  navigate('/dispatch?assignmentId=' + encodeURIComponent(r.activeDispatchId ?? ''))
                }
              >
                查看交办
              </Button>
            ) : (
              <Button
                type="link"
                size="small"
                icon={<SendOutlined />}
                onClick={() => {
                  dispatchForm.resetFields();
                  dispatchForm.setFieldsValue({
                    targetEnterpriseCode: r.enterpriseCode ?? '',
                    targetEnterpriseName: r.enterpriseName ?? '',
                  });
                  clearEnterpriseError();
                  void fetchEnterprises();
                  setDispatchTarget(r);
                }}
              >
                交办
              </Button>
            )}
            {r.activeDispatchId ? (
              // 后端状态机要求：有进行中交办时归库会被拒（409 INVALID_STATE_TRANSITION）
              <Tooltip title="该诉求已有进行中交办，请先到「敏感交办」受控撤销后再归库">
                <span>
                  <Button type="link" size="small" icon={<InboxOutlined />} disabled>
                    归库
                  </Button>
                </span>
              </Tooltip>
            ) : (
              <Dropdown
                menu={{
                  items: [
                    { key: 'no_dispatch_needed', label: '无需交办归库' },
                    { key: 'false_positive', label: '误报归库' },
                  ],
                  onClick: ({ key }) => {
                    dispositionForm.resetFields();
                    setDispositionTarget({ row: r, kind: key as DispositionKind });
                  },
                }}
              >
                <Button type="link" size="small" icon={<InboxOutlined />}>
                  归库
                </Button>
              </Dropdown>
            )}
          </Space>
        ),
      },
    ],
    [navigate, assignForm, dispatchForm, dispositionForm, clearEnterpriseError, fetchEnterprises]
  );

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>诉求管理</h2>

      {dictError && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={'筛选字典加载失败：' + dictError}
          description="筛选下拉项来自服务端字典接口，加载失败时下拉为空；表格数据不受影响。"
        />
      )}

      {sourceStatusAlert}

      <Row gutter={12} style={{ marginBottom: 16 }}>
        <Col span={4}>
          <Card size="small">
            <Statistic title="总诉求" value={stats ? stats.total : '—'} loading={firstLoading} prefix={<FileTextOutlined />} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="未交办" value={stats ? stats.notDispatchedCount : '—'} loading={firstLoading} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="待匹配" value={stats ? stats.pendingMatchCount : '—'} loading={firstLoading} valueStyle={{ color: '#faad14' }} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="已交办" value={stats ? stats.activeDispatchCount : '—'} loading={firstLoading} prefix={<ClockCircleOutlined />} valueStyle={{ color: '#1677ff' }} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="敏感诉求" value={stats ? stats.sensitiveCount : '—'} loading={firstLoading} prefix={<WarningOutlined />} valueStyle={{ color: '#ff4d4f' }} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="本系统办结" value={stats ? stats.closedInSystemCount : '—'} loading={firstLoading} prefix={<CheckCircleOutlined />} valueStyle={{ color: '#52c41a' }} />
          </Card>
        </Col>
      </Row>

      <Card>
        <Space style={{ marginBottom: 16 }} wrap>
          <Input.Search
            placeholder="搜索编号/标题/内容/地址"
            prefix={<SearchOutlined />}
            value={keywordInput}
            allowClear
            style={{ width: 260 }}
            onChange={(e) => {
              setKeywordInput(e.target.value);
              if (e.target.value === '') applyFilter({ keyword: undefined });
            }}
            onSearch={(v) => applyFilter({ keyword: v.trim() === '' ? undefined : v.trim() })}
          />
          <Select
            placeholder="业务类型"
            allowClear
            style={{ width: 120 }}
            options={dictOptions('business_type')}
            onChange={(v: BusinessType | undefined) => applyFilter({ businessType: v })}
          />
          <Select
            placeholder="诉求类型"
            allowClear
            style={{ width: 120 }}
            options={dictOptions('complaint_type')}
            onChange={(v: ComplaintType | undefined) => applyFilter({ complaintType: v })}
          />
          <Select
            placeholder="紧急程度"
            allowClear
            style={{ width: 120 }}
            options={dictOptions('urgency_level')}
            onChange={(v: UrgencyLevel | undefined) => applyFilter({ urgencyLevel: v })}
          />
          <Select
            placeholder="督办状态"
            allowClear
            style={{ width: 150 }}
            options={dictOptions('supervision_status')}
            onChange={(v: SupervisionStatus | undefined) => applyFilter({ supervisionStatus: v })}
          />
          <Select
            placeholder="来源状态"
            allowClear
            style={{ width: 120 }}
            options={dictOptions('source_event_status')}
            onChange={(v: SourceEventStatus | undefined) => applyFilter({ sourceEventStatus: v })}
          />
          {/*
            超期是**时效**维度（M11 的 complaint.overtime_flag），与「来源状态」正交：
            同一批 completed 里可能既有超期也有未超期，所以两个下拉可以叠加使用。
            allowClear（不传 overtime）= 全部；三档标签与筛选口径一一对应，见 OvertimeFilter。
          */}
          <Select
            placeholder="超期时效"
            allowClear
            style={{ width: 130 }}
            options={[
              { value: '1', label: '超期' },
              { value: '0', label: '未超期' },
              { value: 'none', label: '无时效信息' },
            ]}
            onChange={(v: OvertimeFilter | undefined) => applyFilter({ overtime: v })}
          />
          <Select
            placeholder="是否敏感"
            allowClear
            style={{ width: 110 }}
            options={[
              { value: 1, label: '是' },
              { value: 0, label: '否' },
            ]}
            onChange={(v: 0 | 1 | undefined) => applyFilter({ isSensitive: v })}
          />
          <Select
            placeholder="纠偏状态"
            allowClear
            style={{ width: 120 }}
            options={dictOptions('correction_status')}
            onChange={(v: CorrectionStatus | undefined) => applyFilter({ correctionStatus: v })}
          />
          <Select
            placeholder="区域"
            allowClear
            style={{ width: 160 }}
            options={dictOptions('district')}
            onChange={(v: string | undefined) => applyFilter({ districtCode: v })}
          />
          <RangePicker
            placeholder={['受理时间起', '受理时间止']}
            value={range}
            onChange={(v) => {
              const next = v as [Dayjs | null, Dayjs | null] | null;
              setRange(next);
              applyFilter({ range: next });
            }}
          />
          <Tooltip title="导出与批量导入尚未实现（后端未提供接口）">
            <Button icon={<ExportOutlined />} disabled>
              导出Excel
            </Button>
          </Tooltip>
          <Tooltip title="批量导入尚未实现（后端未提供接口）">
            <Button icon={<ImportOutlined />} disabled>
              批量导入
            </Button>
          </Tooltip>
        </Space>

        <div style={{ marginBottom: 12 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            统计卡片为当前筛选条件下的全量口径（不受分页影响）。来源状态「未接入」表示宜接就办接口尚未对接（批次 G6），不代表处置进度。
            <br />
            「超期」是时效维度，只由来源同步路径派生（批次 G6／迁移 M11）；「无时效信息」= 来源没给结论，不等于「未超期」，历史存量尚未回填。
          </Typography.Text>
        </div>

        {error ? (
          <Result
            status="error"
            title="诉求列表加载失败"
            subTitle={error.message}
            extra={
              <Space>
                <Button type="primary" onClick={() => void load(params)}>
                  重试
                </Button>
                <Button onClick={() => navigate('/dashboard')}>返回大屏</Button>
              </Space>
            }
          />
        ) : (
          <Table<ComplaintListItem>
            rowKey="id"
            columns={columns}
            dataSource={data?.content ?? []}
            loading={loading}
            size="middle"
            scroll={{ x: 1810 }}
            locale={{ emptyText: <Empty description="暂无诉求数据" /> }}
            pagination={{
              current: page,
              pageSize: size,
              total: data?.total ?? 0,
              showSizeChanger: true,
              showTotal: (total) => '共 ' + total + ' 条诉求',
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

      {/* ---------- G2：匹配责任单位 ---------- */}
      <Modal
        title={assignTarget ? '匹配责任单位 - ' + assignTarget.complaintNo : '匹配责任单位'}
        open={assignTarget !== null}
        onCancel={() => {
          setAssignTarget(null);
          assignForm.resetFields();
        }}
        onOk={() => void handleAssign()}
        confirmLoading={submitting}
        okText="提交"
        width={540}
      >
        {enterpriseErrorAlert}
        <Form form={assignForm} layout="vertical">
          <Form.Item
            name="enterpriseCode"
            label="责任单位"
            rules={[{ required: true, message: '请选择责任单位' }]}
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
                  assignTarget?.enterpriseCode,
                  assignTarget?.enterpriseName
                )
              )}
              onChange={(code: string | undefined) => {
                const list = withCurrentEnterprise(
                  enterpriseOptions,
                  assignTarget?.enterpriseCode,
                  assignTarget?.enterpriseName
                );
                const hit = list.find((e) => e.enterpriseCode === code);
                assignForm.setFieldsValue({ enterpriseName: hit ? hit.enterpriseName : undefined });
              }}
            />
          </Form.Item>
          <Form.Item
            name="enterpriseName"
            label="企业名称（由所选企业自动带出）"
            rules={[{ required: true, message: '请先选择责任单位' }]}
          >
            <Input disabled placeholder="选择责任单位后自动带出" />
          </Form.Item>
          <Form.Item name="reason" label="匹配原因">
            <Input.TextArea rows={2} placeholder="可选，例如：按所属区域与业务类型匹配" />
          </Form.Item>
        </Form>
      </Modal>

      {/* ---------- G2：发起交办 ---------- */}
      <Modal
        title={dispatchTarget ? '发起交办 - ' + dispatchTarget.complaintNo : '发起交办'}
        open={dispatchTarget !== null}
        onCancel={() => {
          setDispatchTarget(null);
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
        {enterpriseErrorAlert}
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
                  dispatchTarget?.enterpriseCode,
                  dispatchTarget?.enterpriseName
                )
              )}
              onChange={(code: string | undefined) => {
                const list = withCurrentEnterprise(
                  enterpriseOptions,
                  dispatchTarget?.enterpriseCode,
                  dispatchTarget?.enterpriseName
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

      {/* ---------- G2：归库（无需交办 / 误报） ---------- */}
      <Modal
        title={
          dispositionTarget
            ? (dispositionTarget.kind === 'false_positive' ? '误报归库 - ' : '无需交办归库 - ') +
              dispositionTarget.row.complaintNo
            : '归库'
        }
        open={dispositionTarget !== null}
        onCancel={() => {
          setDispositionTarget(null);
          dispositionForm.resetFields();
        }}
        onOk={() => void handleDisposition()}
        confirmLoading={submitting}
        okText="确认归库"
        width={520}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={
            dispositionTarget?.kind === 'false_positive'
              ? '误报归库会取消该诉求的敏感标记'
              : '无需交办归库不产生交办记录'
          }
          description="两种归库都会写入留痕（操作者、时间、原因），都不产生交办、不推送企业。此操作不可撤销，如需交办请重新发起。"
        />
        <Form form={dispositionForm} layout="vertical">
          <Form.Item
            name="reason"
            label="归库原因"
            rules={[{ required: true, message: '必须填写归库原因' }]}
          >
            <Input.TextArea rows={3} placeholder="例如：经人工复核为一般咨询，无需交办" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default ComplaintList;
