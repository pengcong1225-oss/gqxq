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
  Typography,
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
  rejectCorrection,
  generateCorrectionBatch,
  generateCorrections,
  listComplaintCorrections,
  isCorrectionVersionConflict,
  CORRECTION_CONFLICT_MESSAGE,
  correctionEffectiveText,
  confirmLocationGroup,
  getLocationCorrectionOptions,
} from '../api/corrections';
import { listPendingCorrectionComplaints } from '../api/corrections';
import type { DispatchedFilter, PendingComplaintSummary } from '../api/corrections';
import { listEnterpriseOptions } from '../api/enterprises';
import { getComplaint } from '../api/complaints';
import type { AddressCandidateView, ComplaintDetail, CorrectionItem, EnterpriseOption } from '../types/api';
import TiandituLocationPicker from '../components/TiandituLocationPicker';
import LocationClues from '../components/LocationClues';
import InlineCorrectionField, { type InlineCorrectionDraft } from '../components/InlineCorrectionField';
import {LocationCorrectionFields,locationDraftInput,type LocationDraft} from '../components/LocationCorrectionFields';
import type {LocationCorrectionOptions} from '../types/locationCorrection';
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

export const AddressLocationEvidence: React.FC<{
  sourceAddress: string | null;
  candidate: AddressCandidateView | null;
  pending: boolean;
  conflict: boolean;
  clues: ComplaintDetail['locationClues'];
  onUse: () => void;
}> = ({ sourceAddress, candidate, pending, conflict, clues, onUse }) => <>
  <AddressCandidateCorrection
    sourceAddress={sourceAddress}
    candidate={candidate}
    pending={pending}
    locationConflict={conflict}
    onUse={onUse}
  />
  <LocationClues clues={clues} conflict={conflict} />
</>;

const POSITION_FIELDS = ['address', 'location_lng', 'location_lat','district_name'] as const;

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
  const hookAccess = useAdminAccess('system.address.backfill');
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
      {execution && <Alert type={addressBackfillOutcome(execution) === 'success' ? 'success' : addressBackfillOutcome(execution) === 'failed' ? 'error' : 'warning'} showIcon message="执行结果" description={'地址候选新增 ' + execution.created + '，更新 ' + execution.updated + '，未变 ' + execution.unchanged + '，移除 ' + execution.removed + '；位置线索新增 ' + execution.clueCreated + '，更新 ' + execution.clueUpdated + '，未变 ' + execution.clueUnchanged + '，移除 ' + execution.clueRemoved + '；失败 ' + execution.failed + '（扫描 ' + execution.errors.scan + '，单条处理 ' + execution.errors.row + '，审计 ' + execution.errors.audit + '）'} />}
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
  const [enterpriseOptions, setEnterpriseOptions] = useState<EnterpriseOption[]>([]);
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
  const selectedComplaintIdRef = useRef<string | null>(null);
  const selectionIsCurrent = useCallback((complaintId: string, epoch: number) =>
    summarySeqRef.current === epoch && selectedComplaintIdRef.current === complaintId, []);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [items, setItems] = useState<CorrectionItem[]>([]);
  const [inlineDrafts, setInlineDrafts] = useState<Record<string, InlineCorrectionDraft>>({});
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
  const [versionConflict, setVersionConflict] = useState(false);
  const [verifyForm] = Form.useForm<{ basis: string }>();
  const [positionForm] = Form.useForm();
  const addressDraft = Form.useWatch('address', positionForm) as string | undefined;
  const writeAccess = useWriteAccess('complaint.correct');
  const adminAccess = useAdminAccess('system.address.backfill');
  const [positionModalOpen, setPositionModalOpen] = useState(false);
  const [positionResult, setPositionResult] = useState<Array<{ label: string; ok: boolean; detail: string }>>([]);
  const [positionVersion,setPositionVersion]=useState(1);
  const [locationOptions,setLocationOptions]=useState<LocationCorrectionOptions|null>(null);
  const [locationOptionsError,setLocationOptionsError]=useState<string|null>(null);
  const locationOptionsSeqRef=useRef(0);

  const fetchEnterprises = useCallback(async (keyword?: string) => {
    const seq = ++enterpriseSeqRef.current;
    setEnterpriseLoading(true);
    try {
      const res = await listEnterpriseOptions({
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
      selectedComplaintIdRef.current = complaintId;
      setSelectedComplaintId(complaintId);
      setVersionConflict(false);
      setSubmitting(false);
      setPositionResult([]);
      setDrawerOpen(true);
      setItems([]);
      setItemsComplaintId(null);
      setPositionModalOpen(false);
      ++locationOptionsSeqRef.current;setLocationOptions(null);setLocationOptionsError(null);
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
        expectedVersion: item.editVersion,
        basis: basis || undefined,
      });
      setInlineDrafts((drafts) => {
        const remaining = { ...drafts };
        delete remaining[item.correctionId];
        return remaining;
      });
      await afterDecision(item.complaintId, res.analysisEntered === true);
    } catch (err) {
      if (isCorrectionVersionConflict(err)) { setVersionConflict(true); message.warning(CORRECTION_CONFLICT_MESSAGE); }
      else message.error('保存纠偏失败：' + errText(err));
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
      const res = await rejectCorrection(verifyTarget.correctionId, {
        expectedVersion: verifyTarget.editVersion,
        basis: '核验无误：' + values.basis.trim(),
      });
      const complaintId = verifyTarget.complaintId;
      setVerifyTarget(null);
      verifyForm.resetFields();
      await afterDecision(complaintId, res.analysisEntered === true);
    } catch (err) {
      if (isCorrectionVersionConflict(err)) { setVersionConflict(true); message.warning(CORRECTION_CONFLICT_MESSAGE); }
      else message.error('核验未完成：' + errText(err));
    } finally {
      setSubmitting(false);
    }
  };

  const positionItems = POSITION_FIELDS.map((fieldName) => items.find((item) => item.fieldName === fieldName));
  const positionItemsReady = positionItemsMatchSelection(itemsLoading, itemsComplaintId, selectedComplaintId);
  const canEditPositionGroup = positionItemsReady && Boolean(selectedComplaintInfo) && Boolean(selectedComplaintDetail) && positionItems.every(Boolean) && positionItems.some((item) => item?.status === 'pending');

  const openPositionGroup = () => {
    if (!writeAccess.can||!canEditPositionGroup||!selectedComplaintDetail||!selectedComplaintId) return;
    const [address, lng, lat] = positionItems as CorrectionItem[];
    setPositionResult([]);
    setPositionVersion(address.editVersion);setLocationOptions(null);setLocationOptionsError(null);
    const seq=++locationOptionsSeqRef.current;
    void getLocationCorrectionOptions(selectedComplaintId).then(options=>{
      if(seq!==locationOptionsSeqRef.current)return;
      const currentDistrict=selectedComplaintDetail.districtCode;
      if(currentDistrict&&!options.districts.some(d=>d.code===currentDistrict))options.districts.unshift({code:currentDistrict,name:selectedComplaintDetail.districtName??currentDistrict});
      setLocationOptions(options);
    }).catch(e=>{if(seq===locationOptionsSeqRef.current)setLocationOptionsError(errText(e));});
    positionForm.setFieldsValue({
      address: correctionEffectiveText(address),
      lng: correctionEffectiveText(lng),
      lat: correctionEffectiveText(lat),
      basis: '',
      districtCode:selectedComplaintDetail.districtCode,adminGridCode:selectedComplaintDetail.adminGridCode??null,communityCode:selectedComplaintDetail.communityCode??null,
      coordinateSystem:selectedComplaintDetail.locationCoordinateSystem??'unknown',coordinateSource:selectedComplaintDetail.locationCoordinateSource??'现有坐标，坐标系未核实',
    });
    setPositionModalOpen(true);
  };

  // Apply correction/version/detail as one selection result; preserve its mounted drafts.
  const refreshPositionSelection = async (complaintId: string, epoch: number): Promise<CorrectionItem[] | null> => {
    const [current, detail] = await Promise.all([listComplaintCorrections(complaintId), getComplaint(complaintId)]);
    if (!selectionIsCurrent(complaintId, epoch)) return null;
    if (detail.complaintId !== complaintId || current.some(item => item.complaintId !== complaintId)) {
      throw new Error('诉求响应与当前选择不一致，请刷新核对');
    }
    setItems(current);
    setItemsComplaintId(complaintId);
    if (current[0]) setPositionVersion(current[0].editVersion);
    setSelectedComplaintDetail(detail);
    return current;
  };

  const savePositionGroup = async () => {
    if(!writeAccess.can||!positionItemsReady||!selectedComplaintId||versionConflict)return;
    const complaintId = selectedComplaintId, epoch = summarySeqRef.current;
    let values: LocationDraft;
    try {
      values = await positionForm.validateFields();
    } catch {
      return;
    }
    if (!selectionIsCurrent(complaintId, epoch)) return;
    let body;try{body=locationDraftInput(complaintId,positionVersion,values);}catch(e){message.error(errText(e));return;}
    setSubmitting(true);
    let saved = false;
    try {
      const result=await confirmLocationGroup(body);
      saved = true;
      if (!selectionIsCurrent(complaintId, epoch)) return;
      setPositionResult([{label:'位置组一次保存完成',ok:true,detail:result.validationDate+'：'+result.spatialReason}]);
      setPositionModalOpen(false);positionForm.resetFields();
      message.success(result.spatialStatus==='verified'?'位置组已保存，当日空间复核通过':'位置组已保存；空间依据尚未核实');
      if (await refreshPositionSelection(complaintId, epoch) === null) return;
      await loadQueue(page, size, dispatched);
      if (selectionIsCurrent(complaintId, epoch) && result.analysisEntered === true) {
        message.success('该诉求纠偏已全部闭环——已进入分析库（可在「分析库」页查到）');
      }
    } catch(err){
      if (!selectionIsCurrent(complaintId, epoch)) return;
      if(saved)message.error('位置组已保存，刷新当前诉求失败：'+errText(err));
      else if(isCorrectionVersionConflict(err)){setVersionConflict(true);message.warning(CORRECTION_CONFLICT_MESSAGE);}
      else message.error('位置组未保存，全部输入已保留：'+errText(err));
    } finally {
      if (selectionIsCurrent(complaintId, epoch)) setSubmitting(false);
    }
  };

  const pendingCount = items.filter((x) => !['confirmed', 'rejected'].includes(x.status)).length;
  const unknownStatusCount = items.filter((x) => !['pending', 'confirmed', 'rejected'].includes(x.status)).length;
  /**
   * 该诉求在**交办轴**上的状态：取自服务端给的 hasDispatch，一条诉求的各行取值相同。
   * 面板还没加载到任何项时为 null——这时候就是不知道，不能猜成"未交办"。
   */
  const selectedHasDispatch = items.length > 0 ? items[0].hasDispatch : null;
  const sourceAddress = selectedComplaintDetail?.sourceAddress ?? null;
  const refreshConflict = async () => {
    if (!selectedComplaintId) return;
    const complaintId = selectedComplaintId, epoch = summarySeqRef.current;
    try {
      const current = await refreshPositionSelection(complaintId, epoch);
      if (current === null) return;
      if (verifyTarget) setVerifyTarget(current.find(item => item.correctionId === verifyTarget.correctionId && item.status === 'pending') ?? null);
      setVersionConflict(false);
      message.info('已刷新当前有效值与版本；请逐项核对保留的草稿后再提交');
    } catch (err) { if (selectionIsCurrent(complaintId, epoch)) message.error('刷新核对失败：' + errText(err)); }
  };

  return (
    <div>
      {versionConflict && <Alert type="warning" showIcon message={CORRECTION_CONFLICT_MESSAGE}
        action={<Button onClick={() => void refreshConflict()}>刷新核对（保留草稿）</Button>} />}
      <h2 style={{ marginBottom: 8 }}>整体纠偏</h2>
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
                <Button type="primary" icon={<ThunderboltOutlined />} disabled={!writeAccess.can} loading={generating} onClick={() => void doGenerate()}>
                  生成纠偏待办
                </Button>
                <Tooltip title="只给尚无纠偏清单的诉求补挂，重复执行会跳过已有清单。">
                  <Button icon={<TeamOutlined />} disabled={!writeAccess.can} loading={batching} onClick={() => void doBatchGenerate()}>
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
                      <Button icon={<TeamOutlined />} disabled={!writeAccess.can} loading={batching} onClick={() => void doBatchGenerate()}>
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
                  <AddressLocationEvidence
                    sourceAddress={sourceAddress}
                    candidate={selectedComplaintDetail?.addressCandidate ?? null}
                    pending={false}
                    conflict={selectedComplaintDetail?.locationConflict ?? false}
                    clues={selectedComplaintDetail?.locationClues ?? []}
                    onUse={() => undefined}
                  />
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
                {unknownStatusCount > 0 && <Alert type="warning" showIcon message={'有 ' + unknownStatusCount + ' 项历史状态待核验'}
                  description="历史状态已保留，需核查处理依据；这些项不视为纠偏完成。" />}

                {positionItems.some(Boolean) && (
                  <Card size="small" title="位置组：地址与经纬度" style={{ marginBottom: 16 }}>
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message="区划、地址、坐标及网格小区作为一组核对"
                      description="地图只提供待核实候选，也可人工录入。填写依据后一次保存位置组，失败时整组不写入。"
                    />
                    <Space wrap>
                      {writeAccess.can&&<WriteGate allowed={canEditPositionGroup} tip={!selectedComplaintInfo ? '正在读取诉求编号与标题' : '位置字段需全部存在且仍有待处理项'}>
                        <Button type="primary" onClick={openPositionGroup}>打开位置组纠偏</Button>
                      </WriteGate>}
                      {!canEditPositionGroup ? (
                        <span style={{ color: '#8c8c8c' }}>位置字段需完整且仍有待处理项，才能组提交。</span>
                      ) : null}
                    </Space>
                    {positionResult.length > 0 ? (
                      <div style={{ marginTop: 12 }}>
                        <Alert
                          type={positionResult.every((result) => result.ok) ? 'success' : 'warning'}
                          showIcon
                          message="位置组保存结果"
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
                      title: '初始值 / 当前有效值 / 纠偏后取值',
                      width: 430,
                      render: (_: unknown, r: CorrectionItem) => (
                        <div style={{ lineHeight: 1.6 }}>
                          <div><b>初始值：</b>{r.oldValue ?? '—'}</div>
                          <div><b>当前有效值：</b>{r.effectiveValue ?? '—'}</div>
                          {r.newValue && r.status !== 'pending' ? <div><b>确认值：</b>{r.newValue}</div> : null}
                          {r.status === 'pending' && !POSITION_FIELDS.includes(r.fieldName as typeof POSITION_FIELDS[number]) ? (
                            <div style={{ marginTop: 8 }}>
                              <InlineCorrectionField
                                item={r}
                                draft={inlineDrafts[r.correctionId]}
                                onDraftChange={(change) => setInlineDrafts((drafts) => ({
                                  ...drafts,
                                  [r.correctionId]: {
                                    ...(drafts[r.correctionId] ?? {
                                      value: r.fieldName === 'enterprise_name' ? '' : correctionEffectiveText(r),
                                      basis: r.basis ?? '',
                                    }),
                                    ...change,
                                  },
                                }))}
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
                          {r.status !== 'pending' && inlineDrafts[r.correctionId] ? (
                            <div style={{ marginTop: 8 }}>
                              <Typography.Text type="warning">保留的未提交草稿（请与当前有效值核对）</Typography.Text>
                              <div><b>草稿取值：</b>{inlineDrafts[r.correctionId].value || '—'}</div>
                              <div><b>草稿依据：</b>{inlineDrafts[r.correctionId].basis || '—'}</div>
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
        okButtonProps={{disabled:!writeAccess.can||versionConflict||!canEditPositionGroup}}
        okText="保存位置组"
        width={1000}
        destroyOnClose
      >
        {versionConflict && <Alert type="warning" showIcon message={CORRECTION_CONFLICT_MESSAGE}
          action={<Button onClick={() => void refreshConflict()}>刷新核对（保留草稿）</Button>} />}
        <Form form={positionForm} layout="vertical" onValuesChange={changed=>{
          if(Object.prototype.hasOwnProperty.call(changed,'lng')||Object.prototype.hasOwnProperty.call(changed,'lat'))positionForm.setFieldsValue({coordinateSystem:'unknown',coordinateSource:'人工录入，坐标系未核实'});
        }}>
          <Descriptions size="small" column={1} bordered style={{ marginBottom: 12 }}>
            <Descriptions.Item label="诉求 ID">{selectedComplaintId}</Descriptions.Item>
            <Descriptions.Item label="诉求标题">{selectedComplaintInfo?.title || '正在读取…'}</Descriptions.Item>
            {positionItems.filter(Boolean).map(item => <Descriptions.Item key={item!.fieldName} label={'当前有效' + (item!.fieldLabel ?? item!.fieldName)}>
              {correctionEffectiveText(item!) || '（空）'}
            </Descriptions.Item>)}
            <Descriptions.Item label="当前行政网格 / 小区">{selectedComplaintDetail?.adminGridCode??'（空）'} / {selectedComplaintDetail?.communityCode??'（空）'}</Descriptions.Item>
            <Descriptions.Item label="当前坐标系 / 来源">{selectedComplaintDetail?.locationCoordinateSystem??'未核实'} / {selectedComplaintDetail?.locationCoordinateSource??'未留存可核实来源'}</Descriptions.Item>
          </Descriptions>
          <Typography.Paragraph type="secondary">下列输入为本次提交的新值。已处理成员如有变化，将记录旧决定与本次依据；未变化的已处理成员保留原决定。</Typography.Paragraph>
          <div style={{ marginBottom: 12 }}>
            <AddressLocationEvidence
              sourceAddress={sourceAddress}
              candidate={selectedComplaintDetail?.addressCandidate ?? null}
              pending={positionItemsReady && positionItems[0]?.status === 'pending'}
              conflict={selectedComplaintDetail?.locationConflict ?? false}
              clues={selectedComplaintDetail?.locationClues ?? []}
              onUse={() => {
                if (positionItemsReady && positionItems[0]?.status === 'pending' && selectedComplaintDetail?.addressCandidate && !selectedComplaintDetail.locationConflict) {
                  positionForm.setFieldsValue({ address: selectedComplaintDetail.addressCandidate.value });
                }
              }}
            />
          </div>
          <LocationCorrectionFields form={positionForm} options={locationOptions} optionsError={locationOptionsError}/>
          <TiandituLocationPicker
            address={addressDraft}
            lng={positionItems[1] ? correctionEffectiveText(positionItems[1]) : ''}
            lat={positionItems[2] ? correctionEffectiveText(positionItems[2]) : ''}
            onPick={(point) => positionForm.setFieldsValue({lng:point.lng,lat:point.lat,coordinateSystem:point.coordinateSystem,coordinateSource:point.coordinateSource})}
            onUseAddressSuggestion={(address) => positionForm.setFieldsValue({ address })}
          />
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
        {versionConflict && <Alert type="warning" showIcon message={CORRECTION_CONFLICT_MESSAGE}
          action={<Button onClick={() => void refreshConflict()}>刷新核对（保留草稿）</Button>} />}
        {verifyTarget ? (
          <>
            <Descriptions size="small" column={1} bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="诉求编号">{selectedComplaintInfo?.complaintNo || verifyTarget.complaintId}</Descriptions.Item>
              <Descriptions.Item label="诉求标题">{selectedComplaintInfo?.title || '正在读取…'}</Descriptions.Item>
              <Descriptions.Item label="字段">{verifyTarget.fieldLabel ?? verifyTarget.fieldName}</Descriptions.Item>
              <Descriptions.Item label="当前有效值">
                {correctionEffectiveText(verifyTarget) || '当前为空'}
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
