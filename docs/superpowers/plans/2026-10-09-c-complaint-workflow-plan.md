# gqxq C 诉求办理与协同 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户已授权拆分并交由 GPT-6.1 Sol / High 子代理执行；逐任务开发、独立复核。

**Goal:** 补齐公文号查询、正式详情、来源全过程、位置一致性、人工回访及交办恢复。

**Architecture:** 复用既有诉求、纠偏和协同接口；来源过程、本地过程和回访各自留痕。A 的权限及版本策略贯穿新入口，B 的真实主数据用于选择和校验。

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

- 来源四节点同时间、缺时间或乱序：C1 以来源序号稳定排列，异常不伪造时间。
- 历史原地址已不可还原：C1 明示未知，不把当前人工地址标为原值。
- 一次位置修改一半成功：C2 位置组事务，错误保留输入。
- 未接通回访被纳入满意度分母：C3 有效评价单独判定。
- 外部接受后进程崩溃：C4 从持久待发记录恢复，不能另建任务。

## C1 查询、详情及来源全过程（SQ-01/02/03）

**文件：**
- 修改 `repositories/complaintRepo.ts`、`complaintMapper.ts`、`services/complaintService.ts`。
- 新增 `domain/sourceProcess.ts`、`repositories/sourceProcessRepo.ts`、`services/sourceProcessService.ts`、`routes/sourceProcesses.ts`。
- 修改前端 `ComplaintList.tsx`、`ComplaintDetail.tsx`，提取 `components/SourceProcessTable.tsx`。
- 新增 `server/tests/complaint-query-detail.test.ts`、`source-process.test.ts`；来源节点及版本增量迁移。

**接口与决定：**
- keyword 增加 source_id 查询，保留转义和绑定参数；分页最后以稳定业务/数值主键消除同时间并列的不确定性。
- 详情增加 `sourceAddress`、`effectiveAddress`、`sourceDeadlineAt`、`sourceCompletedAt`、`sourceSnapshotAt`、`businessTimeSource`，映射依据 Q4。原地址取可证明的来源快照，否则 null+原因。
- `SourceProcessNode = {sourceSystem:string; sourceId:string; nodeId:string; sourceSequence:number|null; sourceVersion:string|null; occurredAt:string|null; stage:string; department:string|null; contactName:string|null; opinion:string|null}`。
- `SourceProcessAdapter.fetch(sourceId, cursor?): Promise<{nodes:SourceProcessNode[]; nextCursor:string|null; complete:boolean; cutoffAt:string|null}>`；cursor 为来源不透明值，不自行推算。
- `GET /complaints/:idOrNo/source-processes`：返回节点与完整性、截止时间、同步异常；和现有本地 timeline 分开。
- 节点以稳定来源节点键去重、修订保留版本；没有节点键或版本时先确认契约，不用正文哈希冒充永久 ID。
- 中断保留旧节点；只有完整批次持久化后推进相应水位。详情联系人和意见同样经过 A2 字段投影。
- 本任务只增加未来同步的技术路径，不对当前 Excel 数据重新导入或批量刷新。

- [ ] 编写公文号仅出现在 source_id 仍查到、同日期分页无漏重、来源缺日期明确回落、原 A/人工 B、长文换行和缺字段测试。
- [ ] 编写四来源节点对账、同时间来源顺序、缺时标异常、重放零新增、修订可追溯、拉取中断不丢旧节点测试。
- [ ] 在 server 运行 `npx --no-install tsx --test tests/complaint-query-detail.test.ts tests/source-process.test.ts` 确认失败后实现。
- [ ] 同命令与类型检查通过；真实来源未就绪时验收标“适配器及存储通过，来源联调待完成”，不展示虚构正式节点。
- [ ] 留证，独立提交 `feat: expose accurate complaint details and source process history`。

## C2 地址和位置组纠偏（SQ-04）

**文件：**
- 修改 `services/correctionService.ts`、`repositories/correctionRepo.ts`；新增 `services/locationValidationService.ts`。
- 修改 `components/TiandituLocationPicker.tsx`、`InlineCorrectionField.tsx`、`views/AddressCorrection.tsx`、`ComplaintDetail.tsx`。
- 新增 `server/tests/location-correction.test.ts`，复用已有 location-extraction 等规则测试。

**接口与决定：**
- `LocationCorrectionInput = {complaintId:string; expectedVersion:number; districtCode:string|null; address:string|null; longitude:number|null; latitude:number|null; adminGridCode:string|null; communityCode:string|null; basis:string}`。
- `confirmLocationGroup(input, ctx): Promise<{version:number}>` 在一个事务校验并更新受影响纠偏项；既有单项入口对有关联的修改引导到组提交。
- 区名由区码映射，坐标必须成对、数值有效且符合已确认业务空间规则；不能把尚无边界的数据误判成坐标错误。
- B3 的小区/行政网格关系服务端复核；同名和重叠区域保留多个候选供人工选择。
- 本期交付本地规则与权威空间数据可证明的候选映射；自动采纳、高德替换或外部 NLP 只有在 Q5 明确要求后另细化，不假定已有候选即满足该条。
- 地图接口失败可以人工录入或保留待核实；不同坐标系必须显式转换和记录。输入内容、旧新值、理由可追溯。

- [ ] 测试非法坐标、半对坐标、区码区名冲突、网格小区冲突、跨区同名、地图失败和 A1 旧版本冲突。
- [ ] 在 server 运行 `npx --no-install tsx --test tests/location-correction.test.ts tests/location-extraction.test.ts tests/address-extraction.test.ts` 确认新增用例失败后实现。
- [ ] 验证组保存失败全部回滚；页面保留未提交输入；保存成功再遇来源重投仍保留人工值。
- [ ] 同命令和类型检查通过，验证不自动触发分析入库条件以外的状态变化。
- [ ] 留证，独立提交 `feat: validate and save location corrections consistently`。

## C3 人工回访（SQ-05）

**文件：**
- 新增 `repositories/followupRepo.ts`、`services/followupService.ts`、`routes/followups.ts`。
- 新增前端 `api/followups.ts`、`components/ComplaintFollowups.tsx`，接入详情。
- 新增 `server/tests/followup-history.test.ts`；新增回访记录、修订版本及幂等键迁移。

**接口与决定：**
- `FollowupInput = {complaintId:string; requestId:string; contacted:boolean; occurredAt:string; evaluationCode:string|null; dissatisfactionReason:string|null; notes:string|null}`。
- `createFollowup(input, ctx): Promise<FollowupView>` 操作者取服务端身份，不能由前端冒填。
- `POST /complaints/:idOrNo/followups`、`GET /complaints/:idOrNo/followups`，更正用 `PATCH /followups/:id` 加 expectedVersion 和理由；保留前版本，无无痕删除。
- 幂等键绑定操作者和业务对象；同键同内容回原结果，同键不同内容 409。
- 未接通不自动变成不满意；不满意必须有原因。来源坐席评价单独显示，本地评价规则按 Q5 确认。
- 主管结论修改能力单列 `followup.conclude`，普通回访登记能力为 `followup.create`；企业身份不得修改主管结论。
- 满意度按诉求末次有效评价去重；“有效”的具体判据由 Q5 确认，不简单取最后一行。不增加自动拨号或录音范围。

- [ ] 测试先未接通后不满意，保留两次历史、有效评价案件仅一条；缺原因拒绝、同键重试不新增、更正留旧版、权限拒绝。
- [ ] 在 server 运行 `npx --no-install tsx --test tests/followup-history.test.ts` 确认失败后实现。
- [ ] 验证来源评价不被覆盖、回访不改变交办/办结状态、来源文本中的电话不通过新接口额外泄露。
- [ ] 同命令、类型检查和页面落库重启核对通过。
- [ ] 留证，独立提交 `feat: record auditable manual complaint followups`。

## C4 持久外发与结果未知恢复（SQ-06）

**文件：**
- 修改 `services/dispatchPushService.ts`、`dispatchService.ts`、`clients/publicUtilityClient.ts`。
- 新增 `repositories/dispatchOutboxRepo.ts`、`services/dispatchRecoveryService.ts`。
- 修改 `views/DispatchOrders.tsx` 的发送/重试状态；新测试 `server/tests/dispatch-recovery.test.ts`。
- 待发送记录增量迁移；必须先核对 a564e3e 是否已实现同类能力。

**接口与决定：**
- `DispatchOutboxItem = {requestId:string; assignmentId:string; payloadHash:string; state:'pending'|'sending'|'unknown'|'succeeded'|'failed'; attempts:number; nextAttemptAt:string|null}`，同时持久化准确请求字节和任务关联。
- `recoverDispatch(requestId, transport): Promise<RecoveryOutcome>`；transport 提供 `sendExact` 及按已确认契约可用的 `queryByRequestId`。
- 操作员明确推送时，在现有业务事务中持久化待发任务；不改成创建交办后自动推送。
- 多执行器通过锁/租约抢占，失败恢复沿用同 requestId 和请求字节；进程重启可续发。
- 外部结果未知时优先查询。对方无查询但书面保证同 requestId/同 body 幂等时，可按该契约重试；两者均无则进入人工核验，禁止换号重发。
- 附件仅按双方已确认契约处理；若 gqxq 负责下载，限制目标域、鉴权、大小、真实类型及摘要，授权检查贯穿下载；存证范围等待 Q8，不能直接开放任意 URL 代理。
- 真实双方测试另记，假传输通过不能冒充外部联调通过。

- [ ] 测试外部已创建但响应丢失、落库前进程终止、多执行器并发、重复点击、同请求不同 body、永久失败、历史回调等场景。
- [ ] 在 server 运行 `npx --no-install tsx --test tests/dispatch-recovery.test.ts` 确认失败后实现持久待发与恢复。
- [ ] 验证重启续发只有一个外部任务，界面区分未知与失败；按约定得到查询或人工核验结果后才推进状态。
- [ ] 同命令、A3 绑定回归及类型检查通过；涉及附件时补任意 URL、越权和超限负向用例。
- [ ] 留证，独立提交 `feat: recover dispatch delivery without duplicate tasks`。

## C 批验收出口

SQ-01—06 各自有正向、失败、权限和持久化证据。来源全过程、公用事业真实联调未具备的部分明确单列，不被内部测试覆盖掉；既有纠偏、归库、分析入库和办结规则保持回归通过。


