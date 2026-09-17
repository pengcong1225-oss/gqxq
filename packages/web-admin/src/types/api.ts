/**
 * 诉求平台管理后台 —— 接口类型定义
 *
 * 契约来源（后者覆盖前者）：
 *  1. docs/2026-09-17-诉求平台G1详细实施方案.md 第 5 节（接口清单与响应示例）
 *  2. docs/2026-09-17-gqxq_service现状核对与G1迁移设计.md 第 3 / 5 节（最新修订）
 *
 * 关键约定（以第 2 份文档为准）：
 *  - 枚举一律【小写】：water/gas/lpg、complaint/consult/suggest/report/help/other/praise、normal/urgent/critical…
 *  - 对外主键用 varchar 业务键 complaintId（形如 CPL202606240001），不是数值 id；
 *    列表项同时保留数值 id 与 business key complaintId。
 *  - 诉求编号为 CS + yyyyMMdd + 4 位（如 CS202606240001）。
 *  - 字典来自服务端 GET /dicts/:code/items，形状 [{ value, label }]。
 */

/* ==================== 统一响应封套 ==================== */

/** 后端统一响应封套；拦截器会把 data 解包后返回，业务函数不再取 .data */
export interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

/** 方案 §5.1 错误码表；后端也可能回填数值型 HTTP 状态码，故实际类型见 ApiError.code */
export type ApiErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'DUPLICATE_CONFLICT'
  | 'INVALID_STATE_TRANSITION'
  | 'PAYLOAD_TOO_LARGE'
  | 'SOURCE_ADAPTER_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | 'NOT_IMPLEMENTED';

/** 400 VALIDATION_FAILED 时 data.fieldErrors[] 的单条结构 */
export interface FieldError {
  field: string;
  message: string;
}

/** 拦截器 reject 的错误对象：在原始 Error 上附加了 code / fieldErrors / status */
export interface ApiError extends Error {
  code?: ApiErrorCode | number;
  fieldErrors?: FieldError[];
  status?: number;
}

/** 服务端分页封套 */
export interface Paged<T> {
  content: T[];
  total: number;
  page: number;
  size: number;
  totalPages: number;
}

/* ==================== 枚举（全部小写，见修订文档 §3.2） ==================== */

export type BusinessType = 'water' | 'gas' | 'lpg';

export type ComplaintType =
  | 'complaint'
  | 'consult'
  | 'suggest'
  | 'report'
  | 'help'
  | 'other'
  | 'praise';

export type UrgencyLevel = 'normal' | 'urgent' | 'critical';

/** none / pending / corrected / failed（completed 不在约定集合内，属待修复数据） */
export type CorrectionStatus = 'none' | 'pending' | 'corrected' | 'failed';

/** 来源事件状态（宜接就办，只读快照）；未接入时必须是 unknown */
export type SourceEventStatus = 'unknown' | 'accepted' | 'processing' | 'completed' | 'closed';

/** 督办交办状态；其中 pending/pushed/accepted/processing/returned 为「进行中」 */
export type SupervisionStatus =
  | 'none'
  | 'pending_match'
  | 'pending'
  | 'pushed'
  | 'accepted'
  | 'processing'
  | 'returned'
  | 'completed'
  | 'rejected'
  | 'archived'
  | 'cancelled';

/** 填报审批状态（public-utility 回传推进） */
export type ReportingStatus =
  | 'not_started'
  | 'pushed'
  | 'accepted'
  | 'submitted'
  | 'returned'
  | 'approved'
  | 'rejected';

/** 入站接收结果（complaint_source_log.result） */
export type IntakeResult = 'created' | 'duplicate_same' | 'updated' | 'rejected';

/**
 * 时间线事件分类（源表映射）。
 * 虽然它不是数据库枚举列，但项目内枚举一律小写，此处同样小写，
 * 避免同一仓库出现两套枚举大小写约定。
 */
export type TimelineCategory = 'intake' | 'field_change' | 'operation' | 'approval';

/* ==================== 诉求总账 ==================== */

/**
 * 列表项（方案 §5.4 响应示例 + 修订文档要求的 complaintId）。
 * 中文标签由服务端按 Code 统一映射后成对返回，前端不另维护翻译表。
 */
export interface ComplaintListItem {
  /** 数值主键（库内自增 id） */
  id: number;
  /** 对外业务键，varchar，形如 CPL202606240001 */
  complaintId: string;
  /** 诉求编号：CS + yyyyMMdd + 4 位 */
  complaintNo: string;
  title: string;

  /** 来源系统（库里 source_system 直接存展示值，无独立 code->label 映射） */
  sourceSystem: string | null;
  sourceId: string | null;
  sourceChannel: string | null;

  businessTypeCode: BusinessType;
  businessTypeName: string;
  complaintTypeCode: ComplaintType;
  complaintTypeName: string;
  urgencyLevelCode: UrgencyLevel;
  urgencyLevelName: string;

  districtCode: string | null;
  districtName: string | null;

  /** 责任企业业务键（enterprise_code varchar），未匹配时为 null */
  enterpriseCode: string | null;
  enterpriseName: string | null;

  isSensitive: boolean;
  /** 命中词数组；服务端将 NULL 归一为 [] */
  sensitiveKeywords: string[];

  correctionStatusCode: CorrectionStatus;
  correctionStatusName: string;
  correctionConfidence: number | null;

  sourceEventStatusCode: SourceEventStatus;
  /** unknown 时服务端返回「未接入」，前端必须原样展示 */
  sourceEventStatusName: string;
  supervisionStatusCode: SupervisionStatus;
  supervisionStatusName: string;
  reportingStatusCode: ReportingStatus;
  reportingStatusName: string;

  closedInSystem: boolean;
  /** 进行中的交办（数据库唯一约束保证同诉求最多一条）；为 null 表示可创建交办 */
  activeDispatchId: string | null;
  activeDispatchStatusCode: string | null;
  activeDispatchStatusName: string | null;
  /** 兼容列：平台侧仍在读写 complaint.status，G1 起由 gqxq 服务按派生规则维护 */
  legacyStatus: string;

  sourceReportedAt: string | null;
  receivedAt: string | null;
  createdAt: string | null;
}

/** 详情（方案 §5.5：完整记录，含 sourcePayload、三轴、closed*、responsible*、analysis*） */
export interface ComplaintDetail extends ComplaintListItem {
  content: string | null;
  address: string | null;
  correctedAddress: string | null;
  locationLng: number | null;
  locationLat: number | null;

  ruleConfidence: number | null;
  ruleVersion: string | null;

  /** 原始报文快照 */
  sourcePayload: Record<string, unknown> | null;
  /** 规范化 JSON 的 sha256；历史行为 null */
  sourcePayloadHash: string | null;
  sourceUpdatedAt: string | null;

  responsibleMatchedAt: string | null;
  responsibleMatchReason: string | null;

  closedAt: string | null;
  /** 确认人业务键 */
  closedBy: string | null;
  closedByName: string | null;
  closedBasis: string | null;

  analysisIncluded: boolean;
  analysisRecordId: string | null;

  updatedAt: string | null;
  /** 软删标记 */
  deleted?: boolean;
}

/** 详情支持数值 id 或诉求编号 */
export type ComplaintIdOrNo = number | string;

/* ==================== 列表查询参数（方案 §5.4 全量） ==================== */

export type SortField = 'receivedAt' | 'complaintNo' | 'urgencyLevel';
export type SortOrder = 'asc' | 'desc';
/** 形如 "receivedAt,desc"；非白名单字段服务端报 400 */
export type SortSpec = `${SortField},${SortOrder}`;

/** 协议上多值参数是「逗号分隔字符串」；此处同时接受数组，由 api 层序列化 */
export type Csv<T extends string = string> = T | readonly T[];

export interface ComplaintListParams {
  /** 页码，默认 1 */
  page?: number;
  /** 每页条数 1–100，默认 20；超出服务端报 400 */
  size?: number;
  /** 匹配 complaint_no / title / content / address_raw，≤100 字符 */
  keyword?: string;
  businessType?: Csv<BusinessType>;
  complaintType?: Csv<ComplaintType>;
  urgencyLevel?: Csv<UrgencyLevel>;
  supervisionStatus?: Csv<SupervisionStatus>;
  sourceEventStatus?: Csv<SourceEventStatus>;
  reportingStatus?: Csv<ReportingStatus>;
  /** 协议值 0/1；为方便调用方也接受 boolean */
  isSensitive?: 0 | 1 | boolean;
  correctionStatus?: CorrectionStatus;
  districtCode?: string;
  /** 责任企业（varchar 业务键 enterprise_code） */
  enterpriseCode?: string;
  /** 作用于 received_at，按 +08:00 解析 */
  startDate?: string;
  endDate?: string;
  /** 默认 "receivedAt,desc" */
  sort?: SortSpec;
}

/** 当前筛选条件下的全量统计（不受分页影响） */
export interface ComplaintListStats {
  total: number;
  sensitiveCount: number;
  notDispatchedCount: number;
  pendingMatchCount: number;
  activeDispatchCount: number;
  closedInSystemCount: number;
}

/** 列表响应：在 Paged<ComplaintListItem> 之上附带 stats 与 generatedAt */
export interface ComplaintListResult extends Paged<ComplaintListItem> {
  stats: ComplaintListStats;
  generatedAt: string;
}

/* ==================== 详情时间线（方案 §5.6） ==================== */

export interface TimelineItem {
  at: string;
  category: TimelineCategory;
  action: string;
  operatorName: string | null;
  summary: string;
  detail: Record<string, unknown> | null;
}

export interface TimelineResult {
  content: TimelineItem[];
  total: number;
}

/* ==================== 仪表盘（方案 §5.7） ==================== */

export interface DashboardMetrics {
  total: number;
  todayReceived: number;
  waterReceived: number;
  gasReceived: number;
  sensitiveTotal: number;
  closedInSystem: number;
  /** 依赖 dispatch_order 与截止时间（批次 G2）：不可计算时为 null，前端渲染 "—" */
  overtimeActive: number | null;
  /** 来源处置状态未接入(G6)、本系统办结未实现(G5)：不可计算时为 null */
  closedRate: number | null;
}

/** 不可计算指标清单；前端据此在 "—" 上给出归属批次的提示 */
export interface UnavailableMetric {
  key: keyof DashboardMetrics;
  reason: string;
}

export interface DashboardPeriod {
  today: string;
  timezone: string;
}

export interface DashboardTrend {
  dates: string[];
  water: number[];
  gas: number[];
}

export interface DistributionItem<C extends string = string> {
  code: C;
  name: string;
  value: number;
}

export interface RegionRankItem {
  districtCode: string | null;
  districtName: string | null;
  value: number;
}

export interface DashboardOverview {
  generatedAt: string;
  /** 数据来源标识，例如 "database" */
  source: string;
  period: DashboardPeriod;
  metrics: DashboardMetrics;
  unavailable: UnavailableMetric[];
  trend: DashboardTrend;
  businessTypeDistribution: DistributionItem<BusinessType>[];
  complaintTypeDistribution: DistributionItem<ComplaintType>[];
  regionRank: RegionRankItem[];
  /** 最新诉求，按 receivedAt 倒序 */
  latestComplaints: ComplaintListItem[];
}

/* ==================== 鉴权（方案 §5.9） ==================== */

export interface UserInfo {
  /** 数值主键 */
  id: number;
  /** app_user.user_id 业务键 */
  userId: string;
  username: string;
  realName: string;
  roles: string[];
  permissions: string[];
}

export interface LoginResult {
  token: string;
  userInfo: UserInfo;
}

/* ==================== 字典（方案 §5.8） ==================== */

export interface DictItem {
  value: string;
  label: string;
}

/** 服务端已支持（未知名 404）；如后端新增字典类型，在此扩展即可 */

/* ==================== G2 分配与分流（与 server/src/types/api.ts 对齐） ==================== */

export type DispatchOrderStatus =
  | 'pending' | 'pushed' | 'accepted' | 'processing' | 'returned'
  | 'completed' | 'rejected' | 'archived' | 'cancelled';

/* ==================== 企业主数据（与 server/src/types/api.ts 对齐） ==================== */

/* ==================== G6 来源对接（与 server/src/types/api.ts 对齐） ==================== */

export interface SourceAdapterState {
  adapter: string;
  enabled: boolean;
  batch: string | null;
  message: string;
  misconfigured: boolean;
}

export interface SourceSyncResult {
  complaintId: string;
  synced: boolean;
  adapterEnabled: boolean;
  rawStatus: string | null;
  sourceEventStatusCode: string | null;
  sourceEventStatusName: string | null;
  updated: boolean;
  message: string | null;
  syncedAt: string | null;
}

/* ==================== G5 回传后流程（与 server/src/types/api.ts 对齐） ==================== */

/** G5 纠偏项自身的处理状态。**注意**：与投诉级的 CorrectionStatus（none/pending/corrected/failed）
 *  是两回事，历史上前者曾与后者同名，造成 TS2300 重复标识符，已改名区分。 */
export type CorrectionItemStatus = 'pending' | 'confirmed' | 'rejected';

export interface CorrectionItem {
  id: number;
  correctionId: string;
  complaintId: string;
  assignmentId: string | null;
  fieldName: string;
  fieldLabel: string | null;
  oldValue: string | null;
  newValue: string | null;
  basis: string | null;
  status: CorrectionItemStatus;
  statusName: string;
  confirmerId: string | null;
  confirmerName: string | null;
  confirmedAt: string | null;
  createdAt: string | null;
}

export interface CorrectionConfirmRequest {
  newValue?: string;
  basis?: string;
}

export interface CorrectionRejectRequest {
  basis?: string;
}

export interface CorrectionGenerateResult {
  complaintId: string;
  assignmentId: string;
  created: boolean;
  total: number;
  items: CorrectionItem[];
}

export interface AnalysisRecordItem {
  id: number;
  analysisId: string;
  complaintId: string;
  assignmentId: string | null;
  businessTypeCode: string;
  businessTypeName: string;
  complaintTypeCode: string;
  complaintTypeName: string;
  districtCode: string | null;
  districtName: string | null;
  enterpriseCode: string | null;
  enterpriseName: string | null;
  summary: string | null;
  disposalResult: string | null;
  confirmedAt: string | null;
  createdAt: string | null;
}

export type ReportTodoStatus = 'pending' | 'in_progress' | 'done';

export interface ReportTodoItem {
  id: number;
  todoId: string;
  analysisId: string;
  complaintId: string;
  reportId: string | null;
  status: ReportTodoStatus;
  statusName: string;
  note: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CloseComplaintRequest {
  basis: string;
}

export interface CloseComplaintResult {
  complaintId: string;
  closedInSystem: boolean;
  closedAt: string | null;
  closedBy: string | null;
  closedByName: string | null;
  closedBasis: string | null;
}

/**
 * 确认 / 拒绝一项纠偏的响应。
 * analysisEntered 由**后端**判定「是否已进入分析库」——前端不要靠数 pending 项自己推断，
 * 因为入库规则（未纠偏不得入库、未走督办链路不入库、并发兜底）都在服务端。
 */
export interface CorrectionDecisionResult {
  item: CorrectionItem;
  analysisEntered: boolean;
  analysisId: string | null;
  analysisReason: string | null;
  writtenBack: boolean;
}

/**
 * 分析记录下钻的组合形状（**嵌套**，字段名是 approvalTraces 复数）。
 * 原先只定义在 analysisService.ts 内部，前端要用之后提升为对外契约。
 */
export interface AnalysisDrilldown {
  record: AnalysisRecordItem;
  complaint: ComplaintListItem | null;
  dispatch: DispatchOrderDetail | null;
  approvalTraces: ApprovalTraceItem[];
  corrections: CorrectionItem[];
  reportTodo: ReportTodoItem | null;
}

/* ==================== G3/G4（与 server/src/types/api.ts 对齐） ==================== */

export type PushResultKind =
  | 'success' | 'replay' | 'conflict' | 'auth_failed'
  | 'payload_too_large' | 'validation_failed' | 'timeout' | 'network_error';

export interface PushDispatchResult {
  assignmentId: string;
  requestId: string;
  /** 本次推送被对方接受（HTTP 200）。**不表示是否首次创建** */
  accepted: boolean;
  /**
   * 由**场景**决定，不是"本次是否新建"：
   *   GQXQ_SENSITIVE_DISPATCH -> true 且返回 task；
   *   GQXQ_ORDINARY_ARCHIVE   -> false 且没有 task。
   * gqxq 只发敏感交办场景，所以正常路径恒为 true。
   * **不要用 created 判断"是否幂等命中"**——那要靠 taskId 是否与既有相同 + 推送日志里的 attempt。
   */
  created: boolean;
  taskId: string | null;
  attempt: number;
  result: PushResultKind;
  httpStatus: number | null;
  errorCode: string | null;
  message: string | null;
  retryable: boolean;
}

export interface DispatchRequestLogItem {
  id: number;
  requestLogId: string;
  assignmentId: string;
  requestId: string;
  attempt: number;
  nonce: string | null;
  httpStatus: number | null;
  result: string;
  errorCode: string | null;
  errorMessage: string | null;
  taskId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string | null;
}

export interface ApprovalTraceItem {
  id: number;
  traceId: string;
  taskId: string;
  eventId: string;
  eventType: string;
  approvalConclusion: string | null;
  submissionVersion: number | null;
  actorName: string | null;
  occurredAt: string | null;
  summary: string | null;
}

export interface EnterpriseListItem {
  id: number;
  enterpriseCode: string;
  enterpriseName: string;
  businessType: string;
  businessTypeName: string;
  uscc: string | null;
  contactPerson: string | null;
  contactPhone: string | null;
  serviceArea: string | null;
  status: string;
}

export interface EnterpriseDetail extends EnterpriseListItem {
  legalPerson: string | null;
  annualScore: number | null;
}

export interface EnterpriseParams {
  page?: number;
  size?: number;
  keyword?: string;
  businessType?: Csv<BusinessType>;
  status?: string;
}

export interface DispatchOrderListItem {
  id: number;
  assignmentId: string;
  orderNo: string;
  complaintId: string;
  complaintNo: string | null;
  complaintTitle: string | null;
  dispatchType: string | null;
  dispatchTypeName: string;
  triggerType: string | null;
  triggerTypeName: string;

  sensitiveWords: string[];
  targetEnterpriseCode: string | null;
  targetEnterpriseName: string | null;
  status: string;
  statusName: string;
  reason: string | null;
  requirement: string | null;
  deadline: string | null;
  requestId: string | null;
  reportingTaskId: string | null;
  syncStatus: string | null;
  externalStatus: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** 归档时间。放在列表项里是因为归档列表要按它展示 */
  archivedAt: string | null;
}

export interface DispatchOrderDetail extends DispatchOrderListItem {
  pushedAt: string | null;
  completedAt: string | null;
  archivedAt: string | null;
  resultContent: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdBy: string | null;
  createdByName: string | null;
  templateCode: string | null;
  templateVersion: number | null;
  approvalDefinitionCode: string | null;
  approvalDefinitionVersion: number | null;
}

export interface DispatchOrderParams {
  page?: number;
  size?: number;
  keyword?: string;
  status?: Csv<DispatchOrderStatus>;
  complaintId?: string;
  targetEnterpriseCode?: string;
  startDate?: string;
  endDate?: string;
}

export interface CreateDispatchRequest {
  complaintId: string;
  targetEnterpriseCode: string;
  targetEnterpriseName: string;
  reason?: string;
  requirement?: string;
  deadline?: string;
  dispatchType?: 'auto' | 'manual';
  triggerType?: 'sensitive_word' | 'manual_flag';
}

export interface CreateDispatchResult {
  created: boolean;
  order: DispatchOrderDetail;
}

export interface AssignEnterpriseRequest {
  enterpriseCode: string;
  enterpriseName: string;
  reason?: string;
}

export interface AssignEnterpriseResult {
  complaintId: string;
  assignmentLogId: string;
  beforeEnterpriseCode: string | null;
  beforeEnterpriseName: string | null;
  afterEnterpriseCode: string | null;
  afterEnterpriseName: string | null;
  supervisionStatus: string;
}

export type DispositionKind = 'no_dispatch_needed' | 'false_positive';

export interface DispositionRequest {
  disposition: DispositionKind;
  reason?: string;
}

export interface DispositionResult {
  complaintId: string;
  dispositionId: string;
  disposition: DispositionKind;
  isSensitive: boolean;
  supervisionStatus: string;
}

export type DictCode =
  | 'business_type'
  | 'complaint_type'
  | 'urgency_level'
  | 'correction_status'
  | 'supervision_status'
  | 'reporting_status'
  | 'source_event_status'
  | 'source_system'
  /** 行政区划：由 M5 迁移登记（GB/T 2260），complaint 用 district_code 过滤 */
  | 'district';
