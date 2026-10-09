# gqxq A 数据正确性与访问控制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户已授权拆分并交由 GPT-6.1 Sol / High 子代理执行；逐任务开发、独立复核。

**Goal:** 在扩展功能前完成来源重投、人工编辑、对象访问和回调绑定的正确性核验与修复。

**Architecture:** 保留现有事务、身份校验和审计体系，增加字段有效值保护、乐观版本及服务端对象范围。钉钉提供方延后接入，本批授权上下文来自现有本地账号。

**Tech Stack:** React 18、TypeScript、Ant Design、Express、MySQL 8、Knex；沿用现有分层及参数化 SQL。

**Spec:** [总方案](2026-10-09-abcd-delivery-plan.md)及差距报告第四节。

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

- 字段已判定无需纠偏后被旧来源覆盖：A1 按已处理项及确认版本保护。
- 同一人多条企业/辖区授权发生笛卡尔扩张：A2 逐规则计算，禁止分别并集再组合。
- 详情隐藏字段但统计总数泄露范围：A2 覆盖统计和导出入口。
- 旧轮次回调命中新交办：A3 精确绑定交办轮次。
- 代理配置错误绕过封闭入口：A4 验证受信代理和直连路径；无环境证据时记未验证。

## A1 来源值保护及并发纠偏

**文件：**
- 修改 `server/src/services/intakeService.ts`、`correctionService.ts`，`repositories/complaintMapper.ts`、`correctionRepo.ts`。
- 新增 `server/src/domain/effectiveFieldPolicy.ts`；测试 `server/tests/effective-field-protection.test.ts`。
- 前端修改 `views/ComplaintDetail.tsx`、`AddressCorrection.tsx` 和 `api/corrections.ts`（位于 packages/web-admin/src）。
- 按核验结果新增增量迁移：字段来源/确认版本、编辑版本；迁移文件编号在任务 0 后分配，不覆盖已有迁移。

**接口与决定：**
- `EffectiveFieldPolicy.decide({field, sourceValue, effectiveValue, resolution, incomingOrder}): {action:'apply_source'|'retain_effective'|'hold_for_review', reason:string}`；纯规则输入类型同文件定义。
- `resolution` 显式区分未处理、已确认、已判定无需纠偏；后两者保留当时人工决定的有效值。
- 写纠偏请求增加 `expectedVersion:number`。旧版本返回 409；缺少版本的旧客户端不得静默覆盖，发布时前后端同步升级。
- 来源值、有效值、机器候选分别表达；同包不改业务值；来源变包保留快照与差异。来源有可信顺序时拒绝状态倒退，无顺序时不得按到达时间宣称“最新”。
- 来源原始报文保持既有存储规则；补结构化来源字段时不伪造历史原值。旧记录保护状态通过既有纠偏记录推导，无法确定的标为待核验，不全库默认未确认。

- [ ] 编写测试：来源地址 A → 人工确认 B → 同包/变包 C/旧包 A，最终有效地址均为 B，来源快照及差异可追溯；已判定无需纠偏亦有保护依据。
- [ ] 在 server 目录运行 `npx --no-install tsx --test tests/effective-field-protection.test.ts`，记录未修复时的失败断言。
- [ ] 实现字段策略、事务写回和版本校验；两窗口读取 v1，首个成功得到 v2，第二个提交 v1 返回 409，页面保留未提交内容并提示刷新核对。
- [ ] 同命令验证通过，运行根目录 `npm run typecheck` 和相关地址/工作流回归；核对事务失败无半写、人工标题/分类/区划/坐标均受保护。
- [ ] 留存隔离落库及重启证据，独立提交 `fix: preserve confirmed complaint fields on source replay`。

## A2 统一对象范围和详情投影

**文件：**
- 新增 `server/src/auth/accessScope.ts`、`repositories/userScopeRepo.ts`、`services/complaintProjection.ts`。
- 修改 `middleware/requireAuth.ts`、`types/express.d.ts`、`repositories/userRepo.ts`、`services/userService.ts`、`routes/users.ts`、`auth/rolePolicy.ts`。
- 修改 complaint/analysis/dashboard/dispatch/correction 的读取和写入入口，用户管理前端 `UserManager.tsx`。
- 新增 `server/tests/object-scope.test.ts`、`detail-projection.test.ts`；新增用户授权规则增量迁移。
- 同步后端/前端 DTO 及角色映射文档。

**接口与决定：**
- `AccessContext = {userId:string; roles:string[]; scopeVersion:number; rules:ScopeRule[]; canReadSource:boolean}`。
- `ScopeRule = {kind:'all'} | {kind:'restricted'; enterpriseCodes:string[]; districtCodes:string[]}`。
- 建议语义：单条受限规则中已指定的企业和辖区取交集，多条规则取并集；两数组都空的受限规则无授权，缺规则亦无授权。最终采用 Q1 核准矩阵。
- `resolveAccessContext(userId): Promise<AccessContext>` 从 A5 的当前本地授权解析，canReadSource 由 source_document.read 能力派生；未来钉钉复用先映射本地 userId。
- `buildComplaintScopeSql(ctx, alias): {sql:string; params:unknown[]}` 只使用受控 alias 和绑定参数；对象读写先查权限，用户筛选只能缩小范围。
- `projectComplaintDetail(row, ctx): ComplaintDetail` 白名单投影；原始报文改为专门授权入口 `GET /complaints/:idOrNo/source-document` 并审计，主体详情不整包附送。
- 既有全域权限如需保留，必须明确登记；不能因“无配置”自动全域。管理员管理权限与业务数据全域范围分别定义，避免角色隐含扩权。
- 全部绑定现有 app_user，不创建钉钉表、扫码路由或通讯录同步器。

- [ ] 按 Q1 编写 A企业/G1 与 B企业/G2 规则测试，断言不能访问 A企业/G2 的交叉对象；无授权、软删对象、猜测编号、原件权限均覆盖。
- [ ] 在 server 运行 `npx --no-install tsx --test tests/object-scope.test.ts tests/detail-projection.test.ts`，确认失败后实现权限查询、字段投影、管理配置。
- [ ] 测试列表总数、详情、分析下钻、交办及纠偏写接口一致拒绝；授权收回后旧令牌下一次请求按新范围执行。
- [ ] 运行上述测试、根目录 `npm run typecheck`；RBAC 在显式隔离环境运行并更新映射文档。
- [ ] 留证，独立提交 `feat: enforce object scopes and source document access`。

## A3 交办企业校验及回调绑定

**文件：**
- 修改 `services/dispatchService.ts`、`assignmentService.ts`、`callbackService.ts` 和 `repositories/dispatchRepo.ts`。
- 新增 `services/dispatchBindingService.ts`；测试 `server/tests/dispatch-binding.test.ts`。
- 可能修改 `clients/publicUtilityClient.ts`，以任务 0 核对的新契约为准。

**接口与决定：**
- `assertTargetEnterprise(tx, code, name): Promise<{code:string; name:string}>` 查询真实有效企业，复用独立责任确认的校验；合法改派按现行规则审计，不按码名差异一律拒绝。
- `resolveCallbackBinding(tx, {taskId, sourceBusinessId, subjectCode}): Promise<DispatchBindingResult>` 返回精确交办/诉求/企业/轮次或结构化拒绝原因。
- taskId 命中后仍交叉验证案件与企业；不能按案件“最新一单”把历史回调落到新单。缺字段、未登记 taskId 和超时后首次回调按 Q8 明确的唯一关联条件处理。
- 保留既有 HMAC、时间窗口、事件幂等、ACK 和状态机；绑定失败记录异常，不推进任何对象。响应码和 ACK 严格依双方契约。

- [ ] 测试未知企业、码名不一致、允许改派、有效签名但 task=A/案件=B/企业=C、历史轮次、重复事件、未关联任务。
- [ ] 在 server 运行 `npx --no-install tsx --test tests/dispatch-binding.test.ts` 并记录失败。
- [ ] 实现一致性校验及事务内绑定；错误事件重放得到稳定结果。
- [ ] 同命令及隔离 G2/G3/G4 相关场景通过；确认无第二条有效交办，来源状态无误改。
- [ ] 留证，独立提交 `fix: validate dispatch target and callback identity bindings`。

## A4 来源入站认证核验

**文件：**
- 修改（仅在契约具备时）`routes/externalYijiejieban.ts`、`config/env.ts`；新增 `middleware/verifySourceIdentity.ts`。
- 新增测试 `server/tests/source-auth-boundary.test.ts`。
- 更新 `docs/2026-09-20-入站防护部署与暴露面登记.md` 的当前核验结论，不覆盖历史事实。

**输入/输出：**Q8 的来源身份协议和网络拓扑 → 应用来源身份校验、失败语义及当前开放条件记录。来源身份独立于用户/钉钉身份。

- [ ] 核验新提交是否已有认证；取得签名字段、原文字节、时间窗口、重放键、密钥轮换和网络边界约定，禁止自创对方未支持的协议。
- [ ] 用假传输编写坏签名、过期、重放、超限、错误 IP、伪造代理头测试；在 server 运行 `npx --no-install tsx --test tests/source-auth-boundary.test.ts`。
- [ ] 具备契约后实现并复测；未具备时记录阻断项，保持现有封闭，不开放真实入口。
- [ ] 记录应用测试与网关实测的不同状态；A4 无真实环境证据就标“待联调”，不影响其余批次的本地开发。
- [ ] 有代码变更时独立提交 `feat: verify authorized source requests`。

## A5 账号初始化与可配置角色权限

**当前基础：**已有真实用户列表、新建、姓名/角色/状态修改、三档 RBAC 和末位管理员保护。没有改密端点，角色页只是三档说明，路由权限主要写在代码中。不能把本任务写成“用户模块从零开发”，也不能把角色说明页当可配置角色管理。

**文件：**
- 修改 `routes/users.ts`、`services/userService.ts`、`repositories/userRepo.ts`、`services/authService.ts`、`auth/rolePolicy.ts`、`middleware/requireAuth.ts`、`middleware/requireRole.ts`。
- 新增 `auth/permissionCatalog.ts`、`services/roleService.ts`、`repositories/roleRepo.ts`、`routes/roles.ts`。
- 修改 `packages/web-admin/src/views/UserManager.tsx`，新增 `RoleManager.tsx`；同步菜单、按钮与前后端 DTO。
- 新增 `server/tests/account-role-management.test.ts`；角色/权限/用户角色/会话版本新增增量迁移。
- 调整 `server/scripts/seed-admin.mjs` 及 RBAC 门禁，新增 `docs/acceptance/abcd/account-initialization.md`。

**接口与决定：**
- `PermissionCode` 为注册目录中的稳定字符串，例如 `complaint.read`、`complaint.correct`、`dispatch.create`、`report.generate`、`report.download`、`source_document.read`、`system.users.manage`、`system.roles.manage`、`system.audit.read`、`system.dict.manage`、`masterdata.import`；逐端点列出，不接受任意字符串或仅菜单级许可。B4 导入还必须同时满足目标模块维护权限与对象范围，不能用一项导入权限绕过原有校验。
- `EffectiveAuthorization = {roleCodes:string[]; permissionCodes:PermissionCode[]; authorizationVersion:number}`。
- `resolveAuthorization(userId): Promise<EffectiveAuthorization>` 作为 A2 上下文的角色及能力来源；每次请求读取当前生效权限，初期不用会产生回收延迟的长缓存。
- 新增 `GET/POST /roles`、`PATCH /roles/:roleCode`、`GET /permissions`；角色写入带 `expectedVersion`。支持角色新增、从业务角色复制、名称/说明修改、启停及授权。
- 管理员/经办/只读作为内置角色迁移种子，先完整复现当前授权；只读内置角色维持非 GET 拒绝。管理员管理能力为受保护配置，不能通过复制或通配符意外授予自定义角色。
- 本期每人分配一个业务角色，角色内可选择注册的功能权限；用户数据范围由 A2 独立配置。多角色叠加列为可选扩展，避免未经确认改变“一人一档”。
- 菜单和按钮根据后端有效权限呈现，服务端再校验；新增未登记路由不能被自定义角色访问。旧 `requireRole('admin')` 与新 permission 判断必须逐路由统一迁移，不能保留互相矛盾的两套判定。
- 首位管理员由实施配置指定，幂等初始化；重复初始化不重置口令或扩大权限，无公共自助提权入口。本地验证账号仅在测试库建立。
- 保留本地账号建立、修改、启停；增加本地账号本人改密及管理员重置（`POST /auth/change-password`、`POST /users/:userId/reset-password`），要求修改初始/重置口令并递增会话版本使旧会话失效；以 UTF-8 字节验证 bcrypt 输入上限。密码、散列和临时口令不进入列表、日志或报告。
- 未来钉钉身份绑定不改变 user_id。本批不实现外部人员同步和绑定界面，只交付人员授权表、现有账号核对流程及复用接口要求；不批量预建单位所有人员账号。

- [ ] 编写测试：原三档权限迁移前后一致；角色创建/复制/启停持久化；业务角色不能获得系统管理员配置权；未知权限代码拒绝；两个管理员并发降级不能清空最后一名可用管理员。
- [ ] 在 server 运行 `npx --no-install tsx --test tests/account-role-management.test.ts`，确认失败后实现账号、角色和授权服务及前端管理。
- [ ] 验证直接调用隐藏按钮对应接口仍被拒；角色变更/停用后旧会话按新权限处理；改密/重置后旧令牌失效；重复初始化不新增管理员。
- [ ] 跑上述测试及隔离 RBAC 全矩阵、根目录 `npm run typecheck`；验证日志中不含密码，字节超限输入明确 400。
- [ ] 保存初始化操作说明和管理员演示步骤，独立提交 `feat: manage platform accounts roles and permissions`。

## A6 登录与操作日志查询

**文件：**
- 扩展 `repositories/auditLogRepo.ts`，新增 `services/auditQueryService.ts`、`routes/auditLogs.ts`。
- 新增 `packages/web-admin/src/views/AuditLogView.tsx`、`api/auditLogs.ts`。
- 新增 `server/tests/audit-query.test.ts`，按查询模式补必要索引；更新登录和敏感操作日志的安全字段清单。

**接口与决定：**
- `GET /audit-logs` 支持日志类别、时间区间、操作人、模块、动作、结果和业务编号，分页稳定排序；`GET /audit-logs/:auditId` 返回安全投影。
- `AuditQueryService.list(filter, pagination, access): Promise<Paged<AuditLogView>>` 需要 `system.audit.read`；登录成功/失败、授权变更、停用、原件访问、纠偏、交办、字典变更及报告生成下载均可定位。
- 复用 `operation_audit_log`；登录日志是分类视图，不另建一套重复流水。不同历史 result 值在查询映射层规范化，保留原值。
- 页面明细只展示允许字段及必要前后值，禁止直接输出整个 detail、诉求正文、令牌或签名。无修改/删除日志接口。
- 本批提供分页查询与详情。日志导出如业务需要，沿用 D3 下载权限和脱敏框架；备份留存、集中日志平台和运维告警仍由后续 F 定义。

- [ ] 测试有权限与无权限用户、失败登录、角色变更前后值、虚构敏感字段投影、相同时间多条记录稳定分页。
- [ ] 在 server 运行 `npx --no-install tsx --test tests/audit-query.test.ts`，确认失败后实现查询与页面。
- [ ] 完成一次建号/授权/纠偏，在页面按操作人和业务号找到相应记录；日志详情不含密码、令牌或原始报文。
- [ ] 同命令及类型检查通过，留证后独立提交 `feat: expose authorized login and operation audit views`。

## A 批验收出口

A1—A3、A5—A6 的负向和既有流程回归通过，所有风险都有复现/排除/修复证据；A4 明确已验证及待验证部分。A 的通过不意味着钉钉已集成或真实入口已获准开放。


