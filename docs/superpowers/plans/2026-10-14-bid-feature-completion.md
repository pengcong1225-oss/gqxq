# 诉求平台后台缺项实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 用户要求直接实现其他功能再补图，大屏最后单独处理。

**Goal:** 实现停供、施工、回访同步展示、复供后诉求反馈及对比研判预警后台，验证后补标书图片。

**Architecture:** 复用当前平台身份、授权、MySQL 事务、版本和统计快照；以外部来源快照为停供、施工和回访的事实源，后台仅只读展示来源事实。本平台持有反馈关联和预警处理事实，CIM 大屏后续独立处理。

**Tech Stack:** 既有 TypeScript、Express、MySQL、Knex、React、Ant Design、ECharts。

**Spec:** `docs/superpowers/specs/2026-10-14-bid-feature-completion-design.md`

## Global Constraints

- 大屏界面最后单独处理，本批不修改 `packages/web-dashboard`。
- 24 小时窗口为 `[实际复供时刻, 实际复供时刻 + 24h)`，缺实际复供时间进入待核验。
- 停供、施工、回访事实来源于外部系统，不恢复本地申请审批或回访登记。
- 新路由登记角色策略和功能权限；所有查询和写动作重新核对当前对象范围。
- 不覆盖当前六个未提交界面修改。只提交本任务明确编辑的文件。
- 正式库不写测试数据；外部未配置如实显示未接入。

## Review Focus

- 不同来源或企业使用相同事件编号不会互相覆盖。
- 迟到和重复来源版本、发送超时及进程重启不会产生重复反馈。
- 管理员和只读账号都不能越过当前数据范围访问事件或命中诉求。
- 未知位置、日期、分类和历史覆盖不会被解释为零或正常。
- 图表、下钻和告警证据使用相同统计条件及版本。

## Task 1 外部事件契约及只读台账

**Files:** 创建 `server/src/types/businessEvents.ts`、`server/src/domain/businessEvents.ts`、`server/src/repositories/businessEventRepo.ts`、`server/src/services/businessEventService.ts`、`server/src/routes/businessEvents.ts`、`server/migrations/20261014100000__business_events.js`、`server/tests/business-events.test.ts`；修改配置、权限目录、角色策略及根路由。

**Interfaces:** `parseBusinessEvent(input: unknown): BusinessEventInput`；`classifySourceRevision(current: SourceRevision | null, next: SourceRevision): 'new' | 'duplicate' | 'stale'`；`listBusinessEvents(kind, query, context)`；`businessEventDetail(kind, id, context)`；`ingestBusinessEvent(input, authenticatedSource)`。

- [ ] 写并运行 RED 测试：来源隔离、整数版本、重复与旧版本、同版本内容冲突、时间校验、缺字段质量状态。
- [ ] 实现版本快照、日志、来源签名校验及停供/施工真实查询，替代旧 501 路由。
- [ ] 测试来源配置关闭、坏签名、重复请求、事务回滚、列表/详情范围和只读拒绝写。
- [ ] 运行类型检查和单元/独立 MySQL 组件测试，记录结果并提交本任务文件。

## Task 2 回访展示与实际复供后反馈

**Files:** 创建 `server/src/domain/shutdownFeedback.ts`、`server/src/services/shutdownFeedbackService.ts`、`server/src/routes/shutdownFeedback.ts`、`server/src/adapters/shutdownFeedbackAdapter.ts`、对应测试及迁移；扩展 Task 1 来源对象查询。

**Interfaces:** `matchShutdownComplaints(event, complaints, rule): FeedbackMatchResult` 返回匹配和待核验原因；`listShutdownFeedback(query, context)`；`recalculateShutdownFeedback(eventId, context)`；`retryShutdownFeedback(taskId, context)`；`getSynchronizedFollowups(complaintId, context)`。

- [ ] 写并运行 RED 测试：窗口起点包含、终点排除、缺实际复供/来源业务时间、业务和正式类型不匹配、空间未知、多网格去重。
- [ ] 实现规则配置、证据关联、幂等反馈任务、关闭配置和超时待确认/结果查询。
- [ ] 保留来源回访版本，提供只读详情；禁止注册旧手工回访写接口。
- [ ] 验证取消与范围变更、重算、重启恢复、凭据不泄露及授权变化；提交本任务文件。

## Task 3 行政网格对比及研判

**Files:** 创建 `server/src/domain/assessment.ts`、`server/src/services/assessmentService.ts`、`server/src/routes/assessment.ts`、`server/tests/assessment.test.ts`；扩展既有统计事实读取。

**Interfaces:** `compareAdministrativeGrids(facts, gridCodes, categories)`；`historicalTopTypes(facts, query)`；`seasonalAssessment(facts, configuredSeason)`；查询结果提供快照/期间/分类/空间版本及缺项信息。

- [ ] 写并运行 RED 测试：2 至 3 个不同网格、按类型并列最高值、Top3 稳定排序、Top6 不足、跨年季节、闰日和历史不足。
- [ ] 用统一授权快照实现行政网格对比、历史同期间类型 Top3、两场景五年/月度/网格统计与明细下钻。
- [ ] 验证未知日期/位置/类型、历史边界变化和无权限网格不返回伪造零值；提交本任务文件。

## Task 4 四场景预警

**Files:** 创建 `server/src/domain/dataAlert.ts`、`server/src/services/dataAlertService.ts`、`server/src/routes/dataAlerts.ts`、规则与预警迁移及测试。

**Interfaces:** `evaluateAlert(rule, facts): AlertEvaluation`；`saveAlertRule(input, context)`；`publishAlertRule(id, context)`；`calculateAlerts(context)`；`recordAlertDisposition(id, input, context)`。

- [ ] 写并运行 RED 测试：四场景枚举、阈值正整数、版本冲突、分类缺失、三件套映射未配置、有效期间、阈值边界和重复生成。
- [ ] 实现规则版本发布、单一快照计算、命中证据、幂等预警和确认处理历史。
- [ ] 验证数据不足返回未计算、来源取消与迟到重算、只读与越权拒绝；提交本任务文件。

## Task 5 后台页面与导航

**Files:** 创建 `packages/web-admin/src/api/businessEvents.ts`、`api/assessment.ts`、`api/dataAlerts.ts` 及对应 types；实现停供、施工、复供反馈、网格对比、诉求研判、数据预警、数据研判视图；扩展诉求详情同步回访、接入状态、App 路由与导航；增加前端交互测试。

**Interfaces:** 使用 Tasks 1 至 4 的 API；共享查询条件和证据详情组件，来源事实只读。

- [ ] 写并运行 RED 交互测试：导航权限、来源台账筛选、回访只读、缺项状态、2 至 3 网格限制、规则发布禁用条件和明细下钻。
- [ ] 复用现有后台样式，实现筛选、列表、详情和规则抽屉；不修改 CIM 大屏。
- [ ] 类型检查、前端构建、交互测试和隔离环境浏览器完整流程通过后提交。

## Task 6 全流程核验及标书补图

**Files:** 增加接口契约、迁移运行说明、验收记录；更新当前任务截图映射脚本及另存标书。

- [ ] 在独立 MySQL 库验证来源事件/回访入站、查询、复供匹配、反馈超时恢复、历史研判、预警及权限撤销。
- [ ] 执行已有主流程回归、前后端类型检查和构建，确认现有交办、核验、统计未退化。
- [ ] 按 requesting-code-review 技能请求一次独立整体审查并修复重要问题。
- [ ] 后台验证通过后截图并替换标书对应原型文字；CIM 图片和大屏改造留最后的独立阶段。
- [ ] 渲染标书检查排版，交付实现、测试证据和新的标书；如尚缺正式外部联调条件，明确记录。
