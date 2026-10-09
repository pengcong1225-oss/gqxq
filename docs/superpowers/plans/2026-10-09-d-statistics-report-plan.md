# gqxq D 统计热力与固定模板报告 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户已授权拆分并交由 GPT-6.1 Sol / High 子代理执行；逐任务开发、独立复核。

**Goal:** 形成同口径可下钻的后台统计、可追溯五档热力规则及可下载的固定模板报告。

**Architecture:** 以共享统计查询定义范围，以主数据版本解释结果，以快照固定历史报告。复用普通后台与地图预览，不建设独立大屏或通用报表设计器。

**Tech Stack:** React 18、TypeScript、Ant Design、Express、MySQL 8、Knex；沿用现有分层及参数化 SQL。

**Spec:** [总方案](2026-10-09-abcd-delivery-plan.md)及《gqxq_非大屏需求差距分析报告_20261008.docx》。

## Global Constraints

- 编制/执行日期：2026-10-09（Asia/Shanghai）。差距报告原基线 `009f40a`；当前开发基线 `a564e3ec18a9af1e5dd1b3a1b19cd38f889d8f43`。
- 已取得远端 `feature/public-utility-integration-20261003` 的 `a564e3e`，25 文件变更已预检；A3/C4 复用已有回调绑定、请求快照及恢复能力，补齐剩余缺口。执行记录见 `docs/acceptance/abcd/baseline-and-decisions.md`。
- 本轮只做 A—D。E 停供/施工台账及复供反馈、F 整体部署恢复和最终交付暂缓；各批自身的测试和验收仍需完成。
- 钉钉由其他项目建设，后续评估复用；本轮只明确本平台的身份与授权边界，不独立建设扫码、免登、通讯录同步或账号批量导入。
- 现有诉求 Excel 已导入且数据最新，不重导、不批量刷新真实诉求，不用真实库进行写入测试。B4 的基础数据导入是新增管理能力，不包含诉求重导或账号人员导入。
- 纠偏覆盖全部诉求，与交办并行；无需交办或误报归库不进入分析库；分析入库须全部纠偏项已处理且曾有交办。
- 本系统办结仍需最终审批通过、无待纠偏项和人工显式操作；来源状态、督办状态、填报审批状态分别保存。
- 所有新增端点更新角色策略和前后端 DTO；权限由服务端校验。错误和空值如实展示，无随机数据或假成功。
- 新增业务表/列先核验外部基线及新提交，采用增量迁移，保留现有业务主键和审计链；生产迁移与数据处置不属于本次方案编制。
- 测试使用虚构样本及明确隔离的测试库；涉及外发的测试使用假传输。计划中的命令是将来执行项，不代表本轮已运行。

## Review Focus

- 部分月份、跨年和闰日比较失真：D1 显式期间政策并列边界测试。
- 来源时间缺失的诉求被静默排除：D1 明示回落计数和排除原因。
- 跨网格重复计算与未定位诉求消失：D1/D2 稳定主键去重、未定位仍计总量。
- 阈值端点错误和浮点舍入换档：D2 用确认真值表和定点数计算。
- 重分类/撤权后旧报告被静默改变或越权下载：D3 固定产物、重新鉴权。

## D1 统一筛选、指标和比较（SQ-14）

**文件：**
- 新增 `domain/statisticsQuery.ts`、`repositories/statisticsRepo.ts`、`services/statisticsService.ts`、`routes/statistics.ts`。
- 修改 `repositories/dashboardRepo.ts`、`services/dashboardService.ts`、`repositories/analysisRepo.ts`。
- 修改前端 `views/Dashboard.tsx`、`Analysis.tsx`，新增 `api/statistics.ts` 和共用筛选组件。
- 新增 `server/tests/statistics-consistency.test.ts`。

**接口与决定：**
- `StatisticsQuery = {dataset:'ledger'|'analysis'; from:string; to:string; businessType?:string; majorCode?:string; minorCode?:string; enterpriseCode?:string; districtCode?:string; serviceGridCode?:string; comparisonPolicyId:string}`。
- `normalizeStatisticsQuery(raw, access): StatisticsQuery`：对外日期为上海业务日，内部转换半开时间区间；数据集必须显式传入并在页面/导出显示。
- `DimensionBucket = {dimension:'business'|'category'|'enterprise'|'district'|'grid'; code:string|null; name:string; count:number}`；`PeriodComparison = {kind:'yoy'|'mom'; baselineFrom:string; baselineTo:string; baselineCount:number; currentCount:number; changePercent:number|null; reason:string|null}`。
- `StatisticsResult = {query:StatisticsQuery; total:number; sourceTimeFallbackCount:number; unlocatedCount:number; excludedByReason:Record<string,number>; dimensions:DimensionBucket[]; comparisons:PeriodComparison[]; dataCutoffAt:string}`；前后端使用相同形状，空分组和零基期按规则显式表达。
- `GET /statistics/summary`、`GET /statistics/complaints` 使用同一个规范化查询及 A2 权限条件，图表点击下钻原样传递筛选。
- ledger 统计当前有效值；analysis 保留入库准入规则，分类修订的当前视图/入库快照视图按 Q6 决定并显式区分，不把未交办归库记录混入分析库。
- 同比环比按 Q6 固定政策处理年/季/月/自定义区间及部分期间；基期 0 返回 null 和“基期为零”，不输出 Infinity。
- 户数取 B2 已确认的历史版本；空间关系使用 B3 有效期，关联后按稳定诉求键去重。
- 本批补齐现有概览的日期口径：趋势、分类、区域、企业统一过滤，不能一个近30天另一个全量。

- [ ] 用虚构数据写断言：本月10、去年同月8、上月5 → 同比25%、环比100%；汇总等于同筛选明细唯一键数。
- [ ] 增加 0 基期、空集合、月底/闰日/跨年、来源时间回落、未定位、跨网格重复、越权范围、分类变更测试。
- [ ] 在 server 运行 `npx --no-install tsx --test tests/statistics-consistency.test.ts` 确认失败；在 Q6 核准后完成明确 DTO、共享查询与页面。
- [ ] 同命令和类型检查通过，随机选择筛选组合以 API/数据库直查对账，保证所展示计数都是可解释结果。
- [ ] 留证，独立提交 `feat: unify complaint statistics and comparison periods`。

## D2 五档热力规则与后台预览（SQ-09）

**文件：**
- 新增 `domain/heatRule.ts`、`repositories/heatRuleRepo.ts`、`services/heatRuleService.ts`、`routes/heatRules.ts`。
- 修改 `views/HeatmapView.tsx`，新增 `views/HeatRuleManager.tsx`、`api/heatRules.ts`，替换 /heatmap/data 501。
- 新增 `server/tests/heat-rule-boundaries.test.ts`；新增草稿/发布版本/生效期迁移。

**接口与决定：**
- `HeatRuleVersion = {version:string; majorCode:string; minorCode:string|null; coefficients:string[]; policyId:string; effectiveFrom:string}`；数组固定绿蓝黄橙红五档，系数以最多两位小数的十进制字符串保存与校验。
- `evaluateHeat({count, days, rule, policy}): {level:'green'|'blue'|'yellow'|'orange'|'red'|null; reason:string|null; ruleVersion:string}`。
- `HeatBoundaryPolicy` 定义上下界开闭、零值处理、最高档、计日、类目覆盖和无规则行为；Q7 审定后固化 policyId。未确认时不发布，不自行采用旧 PRD 的重叠区间。
- 系数转换为百分之一单位整数计算，避免浮点临界；同一版本阈值不能倒序；规则发布有 expectedVersion，发布版不可原地改写。
- 草稿支持样本预览，发布后计算结果带规则版本。无可用规则返回“未配置”，不回退随机颜色。
- 位置缺失诉求计总量但不造点；跨两个覆盖网格的同一诉求按所选统计单元解释并避免总量重复。

- [ ] 将 Q7 的 0、300、450、600、最高档、同日/跨日、缺小类规则、重叠生效期写成输入—输出真值表。
- [ ] 报告给出的 30 天、黄色系数10、橙色20、450件为橙色作为候选验收例；必须先确认整张真值表与该例一致，端点不推测。
- [ ] 在 server 运行 `npx --no-install tsx --test tests/heat-rule-boundaries.test.ts` 确认失败后实现，验证 10.123 和倒序阈值无法发布。
- [ ] 同命令、D1 去重及权限回归、类型检查通过；旧版本重算得到相同等级。
- [ ] 留证，独立提交 `feat: publish versioned five-level heat rules`。

## D3 固定模板报告生成与下载（SQ-14）

**文件：**
- 新增 `repositories/reportRepo.ts`、`repositories/statisticsSnapshotRepo.ts`、`services/reportService.ts`、`services/reportRenderer.ts`、`routes/reports.ts`。
- 修改 `repositories/reportTodoRepo.ts`、`views/ReportView.tsx`，新增 `api/reports.ts`。
- 新增模板目录 `server/templates/reports/`，测试 `server/tests/report-snapshot.test.ts`、`report-download-scope.test.ts`。
- 增量扩展现有 report_record 或关联表，先核验表结构；新增快照、产物和任务状态，不重复另造同义报告表。

**接口与决定：**
- `ReportCreateInput = {requestId:string; templateCode:string; templateVersion:string; query:StatisticsQuery; format:'docx'|'xlsx'}`；实际模板格式按 Q6 核准，建议固定月报/季度/年度统计及自定义期间共用一套字段。
- `ReportArtifact = {reportId:string; snapshotId:string; templateVersion:string; state:'pending'|'generating'|'succeeded'|'failed'; contentHash:string|null; failureReason:string|null}`。
- `createReport(input, access): Promise<ReportArtifact>`、`generateReport(reportId): Promise<void>`、`authorizeReportDownload(reportId, access): Promise<ReportArtifact>`。
- `POST /reports`、`GET /reports`、`GET /reports/:id`、`GET /reports/:id/download`、`POST /reports/:id/retry`；生成、下载、重试使用分别登记的权限码。
- 快照保存选定诉求/分析主键集合及实际计算字段、聚合结果、筛选、截止、分类/户数/网格/热力版本；不能仅保存 ID 后每次读最新数据。
- 同一快照生成失败重试使用原始冻结数据；重新选择当前数据属于新报告。已成功产物固定保存，重复下载返回同一字节及摘要。
- 报告待办只有在真实产物生成并关联后才更新已完成；不能把待办行本身当报告。
- 下载按当前授权核验快照覆盖的全部对象/原件字段权限；权限缩小到不足时拒绝原报告下载，可另行生成当前范围报告，不能偷偷删行却保留旧总数。
- 普通只读角色可按授权下载已有报告；生成/重试维持现有 readonly 非 GET 拒绝约束。
- 输出含实际正文、统计表和模板约定图表；空样本说明无数据。用户内容按文本处理，防止 Excel 公式注入；临时文件通过 reportId 定位，禁止客户端路径穿越。
- 生成库依赖在实施时核验维护状态、许可和兼容性后锁定；不在计划编制阶段安装。固定模板先提供虚构样稿供业务核对。

- [ ] 测试同请求幂等、不同载荷冲突、生成失败可重试、过程崩溃恢复、同快照稳定结果、分类/户数改后旧报告不变。
- [ ] 测试下载越权、生成后撤权、猜报告编号、路径穿越、含公式前缀的用户文本、空集合和超长正文。
- [ ] 在 server 运行 `npx --no-install tsx --test tests/report-snapshot.test.ts tests/report-download-scope.test.ts` 确认失败；实现持久生成任务、冻结快照、渲染和下载。
- [ ] 同命令及类型检查通过；检查实际 DOCX/XLSX 文件可打开、内容完整、图表与数据表一致，核对文件摘要和失败界面；视觉检查用虚构数据。
- [ ] 留证，独立提交 `feat: generate reproducible fixed-template complaint reports`。

## D 批验收出口

D1 汇总、明细与权限一致；D2 规则版本和全部端点真值表通过；D3 下载真实产物且历史可重现。报告生成所需的局部持久化和失败恢复属于本批，整个项目部署恢复与最终验收仍留给 F。


