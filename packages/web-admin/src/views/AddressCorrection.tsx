import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Result,
  Segmented,
  Space,
  Table,
  Tag,
  Tooltip,
  message,
} from 'antd';
import {
  CheckOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';
import {
  confirmCorrection,
  generateCorrectionBatch,
  generateCorrections,
  listComplaintCorrections,
} from '../api/corrections';
import { listPendingCorrectionComplaints } from '../api/corrections';
import type { DispatchedFilter, PendingComplaintSummary } from '../api/corrections';
import { listEnterprises } from '../api/enterprises';
import { getComplaint } from '../api/complaints';
import type { AddressCandidateView, ComplaintDetail, CorrectionItem, EnterpriseListItem } from '../types/api';
import TiandituLocationPicker from '../components/TiandituLocationPicker';
import LocationClues from '../components/LocationClues';
import InlineCorrectionField from '../components/InlineCorrectionField';
import { useWriteAccess, WriteGate } from '../stores/roleAccess';
import { useAdminAccess } from '../stores/roleAccess';
import { previewAddressBackfill, executeAddressBackfill } from '../api/addressCandidates';
import type { AddressBackfillPreview, AddressBackfillSummary } from '../api/addressCandidates';

/**
 * 整体纠偏工作台（真实接口驱动）。
 *
 * 口径（业主 2026-09-20 裁定，纠偏与交办是**并行两条轴**）：
 *  - 纠偏是**数据质量轴**，覆盖**所有**诉求，与是否交办、是否审批通过无关；
 *    交办针对"原件"派单、不改诉求内容。旧口径"只有走过督办链路才进纠偏"已作废。
 *  - 每一项仍按字段逐项生成（企业名称/归属、地址、分类、坐标、摘要、企业处置结果）。
 *  - 「企业名称/归属」现在就是**确认责任单位**的唯一入口（总账的「匹配单位」按钮已下线）：
 *    取值必须从企业主数据里选，后端成对写回 enterprise_code + enterprise_name，编码未登记直接拒绝。
 *  - 无法确认的项留在待纠偏，**不假装完成**；判定不成立时可「无需纠偏」并留依据。
 *  - 纠偏闭环仍是进入分析库的前置条件之一；分析库口径本批未变（未交办 / 误报归库不纳入分析），
 *    所以"队列里有未交办的件、但它们不会进分析库"是正常状态。
 *  - 存量 / 新入站诉求靠「补齐全部诉求纠偏待办」这个幂等入口收敛进队列，页面不造任何数据。
 */

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function errCode(e: unknown): string | number | undefined {
  return (e as { code?: string | number } | null)?.code;
}

const STATUS_TAG: Record<string, { color: string; text: string }> = {
  pending: { color: 'warning', text: '待纠偏' },
  confirmed: { color: 'success', text: '已确认' },
  rejected: { color: 'default', text: '无需纠偏' },
};

const DASH = <span style={{ color: '#bfbfbf' }}>—</span>;

export const AddressCandidateCorrection: React.FC<{
  sourceAddress: string | null;
  candidate: AddressCandidateView | null;
  pending: boolean;
  locationConflict?: boolean;
  onUse: () => void;
}> = ({ sourceAddress, candidate, pending, locationConflict = false, onUse }) => (
  <Descriptions size="small" column={1} bordered>
    <Descriptions.Item label="来源地址">{sourceAddress || '—'}</Descriptions.Item>
    <Descriptions.Item label="机器地址候选">
      {candidate ? <>
        <Tag color="warning">待核实</Tag> {candidate.value}
        <div>提取来源：{candidate.sourceField === 'title' ? '标题' : '正文'}；规则：{candidate.extractorVersion}</div>
        <div>证据：{candidate.evidence}</div>
        {pending && !locationConflict && <Button size="small" onClick={onUse}>填入待核实地址</Button>}
        {locationConflict && <Tag color="warning">位置冲突，仅供查看</Tag>}
      </> : '无候选'}
    </Descriptions.Item>
  </Descriptions>
);

const POSITION_FIELDS = ['address', 'location_lng', 'location_lat'] as const;

/** 交办轴筛选（两条轴并行，页面要能分别看） */
const DISPATCHED_OPTIONS: Array<{ label: string; value: DispatchedFilter | 'all' }> = [
  { label: '全部诉求', value: 'all' },
  { label: '已交办', value: 'dispatched' },
  { label: '未交办', value: 'undispatched' },
];

interface AddressCandidateBackfillControlsProps {
  adminAccess?: { can: boolean; tip: string };
  previewApi?: () => Promise<AddressBackfillPreview>;
  executeApi?: () => Promise<AddressBackfillSummary>;
}

export function addressBackfillOutcome(summary: Pick<AddressBackfillSummary, 'total' | 'failed' | 'errors'>): 'success' | 'partial' | 'failed' {
  if (summary.failed === 0) return 'success';
  if (summary.total === 0 || summary.errors.row + summary.errors.audit >= summary.total) return 'failed';
  return 'partial';
}

export function positionItemsMatchSelection(itemsLoading: boolean, itemsComplaintId: string | null, selectedComplaintId: string | null): boolean {
  return !itemsLoading && selectedComplaintId !== null && itemsComplaintId === selectedComplaintId;
}

export const AddressCandidateBackfillControls: React.FC<AddressCandidateBackfillControlsProps> = ({
  adminAccess: accessOverride, previewApi = previewAddressBackfill, executeApi = executeAddressBackfill,
}) => {
  const hookAccess = useAdminAccess();
  const adminAccess = accessOverride ?? hookAccess;
  const [preview, setPreview] = useState<AddressBackfillPreview | null>(null);
  const [execution, setExecution] = useState<AddressBackfillSummary | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [executeLoading, setExecuteLoading] = useState(false);

  const doPreview = async () => {
    setPreviewLoading(true);
    setPreview(null);
    setExecution(null);
    try { setPreview(await previewApi()); }
    catch (err) { setPreview(null); message.error('预览存量地址候选失败：' + errText(err)); }
    finally { setPreviewLoading(false); }
  };

  const doExecute = () => {
    if (!preview || !adminAccess.can || executeLoading) return;
    const expectedAddressChanges = preview.created + preview.updated + preview.removed;
    const expectedClueChanges = preview.clueCreated + preview.clueUpdated + preview.clueRemoved;
    Modal.confirm({
      title: '确认执行存量地址候选补提取？',
      content: '预览范围共 ' + preview.total + ' 条；地址候选预计写入或移除 ' + expectedAddressChanges + ' 条，位置线索预计新增/更新/移除 ' + expectedClueChanges + ' 条，位置冲突 ' + preview.conflicts + ' 条。执行后仅更新机器地址候选和位置线索，并记录操作审计。',
      okText: '确认执行', cancelText: '取消',
      onOk: async () => {
        setExecuteLoading(true);
        try {
          const result = await executeApi();
          setExecution(result);
          const outcome = addressBackfillOutcome(result);
          if (outcome === 'success') message.success('存量地址候选处理完成');
          else if (outcome === 'failed') message.error('存量地址候选处理失败，共 ' + result.failed + ' 项');
          else message.warning('存量地址候选部分完成，失败 ' + result.failed + ' 项');
        } catch (err) { message.error('执行存量地址候选失败：' + errText(err)); }
        finally { setExecuteLoading(false); }
      },
    });
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space wrap>
        <Tooltip title={!adminAccess.can ? adminAccess.tip : undefined}>
          <Button disabled={!adminAccess.can} loading={previewLoading} onClick={() => void doPreview()}>预览存量地址候选</Button>
        </Tooltip>
        <Tooltip title={!preview ? '请先完成预览' : !adminAccess.can ? adminAccess.tip : undefined}>
          <Button type="primary" danger disabled={!adminAccess.can || !preview || executeLoading} loading={executeLoading}
            onClick={doExecute}>确认执行存量补提取</Button>
        </Tooltip>
        {preview && <Descriptions size="small" column={4} title="预览结果">
          <Descriptions.Item label="总数">{preview.total}</Descriptions.Item>
          <Descriptions.Item label="可提取">{preview.extractable}</Descriptions.Item>
          <Descriptions.Item label="无候选">{preview.noCandidate}</Descriptions.Item>
          <Descriptions.Item label="预计写入/移除">{preview.created + preview.updated + preview.removed}</Descriptions.Item>
          <Descriptions.Item label="乡镇线索">{preview.townshipClues}</Descriptions.Item>
          <Descriptions.Item label="村社区小区线索">{preview.settlementClues}</Descriptions.Item>
          <Descriptions.Item label="位置冲突">{preview.conflicts}</Descriptions.Item>
          <Descriptions.Item label="上级待核实">{preview.unresolved}</Descriptions.Item>
          <Descriptions.Item label="线索新增">{preview.clueCreated}</Descriptions.Item>
          <Descriptions.Item label="线索更新">{preview.clueUpdated}</Descriptions.Item>
          <Descriptions.Item label="线索未变">{preview.clueUnchanged}</Descriptions.Item>
          <Descriptions.Item label="线索移除">{preview.clueRemoved}</Descriptions.Item>
          <Descriptions.Item label="版本重算">{preview.recomputedForVersion}</Descriptions.Item>
        </Descriptions>}
      </Space>
      {preview?.samples.map((sample) => <span key={sample.item}>示例 {sample.item}：{sample.category}；{sample.action}；{sample.value}</span>)}
      {execution && <Alert type={addressBackfillOutcome(execution) === 'success' ? 'success' : addressBackfillOutcome(execution) === 'failed' ? 'error' : 'warning'} showIcon message="执行结果" description={'新增 ' + execution.created + '，更新 ' + execution.updated + '，未变 ' + execution.unchanged + '，移除 ' + execution.removed + '，失败 ' + execution.failed + '（扫描 ' + execution.errors.scan + '，单条处理 ' + execution.errors.row + '，审计 ' + execution.errors.audit + '）'} />}
    </Space>
  );
};

const AddressCorrection: React.FC = () => {
  const [searchParams] = useSearchParams();
  const deepLinkHandledRef = useRef<string | null>(null);
  // ---- 左侧队列 ----
  const [queue, setQueue] = useState<PendingComplaintSummary[]>([]);
  const [queueTotal, setQueueTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [firstLoaded, setFirstLoaded] = useState(false);
  const seqRef = useRef(0);
  /** 交办轴筛选：all=全部（两条轴一起看）、dispatched=只看交办过、undispatched=只看没交办过 */
  const [dispatched, setDispatched] = useState<DispatchedFilter | 'all'>('all');

  // ---- 企业主数据：确认责任单位时的下拉（值=enterprise_code） ----
  // 不做本地兜底清单：手抄的编码与登记值不一致时，后端会直接拒绝写入，页面不该假装能填。
  const [enterpriseOptions, setEnterpriseOptions] = useState<EnterpriseListItem[]>([]);
  const [enterpriseLoading, setEnterpriseLoading] = useState(false);
  const [enterpriseError, setEnterpriseError] = useState<string | null>(null);
  const enterpriseSeqRef = useRef(0);

  // ---- 批量补挂 ----
  const [batching, setBatching] = useState(false);

  // ---- 右侧闭环面板 ----
  const [selectedComplaintId, setSelectedComplaintId] = useState<string | null>(null);
  const [selectedComplaintInfo, setSelectedComplaintInfo] = useState<{ complaintNo: string; title: string } | null>(null);
  const [selectedComplaintDetail, setSelectedComplaintDetail] = useState<ComplaintDetail | null>(null);
  const summarySeqRef = useRef(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [items, setItems] = useState<CorrectionItem[]>([]);
  const [itemsComplaintId, setItemsComplaintId] = useState<string | null>(null);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [selectedInfoError, setSelectedInfoError] = useState<string | null>(null);
  const itemsSeqRef = useRef(0);

  // ---- 生成纠偏待办 ----
  const [genId, setGenId] = useState('');
  const [generating, setGenerating] = useState(false);

  // ---- 确认 / 无需纠偏 ----
  const [verifyTarget, setVerifyTarget] = useState<CorrectionItem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [savingItemId, setSavingItemId] = useState<string | null>(null);
  const [verifyForm] = Form.useForm<{ basis: string }>();
  const [positionForm] = Form.useForm();
  const addressDraft = Form.useWatch('address', positionForm) as string | undefined;
  const writeAccess = useWriteAccess();
  const adminAccess = useAdminAccess();
  const [positionModalOpen, setPositionModalOpen] = useState(false);
  const [positionResult, setPositionResult] = useState<Array<{ label: string; ok: boolean; detail: string }>>([]);

  const fetchEnterprises = useCallback(async (keyword?: string) => {
    const seq = ++enterpriseSeqRef.current;
    setEnterpriseLoading(true);
    try {
      const res = await listEnterprises({
        keyword: keyword && keyword.trim() !== '' ? keyword.trim() : undefined,
        size: 100,
      });
      if (seq !== enterpriseSeqRef.current) return; // 丢弃过期响应
      setEnterpriseOptions(res.content);
      setEnterpriseError(null);
    } catch (err) {
      if (seq !== enterpriseSeqRef.current) return;
      setEnterpriseOptions([]); // 失败就是空，绝不回落到本地示例企业
      setEnterpriseError(errText(err));
    } finally {
      if (seq === enterpriseSeqRef.current) setEnterpriseLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchEnterprises();
  }, [fetchEnterprises]);

  const loadQueue = useCallback(
    async (p: number, s: number, d: DispatchedFilter | 'all') => {
      const seq = ++seqRef.current;
      setLoading(true);
      setLoadError(null);
      try {
        const res = await listPendingCorrectionComplaints({
          page: p,
          size: s,
          dispatched: d === 'all' ? undefined : d,
        });
        if (seq !== seqRef.current) return;
        setQueue(res.content);
        setQueueTotal(res.total);
      } catch (err) {
        if (seq !== seqRef.current) return;
        setLoadError(errText(err));
        setQueue([]);
        setQueueTotal(0);
      } finally {
        if (seq === seqRef.current) {
          setLoading(false);
          setFirstLoaded(true);
        }
      }
    },
    []
  );

  useEffect(() => {
    void loadQueue(page, size, dispatched);
  }, [loadQueue, page, size, dispatched]);

  /** 换筛选口径时回到第 1 页，否则可能停在当前口径下不存在的页码 */
  const applyDispatchedFilter = useCallback((next: DispatchedFilter | 'all') => {
    setDispatched(next);
    setPage(1);
  }, []);

  const loadItems = useCallback(async (complaintId: string) => {
    const seq = ++itemsSeqRef.current;
    setItems([]);
    setItemsComplaintId(complaintId);
    setItemsLoading(true);
    setItemsError(null);
    try {
      const res = await listComplaintCorrections(complaintId);
      if (seq !== itemsSeqRef.current) return;
      setItems(res);
    } catch (err) {
      if (seq !== itemsSeqRef.current) return;
      setItemsError(errText(err));
      setItems([]);
    } finally {
      if (seq === itemsSeqRef.current) setItemsLoading(false);
    }
  }, []);

  /** 选中某诉求：加载它的全部纠偏项 */
  const selectComplaint = useCallback(
    (complaintId: string, summary?: PendingComplaintSummary) => {
      const summarySeq = ++summarySeqRef.current;
      setSelectedComplaintId(complaintId);
      setDrawerOpen(true);
      setItems([]);
      setItemsComplaintId(null);
      setPositionModalOpen(false);
      positionForm.resetFields();
      const row = summary ?? queue.find((item) => item.complaintId === complaintId);
      setSelectedComplaintDetail(null);
      void getComplaint(complaintId).then((detail) => {
        if (summarySeq !== summarySeqRef.current) return;
        setSelectedComplaintDetail(detail);
        if (!row) setSelectedComplaintInfo({ complaintNo: detail.complaintNo, title: detail.title });
      }).catch((err) => {
        if (summarySeq !== summarySeqRef.current) return;
        if (!row) setSelectedInfoError('诉求基本信息加载失败：' + errText(err));
      });
      if (row) {
        setSelectedInfoError(null);
        setSelectedComplaintInfo({ complaintNo: row.complaintNo, title: row.title });
      } else {
        setSelectedInfoError(null);
        setSelectedComplaintInfo(null);
      }
      void loadItems(complaintId);
    },
    [loadItems, queue, positionForm]
  );

  /** 从规则命中诉求跳转时，自动定位并加载目标诉求；同一个 URL 只处理一次。 */
  const complaintFromUrl = searchParams.get('complaintId');
  useEffect(() => {
    if (!complaintFromUrl || deepLinkHandledRef.current === complaintFromUrl) return;
    deepLinkHandledRef.current = complaintFromUrl;
    setGenId(complaintFromUrl);
    selectComplaint(complaintFromUrl);
  }, [complaintFromUrl, selectComplaint]);

  /** 确认/无需纠偏之后：刷新该诉求的纠偏项与左侧队列；若已闭环则提示进入分析库 */
  const afterDecision = useCallback(
    async (complaintId: string, analysisEntered?: boolean) => {
      await loadItems(complaintId);
      await loadQueue(page, size, dispatched);
      // 「是否已进入分析库」用**后端返回的判定**（confirm/reject 响应里的 analysisEntered），
      // 不在前端靠"数还有没有 pending 项"来推断——那是猜测，不是事实。
      if (analysisEntered === true) {
        message.success('该项已处置，且该诉求纠偏已全部闭环——已进入分析库（可在「分析库」页查到）');
      } else {
        message.success('已处置该项纠偏');
      }
    },
    [loadItems, loadQueue, page, size, dispatched]
  );

  const doGenerate = async () => {
    const id = genId.trim();
    if (id === '') {
      message.warning('请先填写诉求编号或 ID');
      return;
    }
    setGenerating(true);
    try {
      const res = await generateCorrections(id);
      if (res.created) {
        message.success('已生成 ' + res.total + ' 项纠偏待办');
      } else {
        message.info('该诉求已有纠偏项（共 ' + res.total + ' 项），未重复生成');
      }
      setGenId('');
      selectComplaint(res.complaintId);
      await loadQueue(page, size, dispatched);
    } catch (err) {
      const code = errCode(err);
      if (code === 404 || code === 'NOT_FOUND') {
        message.error('未找到该诉求：' + errText(err));
      } else {
        message.error('生成失败：' + errText(err));
      }
    } finally {
      setGenerating(false);
    }
  };

  /**
   * 批量补挂（幂等）：给所有还没有纠偏清单的诉求生成待办。
   * 结果必须照实播报——uncoveredComplaints 不为 0 或 errors 非空就是没补全，
   * 这时用 warning 而不是 success，避免"点了按钮=办完了"的错觉。
   */
  const doBatchGenerate = async () => {
    setBatching(true);
    try {
      const res = await generateCorrectionBatch();
      const detail =
        '新建 ' + res.createdComplaints + ' 条诉求 / 跳过已有 ' + res.skippedComplaints +
        ' 条 / 插入 ' + res.itemsInserted + ' 项；库内存活诉求 ' + res.totalComplaints +
        ' 条，仍无清单 ' + res.uncoveredComplaints + ' 条';
      if (res.uncoveredComplaints > 0 || res.errors.length > 0) {
        message.warning('补挂未全部完成：' + detail, 8);
      } else {
        message.success('补挂完成，全部诉求已纳入纠偏口径：' + detail, 6);
      }
      await loadQueue(page, size, dispatched);
    } catch (err) {
      message.error('批量补挂失败：' + errText(err));
    } finally {
      setBatching(false);
    }
  };

  const saveInlineItem = async (item: CorrectionItem, newValue: string, basis: string) => {
    if (savingItemId !== null) return;
    try {
      setSavingItemId(item.correctionId);
      const res = await confirmCorrection(item.correctionId, {
        newValue,
        basis: basis || undefined,
      });
      await afterDecision(item.complaintId, res.analysisEntered === true);
    } catch (err) {
      message.error('保存纠偏失败：' + errText(err));
    } finally {
      setSavingItemId(null);
    }
  };

  const openVerifyOriginal = (item: CorrectionItem) => {
    setVerifyTarget(item);
    verifyForm.setFieldsValue({ basis: '' });
  };

  const submitVerifyOriginal = async () => {
    if (!verifyTarget) return;
    let values: { basis: string };
    try {
      values = await verifyForm.validateFields();
    } catch {
      return;
    }
    setSubmitting(true);
    try {
      const res = await confirmCorrection(verifyTarget.correctionId, {
        newValue: verifyTarget.oldValue ?? '',
        basis: '核验无误：' + values.basis.trim(),
      });
      const complaintId = verifyTarget.complaintId;
      setVerifyTarget(null);
      verifyForm.resetFields();
      await afterDecision(complaintId, res.analysisEntered === true);
    } catch (err) {
      message.error('核验未完成：' + errText(err));
      await loadItems(verifyTarget.complaintId);
    } finally {
      setSubmitting(false);
    }
  };

  const positionItems = POSITION_FIELDS.map((fieldName) => items.find((item) => item.fieldName === fieldName));
  const positionItemsReady = positionItemsMatchSelection(itemsLoading, itemsComplaintId, selectedComplaintId);
  const canEditPositionGroup = positionItemsReady && Boolean(selectedComplaintInfo) && positionItems.every(Boolean) && positionItems.some((item) => item?.status === 'pending');

  const openPositionGroup = () => {
    if (!canEditPositionGroup) return;
    const [address, lng, lat] = positionItems as [CorrectionItem, CorrectionItem, CorrectionItem];
    setPositionResult([]);
    positionForm.setFieldsValue({
      address: address.newValue ?? address.oldValue ?? '',
      lng: lng.newValue ?? lng.oldValue ?? '',
      lat: lat.newValue ?? lat.oldValue ?? '',
      basis: '',
    });
    setPositionModalOpen(true);
  };

  const savePositionGroup = async () => {
    let values: { address: string; lng: string; lat: string; basis?: string };
    try {
      values = await positionForm.validateFields();
    } catch {
      return;
    }
    const fields = [
      { item: positionItems[0] as CorrectionItem, value: values.address.trim() },
      { item: positionItems[1] as CorrectionItem, value: values.lng.trim() },
      { item: positionItems[2] as CorrectionItem, value: values.lat.trim() },
    ].filter(({ item }) => item.status === 'pending');
    if (fields.length === 0) return;
    if (fields.every(({ item, value }) => value === (item.oldValue ?? ''))) {
      message.info('位置组没有任何新值；如原值无误，请逐项点“核验无误”');
      return;
    }
    setSubmitting(true);
    const outcomes: Array<{ label: string; ok: boolean; detail: string }> = [];
    try {
      for (const { item, value } of fields) {
        const changed = value !== (item.oldValue ?? '');
        try {
          await confirmCorrection(item.correctionId, {
            newValue: value,
            basis: changed
              ? values.basis?.trim() || '地图选点并人工核对位置'
              : '位置组核验无误：' + (values.basis?.trim() || '操作员复核位置'),
          });
          outcomes.push({ label: item.fieldLabel ?? item.fieldName, ok: true, detail: changed ? '已保存纠偏' : '已核验原值' });
        } catch (err) {
          outcomes.push({ label: item.fieldLabel ?? item.fieldName, ok: false, detail: errText(err) });
        }
      }
      setPositionResult(outcomes);
      await loadItems(selectedComplaintId ?? fields[0].item.complaintId);
      await loadQueue(page, size, dispatched);
      setPositionModalOpen(false);
      positionForm.resetFields();
      const successCount = outcomes.filter((outcome) => outcome.ok).length;
      if (successCount === fields.length) {
        message.success('本次提交的 ' + fields.length + ' 项位置字段均已处理完成');
      } else {
        message.warning('位置组已逐项提交：成功 ' + successCount + '/' + fields.length + '，失败 ' + (fields.length - successCount) + ' 项。已刷新服务端状态，失败项仍可从位置组继续处理。', 8);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const pendingCount = items.filter((x) => x.status === 'pending').length;
  /**
   * 该诉求在**交办轴**上的状态：取自服务端给的 hasDispatch，一条诉求的各行取值相同。
   * 面板还没加载到任何项时为 null——这时候就是不知道，不能猜成"未交办"。
   */
  const selectedHasDispatch = items.length > 0 ? items[0].hasDispatch : null;

  return (
    <div>
      <h2 style={{ marginBottom: 8 }}>整体纠偏</h2>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="打开诉求后，直接在字段行填写纠偏后取值并保存；原值无误则点“核验无误”。"
      />

      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Segmented
            options={DISPATCHED_OPTIONS}
            value={dispatched}
            onChange={(v) => applyDispatchedFilter(v as DispatchedFilter | 'all')}
          />
          <Tooltip title="重新加载待纠偏队列">
            <Button icon={<ReloadOutlined />} onClick={() => void loadQueue(page, size, dispatched)}>
              刷新
            </Button>
          </Tooltip>
        </Space>
        <Collapse
          ghost
          defaultActiveKey={['maintenance']}
          style={{ marginTop: 8 }}
          items={[{
            key: 'maintenance',
            label: '维护工具',
            forceRender: true,
            children: (
              <Space direction="vertical" style={{ width: '100%' }}>
                <AddressCandidateBackfillControls adminAccess={adminAccess} />
                <Space wrap>
                <Input
                  placeholder="诉求编号或 ID（补生成纠偏项）"
                  value={genId}
                  onChange={(e) => setGenId(e.target.value)}
                  style={{ width: 300 }}
                  allowClear
                />
                <Button type="primary" icon={<ThunderboltOutlined />} loading={generating} onClick={() => void doGenerate()}>
                  生成纠偏待办
                </Button>
                <Tooltip title="只给尚无纠偏清单的诉求补挂，重复执行会跳过已有清单。">
                  <Button icon={<TeamOutlined />} loading={batching} onClick={() => void doBatchGenerate()}>
                    补齐全部诉求纠偏待办
                  </Button>
                </Tooltip>
                </Space>
              </Space>
            ),
          }]}
        />
      </Card>

      <Card title={'待纠偏诉求（共 ' + queueTotal + ' 件）'} size="small">
            {loadError ? (
              <Result
                status="error"
                title="加载待纠偏队列失败"
                subTitle={loadError}
                extra={
                  <Button type="primary" onClick={() => void loadQueue(page, size, dispatched)}>
                    重试
                  </Button>
                }
              />
            ) : (
              <Table<PendingComplaintSummary>
                rowKey="complaintId"
                size="middle"
                loading={loading}
                dataSource={queue}
                locale={{
                  emptyText: firstLoaded ? (
                    <Empty description="该口径下暂无待纠偏项；若有诉求从未生成清单，请点「补齐全部诉求纠偏待办」">
                      <Button icon={<TeamOutlined />} loading={batching} onClick={() => void doBatchGenerate()}>
                        补齐全部诉求纠偏待办
                      </Button>
                    </Empty>
                  ) : (
                    <span />
                  ),
                }}
                onRow={(record) => ({ onClick: () => selectComplaint(record.complaintId, record) })}
                pagination={{
                  current: page,
                  pageSize: size,
                  total: queueTotal,
                  showSizeChanger: true,
                  showTotal: (t) => '共 ' + t + ' 件诉求',
                  onChange: (p, s) => {
                    setPage(p);
                    setSize(s);
                  },
                }}
                columns={[
                  {
                    title: '诉求编号',
                    dataIndex: 'complaintNo',
                    width: 160,
                    render: (value: string, row: PendingComplaintSummary) => value || row.complaintId,
                  },
                  { title: '诉求内容', dataIndex: 'title', ellipsis: true },
                  {
                    // 两条轴并行的交叉状态：交办与否不影响这条件不该进纠偏队列
                    title: '待处理字段',
                    dataIndex: 'pendingCount',
                    width: 112,
                    render: (count: number) => <Tag color="warning">{count} 项待处理</Tag>,
                  },
                  {
                    title: '交办轴',
                    dataIndex: 'hasDispatch',
                    width: 100,
                    render: (v: boolean) =>
                      v ? <Tag color="processing">已交办</Tag> : <Tag>未交办</Tag>,
                  },
                  {
                    title: '操作',
                    width: 100,
                    render: (_: unknown, row: PendingComplaintSummary) => (
                      <Button type="link" onClick={() => selectComplaint(row.complaintId, row)}>打开纠偏</Button>
                    ),
                  },
                ]}
              />
            )}
      </Card>

      <Drawer
        title={
          selectedComplaintId
            ? '诉求纠偏 · ' +
              (selectedComplaintInfo?.complaintNo || selectedComplaintId)
            : '诉求纠偏'
        }
        open={drawerOpen}
        width="min(1120px, 96vw)"
        onClose={() => setDrawerOpen(false)}
        extra={selectedComplaintId ? (
          <Button size="small" onClick={() => void loadItems(selectedComplaintId)}>刷新</Button>
        ) : null}
      >
            {selectedInfoError ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message={selectedInfoError} /> : null}
            {!selectedComplaintId ? (
              <Empty description="请先从诉求列表选择一件" />
            ) : itemsError ? (
              <Result
                status="error"
                title="加载纠偏项失败"
                subTitle={itemsError}
                extra={
                  <Button type="primary" onClick={() => void loadItems(selectedComplaintId)}>
                    重试
                  </Button>
                }
              />
            ) : (
              <>
                <Descriptions size="small" column={{ xs: 1, sm: 2 }} bordered style={{ marginBottom: 12 }}>
                  <Descriptions.Item label="诉求编号">
                    {selectedComplaintInfo?.complaintNo || selectedComplaintId}
                  </Descriptions.Item>
                  <Descriptions.Item label="诉求 ID">{selectedComplaintId}</Descriptions.Item>
                  <Descriptions.Item label="诉求内容" span={2}>
                    {selectedComplaintInfo?.title || '正在读取…'}
                  </Descriptions.Item>
                  <Descriptions.Item label="交办轴">
                    {selectedHasDispatch === null ? (
                      DASH
                    ) : selectedHasDispatch ? (
                      <Tag color="processing">已交办</Tag>
                    ) : (
                      <Tag>未交办</Tag>
                    )}
                  </Descriptions.Item>
                  <Descriptions.Item label="待确认项">{pendingCount}</Descriptions.Item>
                  <Descriptions.Item label="全部项">{items.length}</Descriptions.Item>
                </Descriptions>
                <div style={{ marginBottom: 16 }}>
                  <AddressCandidateCorrection
                    sourceAddress={selectedComplaintDetail?.address ?? null}
                    candidate={selectedComplaintDetail?.addressCandidate ?? null}
                    pending={false}
                    locationConflict={selectedComplaintDetail?.locationConflict ?? false}
                    onUse={() => undefined}
                  />
                  <LocationClues clues={selectedComplaintDetail?.locationClues ?? []} conflict={selectedComplaintDetail?.locationConflict ?? false} />
                </div>

                {pendingCount === 0 && items.length > 0 && (
                  <Alert
                    type="success"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="该诉求纠偏已全部闭环"
                    description={
                      selectedHasDispatch
                        ? '全部纠偏项已确认或判定无需，且该诉求走过督办链路——满足进入分析库的条件。'
                        : '全部纠偏项已确认或判定无需；但该诉求没有交办记录，按现行分析库口径仍不纳入分析（只在总账可查）。'
                    }
                  />
                )}

                {positionItems.some(Boolean) && (
                  <Card size="small" title="位置组：地址与经纬度" style={{ marginBottom: 16 }}>
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message="地址、经度、纬度作为一组核对"
                      description="可在位置窗体输入地址搜索并选择地点，自动定位地图、回填待处理的地址与坐标；也可直接点地图。确认后再保存，搜索本身不会修改诉求。"
                    />
                    <Space wrap>
                      <WriteGate allowed={writeAccess.can && canEditPositionGroup} tip={!selectedComplaintInfo ? '正在读取诉求编号与标题' : writeAccess.tip || '位置字段需全部存在且仍有待处理项'}>
                        <Button type="primary" onClick={openPositionGroup}>打开位置组纠偏</Button>
                      </WriteGate>
                      {!canEditPositionGroup ? (
                        <span style={{ color: '#8c8c8c' }}>位置字段需完整且仍有待处理项，才能保存未完成部分。</span>
                      ) : null}
                    </Space>
                    {positionResult.length > 0 ? (
                      <div style={{ marginTop: 12 }}>
                        <Alert
                          type={positionResult.every((result) => result.ok) ? 'success' : 'warning'}
                          showIcon
                          message="位置组逐项提交结果"
                          description={
                            <Space direction="vertical" size={0}>
                              {positionResult.map((result) => (
                                <span key={result.label}>
                                  {result.ok ? '✓' : '✗'} {result.label}：{result.detail}
                                </span>
                              ))}
                            </Space>
                          }
                        />
                      </div>
                    ) : null}
                  </Card>
                )}

                <Table<CorrectionItem>
                  rowKey="correctionId"
                  size="small"
                  loading={itemsLoading}
                  dataSource={items}
                  pagination={false}
                  locale={{ emptyText: <Empty description="该诉求暂无纠偏项" /> }}
                  columns={[
                    {
                      title: '字段',
                      dataIndex: 'fieldLabel',
                      width: 96,
                      render: (v: string | null, r: CorrectionItem) => v ?? r.fieldName,
                    },
                    {
                      title: '原值 / 纠偏后取值',
                      width: 430,
                      render: (_: unknown, r: CorrectionItem) => (
                        <div style={{ lineHeight: 1.6 }}>
                          <div><b>原值：</b>{r.oldValue ?? '—'}</div>
                          {r.newValue && r.status !== 'pending' ? <div><b>确认值：</b>{r.newValue}</div> : null}
                          {r.status === 'pending' && !POSITION_FIELDS.includes(r.fieldName as typeof POSITION_FIELDS[number]) ? (
                            <div style={{ marginTop: 8 }}>
                              <InlineCorrectionField
                                item={r}
                                enterpriseOptions={enterpriseOptions}
                                enterpriseLoading={enterpriseLoading}
                                enterpriseError={enterpriseError}
                                disabled={!writeAccess.can || !selectedComplaintInfo}
                                saving={savingItemId === r.correctionId}
                                onSearchEnterprises={(keyword) => void fetchEnterprises(keyword)}
                                onSave={(value, basis) => void saveInlineItem(r, value, basis)}
                              />
                            </div>
                          ) : null}
                        </div>
                      ),
                    },
                    {
                      title: '状态',
                      dataIndex: 'status',
                      width: 92,
                      render: (v: string, r: CorrectionItem) => {
                        const m = STATUS_TAG[v] ?? { color: 'default', text: r.statusName };
                        const statusText =
                          v === 'confirmed' &&
                          r.newValue === r.oldValue &&
                          (r.basis?.startsWith('核验无误：') || r.basis?.startsWith('位置组核验无误：'))
                            ? '核验无误'
                            : v === 'confirmed' && r.newValue !== r.oldValue
                            ? '已纠偏'
                            : r.statusName || m.text;
                        return (
                          <Space direction="vertical" size={0}>
                            <Tag color={m.color}>{statusText}</Tag>
                            {r.confirmerName && (
                              <span style={{ fontSize: 12, color: '#8c8c8c' }}>{r.confirmerName}</span>
                            )}
                          </Space>
                        );
                      },
                    },
                    {
                      title: '操作',
                      width: 155,
                      render: (_: unknown, r: CorrectionItem) =>
                        r.status === 'pending' ? (
                          <Space size={0}>
                            <WriteGate allowed={writeAccess.can && Boolean(selectedComplaintInfo)} tip={selectedComplaintInfo ? writeAccess.tip : '正在读取诉求编号与标题'}>
                            <Button
                              type="link"
                              size="small"
                              icon={<CheckOutlined />}
                              loading={submitting}
                              onClick={() => openVerifyOriginal(r)}
                            >
                              核验无误
                            </Button>
                            </WriteGate>
                            {POSITION_FIELDS.includes(r.fieldName as typeof POSITION_FIELDS[number]) ? (
                              <Tag color="blue">位置组处理</Tag>
                            ) : null}
                          </Space>
                        ) : (
                          <span style={{ color: '#8c8c8c' }}>
                            {r.confirmedAt ? new Date(r.confirmedAt).toLocaleString('zh-CN') : '已处理'}
                          </span>
                        ),
                    },
                  ]}
                />
        </>
      )}
      </Drawer>

      <Modal
        title={'位置组纠偏 · ' + (selectedComplaintInfo?.complaintNo || selectedComplaintId || '诉求')}
        open={positionModalOpen}
        onCancel={() => setPositionModalOpen(false)}
        onOk={() => void savePositionGroup()}
        confirmLoading={submitting}
        okText="保存位置组"
        width={1000}
        destroyOnClose
      >
        <Form form={positionForm} layout="vertical">
          <Descriptions size="small" column={1} bordered style={{ marginBottom: 12 }}>
            <Descriptions.Item label="诉求 ID">{selectedComplaintId}</Descriptions.Item>
            <Descriptions.Item label="诉求标题">{selectedComplaintInfo?.title || '正在读取…'}</Descriptions.Item>
          </Descriptions>
          <div style={{ marginBottom: 12 }}>
            <AddressCandidateCorrection
              sourceAddress={selectedComplaintDetail?.address ?? null}
              candidate={selectedComplaintDetail?.addressCandidate ?? null}
              pending={positionItemsReady && positionItems[0]?.status === 'pending'}
              locationConflict={selectedComplaintDetail?.locationConflict ?? false}
              onUse={() => {
                if (positionItemsReady && positionItems[0]?.status === 'pending' && selectedComplaintDetail?.addressCandidate && !selectedComplaintDetail.locationConflict) {
                  positionForm.setFieldsValue({ address: selectedComplaintDetail.addressCandidate.value });
                }
              }}
            />
            <LocationClues clues={selectedComplaintDetail?.locationClues ?? []} conflict={selectedComplaintDetail?.locationConflict ?? false} />
          </div>
          <Form.Item name="address" label="核实后的地址" rules={positionItems[0]?.status === 'pending' ? [{ required: true, whitespace: true, message: '请输入核实后的地址' }] : []}>
            <Input disabled={positionItems[0]?.status !== 'pending'} placeholder="人工核对后填写地址" />
          </Form.Item>
          <Space style={{ display: 'flex' }} align="start" size={16}>
            <Form.Item
              name="lng"
              label="经度"
              style={{ flex: 1 }}
              rules={positionItems[1]?.status === 'pending' ? [
                { required: true, message: '请选择或输入经度' },
                { pattern: /^-?\d+(\.\d+)?$/, message: '请输入有效经度' },
                { validator: async (_, value) => { const n = Number(value); if (Number.isFinite(n) && n >= -180 && n <= 180) return; throw new Error('经度范围应为 -180 至 180'); } },
              ] : []}
            ><Input disabled={positionItems[1]?.status !== 'pending'} /></Form.Item>
            <Form.Item
              name="lat"
              label="纬度"
              style={{ flex: 1 }}
              rules={positionItems[2]?.status === 'pending' ? [
                { required: true, message: '请选择或输入纬度' },
                { pattern: /^-?\d+(\.\d+)?$/, message: '请输入有效纬度' },
                { validator: async (_, value) => { const n = Number(value); if (Number.isFinite(n) && n >= -90 && n <= 90) return; throw new Error('纬度范围应为 -90 至 90'); } },
              ] : []}
            ><Input disabled={positionItems[2]?.status !== 'pending'} /></Form.Item>
          </Space>
          <TiandituLocationPicker
            address={addressDraft}
            lng={String(positionItems[1]?.newValue ?? positionItems[1]?.oldValue ?? '')}
            lat={String(positionItems[2]?.newValue ?? positionItems[2]?.oldValue ?? '')}
            onPick={(point) => {
              const values: { lng?: string; lat?: string } = {};
              if (positionItems[1]?.status === 'pending') values.lng = point.lng;
              if (positionItems[2]?.status === 'pending') values.lat = point.lat;
              positionForm.setFieldsValue(values);
            }}
            onUseAddressSuggestion={positionItems[0]?.status === 'pending'
              ? (address) => positionForm.setFieldsValue({ address })
              : undefined}
          />
          <Form.Item name="basis" label="核对依据（可选）" style={{ marginTop: 12 }}>
            <Input.TextArea rows={2} placeholder="例如：地图定位、现场核对、来电确认" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="核验原值无误"
        open={verifyTarget !== null}
        onCancel={() => { setVerifyTarget(null); verifyForm.resetFields(); }}
        onOk={() => void submitVerifyOriginal()}
        confirmLoading={submitting}
        okText="提交核验"
        cancelText="取消"
        width={560}
        destroyOnClose
      >
        {verifyTarget ? (
          <>
            <Descriptions size="small" column={1} bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="诉求编号">{selectedComplaintInfo?.complaintNo || verifyTarget.complaintId}</Descriptions.Item>
              <Descriptions.Item label="诉求标题">{selectedComplaintInfo?.title || '正在读取…'}</Descriptions.Item>
              <Descriptions.Item label="字段">{verifyTarget.fieldLabel ?? verifyTarget.fieldName}</Descriptions.Item>
              <Descriptions.Item label="当前原值">
                {verifyTarget.oldValue === null || verifyTarget.oldValue === '' ? '当前为空' : verifyTarget.oldValue}
              </Descriptions.Item>
            </Descriptions>
            <Form form={verifyForm} layout="vertical">
              <Form.Item name="basis" label="核验依据" rules={[{ required: true, whitespace: true, max: 500, message: '请填写核验依据（最多 500 字）' }]}>
                <Input.TextArea rows={3} placeholder="例如：电话核实、现场核对、来源系统原始报文" maxLength={500} showCount />
              </Form.Item>
            </Form>
          </>
        ) : null}
      </Modal>

    </div>
  );
};

export default AddressCorrection;
