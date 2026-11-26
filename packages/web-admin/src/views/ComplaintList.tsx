import { downloadCsv } from '../utils/csvExport';
import {namedLabel,sourceLabel} from '../utils/chineseDisplay';
import {useWriteAccess} from '../stores/roleAccess';
import ComplaintImportDialog from '../components/ComplaintImportDialog';
import SourceCategoryBackfillDialog from '../components/SourceCategoryBackfillDialog';
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
  InboxOutlined,
  SearchOutlined,
  SendOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import type { Dayjs } from 'dayjs';
import { listComplaints } from '../api/complaints';
import { applyDisposition } from '../api/complaintActions';
import { createDispatch } from '../api/dispatch';
import DispatchFormFields, { type DispatchFormValues } from '../components/DispatchFormFields';
import { getDictItems } from '../api/dicts';
import { listEnterpriseOptions } from '../api/enterprises';
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
  EnterpriseOption,
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
  sourceMajorCategory?: string;
  sourceMinorCategory?: string;
  /** 案件公文号（complaint.source_id）精确筛选；undefined = 不传该参数 */
  sourceId?: string;
  keyword?: string;
  businessType?: BusinessType;
  complaintType?: ComplaintType;
  urgencyLevel?: UrgencyLevel;
  supervisionStatus?: SupervisionStatus;
  sourceEventStatus?: SourceEventStatus;
  /** 超期时效筛选；undefined = 全部（不传该参数） */
  overtime?: OvertimeFilter;
  /** 满意度多值筛选（标书 1.2.3 明细核对）：satisfied/basically_satisfied/unsatisfied/no_reply */
  satisfaction?: string[];
  isSensitive?: 0 | 1;
  correctionStatus?: CorrectionStatus;
  districtCode?: string;
  range?: [Dayjs | null, Dayjs | null] | null;
}

/** 仅用于 Tag 配色；文案一律取服务端 *Name 字段。 */
const BUSINESS_COLOR: Record<string, string> = { water: 'blue', gas: 'orange', lpg: 'purple' };
const STATUS_COLOR: Record<string,string> = { pending: 'default', accepted: 'cyan', processing: 'blue', completed: 'green', closed: 'green', archived: 'default' };
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
  const createAccess=useWriteAccess('dispatch.create');
  const dispositionAccess=useWriteAccess('complaint.disposition');
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
      sourceId: filters.sourceId,
      districtCode: filters.districtCode,
      sourceMajorCategory: filters.sourceMajorCategory,
      sourceMinorCategory: filters.sourceMinorCategory,
      businessType: filters.businessType,
      complaintType: filters.complaintType,
      urgencyLevel: filters.urgencyLevel,
      supervisionStatus: filters.supervisionStatus,
      sourceEventStatus: filters.sourceEventStatus,
      overtime: filters.overtime,
      satisfaction: filters.satisfaction,
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

  /* ---------- G2：发起交办 / 不交办处理（匹配单位已收敛进纠偏入口，见 AddressCorrection） ---------- */
  const [dispatchTarget, setDispatchTarget] = useState<ComplaintListItem | null>(null);
  const [dispositionTarget, setDispositionTarget] = useState<{
    row: ComplaintListItem;
    kind: DispositionKind;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [dispatchForm] = Form.useForm<DispatchFormValues>();
  const [dispositionForm] = Form.useForm<{ reason: string }>();

  /* ---------- 企业主数据：发起交办时的企业选择 ---------- */
  // 企业清单来自服务端 GET /enterprises。这里**不做本地兜底**：
  // 手抄 enterprise_code 一旦与登记值不一致，后续交办就匹配不到同一主体。
  const [enterpriseOptions, setEnterpriseOptions] = useState<EnterpriseOption[]>([]);
  const [enterpriseLoading, setEnterpriseLoading] = useState(false);
  const [enterpriseError, setEnterpriseError] = useState<string | null>(null);
  const enterpriseSearchTimer = useRef<number | null>(null);
  const enterpriseFetchSeq = useRef(0);

  const fetchEnterprises = useCallback(async (keyword?: string) => {
    const seq = ++enterpriseFetchSeq.current;
    setEnterpriseLoading(true);
    try {
      const res = await listEnterpriseOptions({
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
    (list: EnterpriseOption[]) =>
      list.map((e) => ({
        value: e.enterpriseCode,
        label:
          e.enterpriseName +
          '（' + e.enterpriseCode + '）' +
          (e.businessType ? ' · ' + e.businessType : ''),
      })),
    []
  );

  /**
   * 服务端结果里若没有该诉求已登记的企业，把它补在首位以便回显。
   * 注意这不是「硬编码企业清单」：值来自这条诉求自身已登记的责任单位，不是前端常量。
   */
  const withCurrentEnterprise = useCallback(
    (list: EnterpriseOption[], code?: string | null, name?: string | null): EnterpriseOption[] => {
      if (!code || list.some((e) => e.enterpriseCode === code)) return list;
      const current: EnterpriseOption = {
        enterpriseCode: code,
        enterpriseName: name ?? code,
        businessType: '',
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
      description="请重试后选择企业。"
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
            sourceStateError
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

    return sourceState.misconfigured ? <Alert type="warning" showIcon message="来源数据暂不可同步，请联系管理员。" style={{marginBottom:16}}/> : null;
  })();

  const reload = useCallback(() => {
    void load(params);
  }, [load, params]);

  const handleCreateDispatch = useCallback(async () => {
    if (!dispatchTarget) return;
    let values: DispatchFormValues;
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
        requirement: values.requirement.trim(),
        reason: values.reason?.trim() || undefined,
        // 契约要求带时区偏移的 ISO-8601，例如 2026-09-20T18:00:00+08:00
        deadline: values.deadline.format('YYYY-MM-DDTHH:mm:ssZ'),
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
        target.kind === 'false_positive' ? '已按标记误报' : '已按无需交办'
      );
      setDispositionTarget(null);
      dispositionForm.resetFields();
      reload();
    } catch (err) {
      message.error('不交办处理失败：' + ((err as ApiError)?.message ?? '未知错误'));
    } finally {
      setSubmitting(false);
    }
  }, [dispositionTarget, dispositionForm, reload]);

  /* ---------- 列（百分比宽度，禁止横向滚动） ---------- */
  const columns: ColumnsType<ComplaintListItem> = useMemo(
    () => [
      {
        title: '诉求编号',
        dataIndex: 'complaintNo',
        width: '8%',
        render: (v: string, r) => <a onClick={() => navigate('/complaints/' + r.id)}>{v}</a>,
      },
      {
        // 案件公文号 = complaint.source_id（来源系统流水号），标书 1.1.1 要求的列表构成项
        title: '案件公文号',
        dataIndex: 'sourceId',
        width: '7%',
        ellipsis: true,
        render: (v: string | null) =>
          v ? <Tooltip title={v}>{v}</Tooltip> : DASH,
      },
      {
        title: '标题',
        dataIndex: 'title',
        width: '13%',
        ellipsis: true,
        render: (t: string, r) => (
          <>
            {r.isSensitive && (
              <Tag color="red" style={{ marginRight: 4 }}>敏感</Tag>
            )}
            {r.repeatFlag && (
              <Tooltip title={r.repeatReason ?? '同一市民同内容重复来电'}>
                <Tag color="volcano" style={{ marginRight: 4 }}>重复来电</Tag>
              </Tooltip>
            )}
            <Tooltip title={t}>{t}</Tooltip>
          </>
        ),
      },
      {
        title: '分类',
        width: '12%',
        render: (_: unknown, r) => (
          <Space size={2} wrap>
            <Tag color={BUSINESS_COLOR[r.businessTypeCode] ?? 'default'}>{namedLabel(r.businessTypeCode, r.businessTypeName, 'business_type')}</Tag>
            <Tag>{namedLabel(r.complaintTypeCode, r.complaintTypeName, 'complaint_type')}</Tag>
            <Tag color={URGENCY_COLOR[r.urgencyLevelCode] ?? 'default'}>{r.urgencyLevelName}</Tag>
          </Space>
        ),
      },
      {
        title: '诉求状态',
        dataIndex: 'statusCode',
        width: '6%',
        render: (_: unknown, r) => (
          <Tag color={STATUS_COLOR[r.statusCode] ?? 'default'}>
            {namedLabel(r.statusCode, r.statusName, 'status')}
          </Tag>
        ),
      },
      {
        title: '来源',
        dataIndex: 'sourceChannel',
        width: '6%',
        ellipsis: true,
        render: (v: string | null) => (
          <Tooltip title={sourceLabel(v, 'channel')}>{sourceLabel(v, 'channel')}</Tooltip>
        ),
      },
      {
        // 满意度（标书 1.2.3）：来源满意度标准码的原文；未评价显示「未评价」而不是空白
        title: '满意度',
        width: '8%',
        render: (_: unknown, r) => {
          const code = r.satisfactionCode ?? null;
          const text = r.satisfactionText ?? null;
          if (!code && !text) return <span style={{ color: '#bfbfbf' }}>未评价</span>;
          const color = code === 'unsatisfied' ? 'red' : code === 'satisfied' ? 'green' : code === 'basically_satisfied' ? 'blue' : 'default';
          return <Tag color={color}>{text ?? code}</Tag>;
        },
      },
      {
        title: '来源状态与时效',
        width: '11%',
        render: (_: unknown, r) => {
          const key = r.overtimeFlag === 1 ? '1' : r.overtimeFlag === 0 ? '0' : 'none';
          return (
            <div style={{ overflowWrap: 'anywhere' }}>
              <div>事件：{r.sourceEventStatusRaw ?? <span title="来源未提供">{DASH}</span>}</div>
              <div>督办：{r.sourceSupervisionStatusRaw ?? <span title="来源未提供">{DASH}</span>}</div>
              <Tooltip title={key === 'none' ? '来源未提供可核实的超期时效信息' : '来源超期时效'}>
                <Tag color={OVERTIME_COLOR[key]}>{r.overtimeFlagName}</Tag>
              </Tooltip>
            </div>
          );
        },
      },
      {
        title: '平台交办状态',
        width: '9%',
        render: (_: unknown, r) => (
          <Tag color={SUPERVISION_COLOR[r.supervisionStatusCode] ?? 'default'} style={{whiteSpace:'normal'}}>
            {namedLabel(r.supervisionStatusCode, r.supervisionStatusName, 'supervision_status')}
          </Tag>
        ),
      },
      {
        title: '区域',
        dataIndex: 'districtName',
        width: '5%',
        render: (v: string | null) => v ?? DASH,
      },
      {
        title: '责任企业',
        dataIndex: 'enterpriseName',
        width: '8%',
        ellipsis: true,
        render: (v: string | null) =>
          v ? <Tooltip title={v}>{v}</Tooltip> : <span style={{ color: '#faad14' }}>未匹配</span>,
      },
      {
        // 来源案件主/二级类型**原值**（服务端 sourceMajorCategoryName / sourceMinorCategoryName）。
        // 标书 1.1.1 要求列表依据「案件类型名」形成，这与平台字典的「分类」列是两套口径，故单列并存。
        title: '来源类型',
        width: '8%',
        ellipsis: true,
        render: (_: unknown, r) => {
          const text = [r.sourceMajorCategoryName, r.sourceMinorCategoryName]
            .filter((v): v is string => typeof v === 'string' && v !== '')
            .join(' / ');
          return text ? <Tooltip title={text}>{text}</Tooltip> : DASH;
        },
      },
      {
        // 术语对齐标书 1.1.1：列名「录入时间」。口径 = 来源受理时间优先，缺失回退平台接收时间，
        // 与后端 BUSINESS_TIME = coalesce(source_reported_at, received_at) 完全一致，底层口径未改。
        title: (
          <Tooltip title="录入时间：来源受理时间优先，来源未提供时回退平台接收时间">
            <span>录入时间</span>
          </Tooltip>
        ),
        dataIndex: 'sourceReportedAt',
        width: '7%',
        render: (v: string | null, r) => {
          const at = v ?? r.receivedAt;
          return at ? <Tooltip title={fmtDateTime(at)}>{fmtDateTime(at).slice(5, 16)}</Tooltip> : <span style={{ color: '#bfbfbf' }}>—</span>;
        },
      },
      {
        title: '操作',
        width: '10%',
        render: (_: unknown, r) => {
          const closed = r.statusCode === 'completed' || r.statusCode === 'closed' || r.closedInSystem;
          return (
          <Space size={0} wrap>
            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => navigate('/complaints/' + r.id)}>详情</Button>
            {r.activeDispatchId ? (
              <Button type="link" size="small" icon={<SendOutlined />} onClick={() => navigate('/dispatch?assignmentId=' + encodeURIComponent(r.activeDispatchId ?? ''))}>查看交办</Button>
            ) : !closed ? (
              <Button
                type="link"
                size="small"
                icon={<SendOutlined />}
                disabled={!createAccess.can}
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
              >交办</Button>
            ) : null}
            {!closed && (r.activeDispatchId ? (
              <Tooltip title="该诉求已有进行中交办，请先到「敏感交办」受控撤销后再不交办处理">
                <span><Button type="link" size="small" icon={<InboxOutlined />} disabled>不交办处理</Button></span>
              </Tooltip>
            ) : (
              <Dropdown
                menu={{
                  items: [
                    { key: 'no_dispatch_needed', label: '无需交办' },
                    { key: 'false_positive', label: '标记误报' },
                  ],
                  onClick: ({ key }) => {
                    dispositionForm.resetFields();
                    setDispositionTarget({ row: r, kind: key as DispositionKind });
                  },
                }}
              >
                <Button type="link" size="small" icon={<InboxOutlined />} disabled={!dispositionAccess.can}>不交办处理</Button>
              </Dropdown>
            ))}
          </Space>
          );
        },
      },
    ],
    [navigate, dispatchForm, dispositionForm, clearEnterpriseError, fetchEnterprises,createAccess.can,dispositionAccess.can]
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
          description="部分筛选条件暂不可用，请稍后重试。"
        />
      )}

      {sourceStatusAlert}

      <Row gutter={[12, 12]} style={{ marginBottom: 20 }}>
        <Col xs={12} md={8} xl={4}>
          <Card size="small">
            <Statistic title="总诉求" value={stats ? stats.total : '—'} loading={firstLoading} prefix={<FileTextOutlined />} />
          </Card>
        </Col>
        <Col xs={12} md={8} xl={4}>
          <Card size="small">
            <Statistic title="未交办" value={stats ? stats.notDispatchedCount : '—'} loading={firstLoading} />
          </Card>
        </Col>
        <Col xs={12} md={8} xl={4}>
          <Card size="small">
            <Statistic title="待匹配" value={stats ? stats.pendingMatchCount : '—'} loading={firstLoading} valueStyle={{ color: '#faad14' }} />
          </Card>
        </Col>
        <Col xs={12} md={8} xl={4}>
          <Card size="small">
            <Statistic title="已交办" value={stats ? stats.activeDispatchCount : '—'} loading={firstLoading} prefix={<ClockCircleOutlined />} valueStyle={{ color: '#1677ff' }} />
          </Card>
        </Col>
        <Col xs={12} md={8} xl={4}>
          <Card size="small">
            <Statistic title="敏感诉求" value={stats ? stats.sensitiveCount : '—'} loading={firstLoading} prefix={<WarningOutlined />} valueStyle={{ color: '#ff4d4f' }} />
          </Card>
        </Col>
        <Col xs={12} md={8} xl={4}>
          <Card size="small">
            <Statistic title="本系统办结" value={stats ? stats.closedInSystemCount : '—'} loading={firstLoading} prefix={<CheckCircleOutlined />} valueStyle={{ color: '#52c41a' }} />
          </Card>
        </Col>
      </Row>

      <Card>
        <Space className="filter-bar" wrap>
          <Input.Search aria-label="来源案件主类型" placeholder="来源案件主类型（原值精确查询）" allowClear maxLength={128} style={{width:250}} onSearch={value=>applyFilter({sourceMajorCategory:value.trim()||undefined})} onChange={event=>{if(!event.target.value)applyFilter({sourceMajorCategory:undefined});}}/>
          <Input.Search aria-label="来源案件二级类型" placeholder="来源案件二级类型（原值精确查询）" allowClear maxLength={128} style={{width:250}} onSearch={value=>applyFilter({sourceMinorCategory:value.trim()||undefined})} onChange={event=>{if(!event.target.value)applyFilter({sourceMinorCategory:undefined});}}/>
          {/* 案件公文号精确筛选（标书 1.1.1）：独立于关键词模糊搜索，服务端按 source_id 等值匹配 */}
          <Input.Search
            aria-label="案件公文号精确筛选"
            placeholder="案件公文号（精确）"
            allowClear
            maxLength={128}
            style={{ width: 220 }}
            onSearch={(value) => applyFilter({ sourceId: value.trim() === '' ? undefined : value.trim() })}
            onChange={(event) => {
              if (!event.target.value) applyFilter({ sourceId: undefined });
            }}
          />
          <Input.Search
            placeholder="搜索编号/来源公文号/标题/内容/地址"
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
            placeholder="平台交办状态"
            allowClear
            style={{ width: 150 }}
            options={dictOptions('supervision_status')}
            onChange={(v: SupervisionStatus | undefined) => applyFilter({ supervisionStatus: v })}
          />
          {/*
            超期是**时效**维度（M11 的 complaint.overtime_flag），与「来源状态」正交：
            同一批 completed 里可能既有超期也有未超期，所以两个下拉可以叠加使用。
            allowClear（不传 overtime）= 全部；三档标签与筛选口径一一对应，见 OvertimeFilter。
          */}
          {/* 满意度筛选（标书 1.2.3）：值=来源满意度标准码，可多选 */}
          <Select
            mode="multiple"
            placeholder="满意度"
            allowClear
            maxTagCount="responsive"
            style={{ minWidth: 150 }}
            options={[
              { value: 'satisfied', label: '满意' },
              { value: 'basically_satisfied', label: '基本满意' },
              { value: 'unsatisfied', label: '不满意' },
              { value: 'no_reply', label: '暂无回复结果' },
            ]}
            onChange={(v: string[]) => applyFilter({ satisfaction: v.length ? v : undefined })}
          />
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
          {/* 术语对齐标书 1.1.1：录入时间（= 来源受理时间优先，缺失回退接收时间；后端 BUSINESS_TIME 口径未改） */}
          <RangePicker
            placeholder={['录入时间起', '录入时间止']}
            value={range}
            onChange={(v) => {
              const next = v as [Dayjs | null, Dayjs | null] | null;
              setRange(next);
              applyFilter({ range: next });
            }}
          />
          <Tooltip title="导出当前页已加载的诉求，可用 Excel 打开">
            <Button icon={<ExportOutlined />} disabled={loading || !!error || !data?.content.length}
              onClick={() => downloadCsv([
                ['诉求编号','案件公文号','诉求标题','业务类型','诉求类别','诉求状态','所属区县','交办单位','敏感诉求','纠偏状态','来源类型','录入时间'],
                ...(data?.content ?? []).map(row => [row.complaintNo,row.sourceId,row.title,row.businessTypeName,row.complaintTypeName,row.statusName,
                  row.districtName,row.enterpriseName,row.isSensitive?'是':'否',row.correctionStatusName,
                  [row.sourceMajorCategoryName,row.sourceMinorCategoryName].filter(Boolean).join('/'),
                  row.sourceReportedAt ?? row.receivedAt])
              ], '诉求列表-本页.csv')}>导出本页</Button>
          </Tooltip>
          <ComplaintImportDialog onImported={reload}/>
          <SourceCategoryBackfillDialog onApplied={reload}/>
        </Space>



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
            tableLayout="fixed"
            size="small"
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

      {/* 匹配责任单位弹窗已下线（2026-09-20 裁定：收敛进纠偏入口，见 AddressCorrection） */}

      {/* ---------- G2：发起交办 ---------- */}
      <Modal
        title={dispatchTarget ? '发起交办 - ' + dispatchTarget.complaintNo : '发起交办'}
        open={dispatchTarget !== null}
        onCancel={() => {
          setDispatchTarget(null);
          dispatchForm.resetFields();
        }}
        okButtonProps={{disabled:!createAccess.can}} onOk={() => void handleCreateDispatch()}
        confirmLoading={submitting}
        okText="创建交办"
        width={560}
      >

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
          <DispatchFormFields />
          <Form.Item name="reason" label="交办原因">
            <Input.TextArea rows={2} placeholder="可选" />
          </Form.Item>
        </Form>
      </Modal>

      {/* ---------- G2：不交办处理（无需交办 / 误报） ---------- */}
      <Modal
        title={
          dispositionTarget
            ? (dispositionTarget.kind === 'false_positive' ? '标记误报 - ' : '无需交办 - ') +
              dispositionTarget.row.complaintNo
            : '不交办处理'
        }
        open={dispositionTarget !== null}
        onCancel={() => {
          setDispositionTarget(null);
          dispositionForm.resetFields();
        }}
        okButtonProps={{disabled:!dispositionAccess.can}} onOk={() => void handleDisposition()}
        confirmLoading={submitting}
        okText="确认不交办处理"
        width={520}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={
            dispositionTarget?.kind === 'false_positive'
              ? '标记误报会取消该诉求的敏感标记'
              : '无需交办不产生交办记录'
          }
          description="处理后仍保留在诉求总账，不会直接进入分析库，也不会推送企业。系统会记录处理人、时间和原因；后续需要交办时可重新发起。"
        />
        <Form form={dispositionForm} layout="vertical">
          <Form.Item
            name="reason"
            label="不交办处理原因"
            rules={[{ required: true, message: '必须填写不交办处理原因' }]}
          >
            <Input.TextArea rows={3} placeholder="例如：经人工复核为一般咨询，无需交办" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default ComplaintList;
