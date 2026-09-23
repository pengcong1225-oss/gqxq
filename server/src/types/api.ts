// 服务端对外 DTO —— **契约唯一真源**。
// 与前端 packages/web-admin/src/types/api.ts 逐字段对齐；改这里必须同步改那边。
//
// 关键约定（见 docs/2026-09-17-gqxq_service现状核对与G1迁移设计.md §3）：
//   * 枚举一律**小写**（water / critical / pending_match ...），与 gqxq_service 现有数据一致
//   * 对外主键是 varchar 业务键 complaintId（形如 CPL202606240001），不是数值 id
//   * 枚举以「码 + 中文名」成对返回（businessTypeCode / businessTypeName），前端不自建翻译表
//   * 责任企业用 enterprise_code（varchar 业务键）——库里没有数值 companyId
//   * 时间一律 ISO-8601 UTC 字符串

export interface Paged<T> {
  content: T[];
  total: number;
  page: number;
  size: number;
  totalPages: number;
}

export interface ComplaintListItem {
  id: number;
  complaintId: string;
  complaintNo: string;
  title: string;

  sourceSystem: string | null;
  sourceId: string | null;
  sourceChannel: string | null;

  businessTypeCode: string;
  businessTypeName: string;
  complaintTypeCode: string;
  complaintTypeName: string;
  urgencyLevelCode: string;
  urgencyLevelName: string;

  districtCode: string | null;
  districtName: string | null;

  enterpriseCode: string | null;
  enterpriseName: string | null;

  isSensitive: boolean;
  sensitiveKeywords: string[];

  correctionStatusCode: string;
  correctionStatusName: string;
  correctionConfidence: number | null;

  sourceEventStatusCode: string;
  sourceEventStatusName: string;
  /**
   * 超期时效派生标记（complaint.overtime_flag，M11）。**三态**：
   *   null = 来源未给出时效信息（未同步 / 正常在办 / 认不出 / 历史未回填）——不是"未超期"
   *   0    = 来源明确未超期
   *   1    = 来源明确超期
   */
  overtimeFlag: number | null;
  /** 三态标签（超期 / 未超期 / 无时效信息）由服务端给；前端不自建翻译表 */
  overtimeFlagName: string | null;
  supervisionStatusCode: string;
  supervisionStatusName: string;
  reportingStatusCode: string;
  reportingStatusName: string;

  closedInSystem: boolean;
  /** 进行中的交办（数据库唯一约束保证同诉求最多一条）；为 null 表示可创建交办 */
  activeDispatchId: string | null;
  activeDispatchStatusCode: string | null;
  activeDispatchStatusName: string | null;
  legacyStatus: string;

  sourceReportedAt: string | null;
  receivedAt: string | null;
  createdAt: string | null;
}

export interface ComplaintDetail extends ComplaintListItem {
  content: string | null;
  address: string | null;
  correctedAddress: string | null;
  locationLng: number | null;
  locationLat: number | null;

  ruleConfidence: number | null;
  ruleVersion: string | null;

  sourcePayload: Record<string, unknown> | null;
  sourcePayloadHash: string | null;
  sourceUpdatedAt: string | null;

  responsibleMatchedAt: string | null;
  responsibleMatchReason: string | null;

  closedAt: string | null;
  closedBy: string | null;
  closedByName: string | null;
  closedBasis: string | null;

  analysisIncluded: boolean;
  analysisRecordId: string | null;

  updatedAt: string | null;
  deleted?: boolean;
}

export type TimelineCategory = 'intake' | 'field_change' | 'operation' | 'approval';

export interface TimelineItem {
  at: string;
  category: TimelineCategory;
  action: string;
  operatorName: string | null;
  summary: string;
  detail: Record<string, unknown> | null;
}

/**
 * 超期筛选参数（query `overtime`）。三值即三种口径，**没有第四个值**：
 *   '1'    = 只要超期（overtime_flag = 1）
 *   '0'    = 只要来源明确未超期（overtime_flag = 0）
 *   'none' = 只要无时效信息（overtime_flag IS NULL）
 * 未传该参数 = 不按超期筛。注意 '0' 与 'none' 不等价：把 NULL 当成"未超期"会把
 * 未同步/历史未回填的件谎报成"来源说没超期"，所以两者必须能分开筛。
 */
export type OvertimeFilterCode = '1' | '0' | 'none';

export interface ComplaintFilter {
  keyword?: string;
  businessType?: string[];
  complaintType?: string[];
  urgencyLevel?: string[];
  supervisionStatus?: string[];
  sourceEventStatus?: string[];
  reportingStatus?: string[];
  /** 超期时效筛选；取值与语义见 OvertimeFilterCode */
  overtime?: OvertimeFilterCode;
  correctionStatus?: string;
  districtCode?: string;
  /** 责任企业 business key */
  enterpriseCode?: string;
  isSensitive?: boolean;
  startDate?: string;
  endDate?: string;
}

export interface ComplaintStats {
  total: number;
  sensitiveCount: number;
  notDispatchedCount: number;
  pendingMatchCount: number;
  activeDispatchCount: number;
  closedInSystemCount: number;
}

export interface ComplaintListResult extends Paged<ComplaintListItem> {
  /** 当前筛选条件下的全量统计（不受分页影响） */
  stats: ComplaintStats;
  generatedAt: string;
}

export interface DashboardMetrics {
  total: number;
  todayReceived: number;
  waterReceived: number;
  gasReceived: number;
  sensitiveTotal: number;
  closedInSystem: number;
  /** 依赖 dispatch_order 与截止时间（G2）；不可计算时为 null，禁止伪造 0 */
  overtimeActive: number | null;
  /** 依赖来源处置状态（G6）或本系统办结（G5）；不可计算时为 null */
  closedRate: number | null;
}

export interface UnavailableMetric {
  key: keyof DashboardMetrics;
  reason: string;
}

export interface DistributionItem {
  code: string;
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
  source: string;
  period: {
    today: string;
    timezone: string;
    /** 业务口径时间列标识；实际表达式见 repositories/complaintRepo.ts 的 BUSINESS_TIME */
    timeBasis: string;
    /** 口径中文说明，前端直接展示，避免"今日"歧义 */
    timeBasisLabel: string;
  };
  metrics: DashboardMetrics;
  unavailable: UnavailableMetric[];
  trend: {
    dates: string[];
    water: number[];
    gas: number[];
    /** 窗口长度（天） */
    days: number;
    /** 窗口起止（Asia/Shanghai 墙钟日，含端点） */
    from: string;
    to: string;
  };
  businessTypeDistribution: DistributionItem[];
  complaintTypeDistribution: DistributionItem[];
  regionRank: RegionRankItem[];
  latestComplaints: ComplaintListItem[];
}

export interface DictItem {
  value: string;
  label: string;
}

export type SensitiveWordStatus = 'enabled' | 'disabled';

export interface ManagedSensitiveWord {
  itemId: string;
  word: string;
  label: string;
  status: SensitiveWordStatus;
  hitCount: number;
}

export interface SensitiveRescanSummary {
  total: number;
  wouldBecomeSensitive: number;
  wouldBecomeNonSensitive: number;
  keywordsChanged: number;
  unchanged: number;
}

export interface SensitiveRescanPreview {
  previewToken: string;
  expiresAt: string;
  fingerprint: string;
  enabledWords: string[];
  summary: SensitiveRescanSummary;
}

export interface SensitiveRescanExecution {
  fingerprint: string;
  updated: number;
  summary: SensitiveRescanSummary;
}

export interface UserInfo {
  id: number;
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

export type IntakeResult = 'created' | 'duplicate_same' | 'updated' | 'rejected';

export interface IntakeResponse {
  result: IntakeResult;
  duplicate: boolean;
  complaintId: string | null;
  complaintNo: string | null;
  changedFields: string[];
  warnings: string[];
}

/* ==================== G2 分配与分流 ==================== */

/** 交办列表项 */
/* ==================== 企业主数据（G2 补：总账分配与交办需要从真实列表选，而不是手抄编码） ==================== */

/* ==================== G6 来源对接 ==================== */

/** 来源适配器的对外状态。/source-status 返回它，UI 据此如实显示「未接入」。 */
export interface SourceAdapterState {
  adapter: string;
  enabled: boolean;
  batch: string | null;
  message: string;
  /** 配置里写了非 disabled 但真实接口未提供时为 true */
  misconfigured: boolean;
}

export interface SourceSyncResult {
  complaintId: string;
  /** 是否真的同步并更新了来源状态 */
  synced: boolean;
  adapterEnabled: boolean;
  /** 来源系统给的原始状态，原样返回便于核对 */
  rawStatus: string | null;
  /** 映射后的状态；无法映射或未更新时为 null */
  sourceEventStatusCode: string | null;
  sourceEventStatusName: string | null;
  /**
   * 本次来源原文给出的超期时效标记（三态，见 ComplaintListItem.overtimeFlag）。
   * 未更新（not_found / unmapped）时为 null，表示"来源这次没给时效信息"，
   * **不代表**库里该列是 NULL。
   */
  overtimeFlag: number | null;
  overtimeFlagName: string | null;
  updated: boolean;
  message: string | null;
  syncedAt: string | null;
}

/* ==================== G5 回传后流程 ==================== */

export type CorrectionItemStatus = 'pending' | 'confirmed' | 'rejected';

export interface CorrectionItem {
  id: number;
  correctionId: string;
  complaintId: string;
  /** 触发本次纠偏清单的交办；**没有交办过的诉求为 null**（纠偏与交办并行，不互为前置） */
  assignmentId: string | null;
  /**
   * 该诉求是否交办过（进行中或历史交办都算）。
   * 纠偏是覆盖全部诉求的数据质量轴，与交办轴并行；这个标记只用于区分两条轴的交叉状态，
   * 不参与任何"能不能纠偏"的判断。
   */
  hasDispatch: boolean;
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

/**
 * 生成纠偏待办。**覆盖所有诉求**（业主 2026-09-20 裁定，推翻旧口径）：
 * 纠偏是数据质量轴，与是否交办、是否审批通过无关；任何诉求只要有 complaintId 就能生成。
 * assignmentId 只是"这条清单由哪次交办触发"的回查线索——有交办则回填最近一条，无交办则为 null。
 */
export interface CorrectionGenerateResult {
  complaintId: string;
  assignmentId: string | null;
  created: boolean;
  total: number;
  items: CorrectionItem[];
}

/**
 * 批量补挂纠偏待办的结果（幂等：已有清单的诉求只跳过、不重复插入）。
 * 覆盖存量与"入站后尚未生成清单"的诉求都靠这个入口收敛，计数可复核。
 */
export interface CorrectionBatchResult {
  /** 本次扫描时库里存活的诉求总数 */
  totalComplaints: number;
  /** 本次新建了纠偏清单的诉求数 */
  createdComplaints: number;
  /** 已有纠偏清单、本次跳过的诉求数（幂等复跑时全部落这里） */
  skippedComplaints: number;
  /** 本次插入的纠偏项行数 */
  itemsInserted: number;
  /** 补挂后仍没有任何纠偏项的诉求数（必须为 0，非 0 表示有诉求生成失败） */
  uncoveredComplaints: number;
  /** 失败明细（最多 20 条），非空即代表本次覆盖不完整，不能当成功收口 */
  errors: Array<{ complaintId: string; message: string }>;
}

export type AnalysisStatus = 'included';

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
  /** 办结依据，必填——规格要求确认人/时间/依据三者缺一不可 */
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

/* ==================== G3 出站：创建填报任务 ==================== */

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
  /** 是否建议自动重试（replay/timeout/network_error 为 true；conflict/auth_failed 为 false） */
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

/* ==================== G4 入站：结果事件回传 ==================== */

export type BusinessEventType =
  | 'task_submitted' | 'task_approved' | 'task_rejected' | 'task_returned';

export type ApprovalConclusion = 'agreed' | 'disagreed' | 'returned';

export interface CallbackAcceptedResult {
  eventId: string;
  accepted: boolean;
  /** 同一 eventId 重复投递时为 true，且必须返回同一个 ACK */
  duplicate: boolean;
  processedResult: 'applied' | 'ignored' | 'rejected' | 'duplicate';
  eventType: BusinessEventType | null;
  message: string | null;
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

export interface EnterpriseFilter {
  keyword?: string;
  businessType?: string;
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
  /** 归档时间。放在列表项里是因为归档列表要按它展示与排序 */
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

export interface DispatchOrderFilter {
  keyword?: string;
  status?: string[];
  complaintId?: string;
  targetEnterpriseCode?: string;
  startDate?: string;
  endDate?: string;
}

/** 创建交办：幂等。已有有效交办时 created=false 且返回既有记录 */
export interface CreateDispatchRequest {
  complaintId: string;
  targetEnterpriseCode: string;
  targetEnterpriseName: string;
  reason?: string;
  requirement?: string;
  /** 带时区偏移的 ISO-8601 */
  deadline?: string;
  dispatchType?: 'auto' | 'manual';
  triggerType?: 'sensitive_word' | 'manual_flag';
}

export interface CreateDispatchResult {
  created: boolean;
  order: DispatchOrderDetail;
}

/**
 * 匹配/调整责任单位。
 * enterpriseCode 必须是 enterprise 表里登记的编码：后端按主数据校验，匹配不到直接报错（不静默）；
 * 写回的 enterprise_name 一律取主数据登记值，请求里给的名字只用于核对，避免 code/name 两处漂移。
 */
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

/** 归库：无需交办 / 误报归库 */
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


/* ==================== 用户与权限（Task #35 三档 RBAC） ==================== */

/**
 * 三档角色。真源是 server/src/auth/rolePolicy.ts 的 ROLES，
 * 与 docs/2026-09-21-角色权限映射.md §1 逐条对应；前端 types/api.ts 同步一份。
 */
export type AppRole = 'admin' | 'handler' | 'readonly';

/** 用户管理列表项：**绝不含 password_hash**（仓储层不 select 它，DTO 也不带） */
export interface UserAdminItem {
  userId: string;
  username: string;
  realName: string;
  /** 本批按单档使用；数组形态保留给未来的多档叠加 */
  roles: AppRole[];
  /** 角色中文名，与 roles 同序（前端不自建翻译表） */
  roleNames: string[];
  /** 1=启用 0=禁用。禁用是唯一的"下线"手段——没有删除端点，审计链要留在人身上 */
  status: 0 | 1;
  lastLoginAt: string | null;
  createdAt: string | null;
}

export interface UserAdminFilter {
  /** 命中 username 或 real_name */
  keyword?: string;
  role?: AppRole;
  status?: 0 | 1;
}

export type UserAdminListResult = Paged<UserAdminItem>;

/** POST /users：初始口令只在请求里出现一次，响应不回显、也不落明文 */
export interface CreateUserRequest {
  username: string;
  realName: string;
  role: AppRole;
  password: string;
}

/** PATCH /users/:userId：字段可选，未传的不动。没有 DELETE —— 禁用代替删除 */
export interface UpdateUserRequest {
  realName?: string;
  role?: AppRole;
  status?: 0 | 1;
}
