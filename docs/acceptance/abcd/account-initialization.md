# A5 账号初始化、角色授权与管理员演示

日期：2026-10-09（Asia/Shanghai）。本次保留既有真实用户列表、建号、姓名/角色/启停修改，新增可配置角色、本人改密、管理员重置及会话失效能力。用户不删除，既有 `user_id` 和历史审计链保留。

## 实施人员初始化首位管理员

1. 先核对目标环境与真实数据库基线，备份，并按项目既定流程应用增量迁移 `20261009030000__account_role_permissions.js`。本次只在专用账号组件库验证了 A5 迁移，未验证 canonical 19 表全链迁移；不要把下面的实施步骤当作生产已执行记录。
2. 由实施配置明确设置 `GQXQ_BOOTSTRAP_ADMIN_USERNAME`、`GQXQ_BOOTSTRAP_ADMIN_PASSWORD` 和可选的 `GQXQ_BOOTSTRAP_ADMIN_REAL_NAME`，数据库配置使用该目标环境。用户名必填，无默认账号；口令至少 8 个字符、UTF-8 编码不超过 72 字节。通过既定安全渠道配置，禁止把口令写进工单、命令输出或培训材料。
3. 在 `server` 目录执行 `node scripts/seed-admin.mjs`。创建时在同一事务取得授权锁、发号、写用户和更新授权版本；日志只显示账号和 `user_id`，不显示口令、散列。
4. 首次登录自动到「修改口令」，填「当前口令」「新口令」「确认新口令」，点「保存并重新登录」。改密成功后旧令牌失效，重新登录才能使用业务功能。
5. 重复执行相同初始化配置：已有同名账号时直接跳过，不重置口令、不改变角色、不启用被停用账号。已经有启用管理员而配置了另一个新名字时，脚本拒绝新增管理员；后续建号通过「账号管理」完成。

迁移将现有账号标记为须改密，并引入 `session_version`。旧的、没有会话版本的 JWT 不再接受，实施升级时现有用户须重新登录。若历史账号的角色 JSON 不是数组、存在多个角色或指向不存在的角色，迁移明确拒绝并要求先核对，不静默选档。

## 管理员建号与授权演示

1. 管理员登录并完成改密后，左侧打开「角色权限」。需要定制角色时点「新增角色」，填写稳定「角色代码」「角色名称」「说明」，可从启用的业务角色复制，勾选注册的「功能权限」，点「保存」。也可在已有行点「编辑授权」修改名称、说明、启用状态和功能权限。
2. 打开「账号管理」→「新增用户」，填写用户名、姓名，**明确选择一个启用角色**，填写初始口令，点「创建」。页面没有默认经办角色，也没有批量建号功能。列表只返回账号信息、角色名称、启停与登录时间、须改密状态，不回显口令或散列。
3. 将初始口令通过既定安全渠道交给本人。用户第一次登录须完成上面的改密流程。只读用户也可以改本人口令；这个身份自助例外不开放交办、纠偏等业务 POST。
4. **对象范围由后续 A2 独立配置。** A5 本批交付的是功能权限和账号能力；不能把选择角色理解为已经配置企业、区县等对象范围，也不能把尚未接入的范围界面作为本批已可演示的步骤。
5. 演示角色最小授权：只授予诉求查询后，用户界面按后端有效权限显示菜单和操作按钮。直接绕过隐藏按钮请求用户管理或未授权业务端点仍返回 403；新增未登记端点对当前有效授权默认拒绝。

## 账号停用、角色停用与口令重置

| 操作 | 页面路径 | 服务端行为 |
| --- | --- | --- |
| 修改姓名/角色 | 账号管理 → 行内「编辑」→ 保存 | 本期每人一个业务角色；必须选启用且存在的角色；授权版本递增，下一请求读取新授权 |
| 停用账号 | 账号管理 → 行内「禁用」 | 保留账号与审计，旧会话随后请求返回 401；禁止自停用 |
| 启用账号 | 账号管理 → 行内「启用」 | 恢复账号状态；是否须改密保持现有事实 |
| 重置口令 | 账号管理 → 行内「重置口令」→ 填新临时口令 → 确认 | 会话版本递增、旧令牌失效，下次登录须本人改密；不生成或回显临时明文 |
| 本人改密 | 右上角用户菜单 → 修改口令 → 保存并重新登录 | 校验当前口令，新口令不能与旧口令相同；成功后所有旧会话失效 |
| 停用业务角色 | 角色权限 → 编辑授权 → 关闭「启用」→ 保存 | 账号身份仍可查，当前有效角色/功能权限返回空数组，后续业务访问拒绝；仍可改本人口令 |
| 并发降级管理员 | 由两位管理员分别操作另一位账号 | 所有授权写先取得同一单例锁；最后一位启用管理员不能被降级或停用，返回 409 |

内置 `admin` 的启用状态与权限受保护；自定义角色不能获得 `system.users.manage`、`system.roles.manage`，也不能复制管理员或使用 `*` 通配。复制只接受启用的业务角色。内置只读角色即使误授业务写权限，服务端仍禁止非 GET 业务请求。

角色保存携带 `expectedVersion`，并发版本不符返回 409，刷新后重新核对修改。前端在登录、页面导航/窗口重新获得焦点时取当前用户授权；服务端每个请求均查当前授权，不依赖前端缓存。

## 人员授权核对表

本批不批量预设单位全部人员账号，不导入钉钉人员。管理员应先核对需要使用系统的现有人员，逐人建号或确认已有账号。

| 核对项 | 要记录的非凭证信息 |
| --- | --- |
| 本人核对 | 姓名、单位、现有平台用户名/`user_id`、账号是否重复 |
| 授权责任 | 申请人、核准人、业务角色代码、需开放的功能权限、启停依据 |
| 后续 A2 | 待配置的对象范围及依据；A5 不自动推定为全局范围 |
| 未来钉钉适配 | 已验证手机号的规范化盘点、验证来源、冲突/缺失处置；手机号不自动绑定身份 |

未来复用钉钉应遵循 [复用计划](../../superpowers/plans/2026-10-09-dingtalk-reuse-plan.md)：Provider Java 示例是参考实现，不是现成 OIDC 中心。本批没有扫码、免登、同步、绑定界面或手机号自动绑定代码。将来首次外部登录如建立身份，应保留同一平台 `user_id` 的绑定边界，未批准前是零角色、零对象范围的待授权身份；不能自动赋只读或经办，也没有公共自助提权入口。

## 开发接入与验证边界

`services/roleService.ts` 导出 `resolveAuthorization(userId): Promise<EffectiveAuthorization>`。类型在 `auth/permissionCatalog.ts`：`{ roleCodes: string[]; permissionCodes: PermissionCode[]; authorizationVersion: number }`。`requireAuth` 将其当前值放入 `req.user.roles / permissionCodes / authorizationVersion`，身份类型在 `http/errors.ts`，同时放 `mustChangePassword`。A2 可直接复用，不需角色缓存。

`repositories/roleRepo.ts` 导出 `lockAuthorization(exec)` 和 `bumpAuthorization(exec)`。角色、用户角色/状态改变在同一事务先锁 `platform_authorization_state(id=1)`，再操作角色/用户，最后递增单调的全局授权版本；没有用户版本与角色版本求和碰撞。A2 对象范围变更应沿用这个锁序与版本更新。`sessionVersion` 单独从账号读取并在 JWT 校验；改密/重置只递增会话版本，不用角色版本替代。

新增业务端点须在 `ROLE_POLICY` 注册具体 `permissionCode`；旧 `requireRole('admin')` 的路由闸门已迁移到对应 `requirePermission`，两层判断使用同一功能权限。B4 导入还必须校验目标模块维护权限与对象范围，`masterdata.import` 本身不提供绕过能力。机器入站与签名回调仍位于用户 Bearer 中间件之前。

本次验证记录：纯权限/字节上限/错误投影测试与全端点矩阵通过；专用 `gqxq_a5_contract_test` 真实 MySQL 组件测试验证了角色持久化、版本冲突、旧会话更新、真实并发管理员保护、首次/重复初始化与密码失败日志安全。前端 DOM 验证了强制改密跳转、表单提交后重新登录、自定义权限按钮和角色创建。真实业务库、canonical 全迁移及运行实例重启验收尚未执行，不能据此标为生产验收通过。

安全矩阵命令：仓库根 `node server/scripts/verify-rbac.mjs --policy-only`。组件测试只有显式指定 `GQXQ_A5_COMPONENT_DB=gqxq_a5_contract_test` 且数据库同名才运行；仅采用 M1 已有账号/发号表定义、显式测试审计夹具和 A5 新迁移，不运行 M0，也不拼造十九张空表。

## 当前逐端点权限表

下表由本批 `ROLE_POLICY` 逐条核对。`身份自助`只用于本人身份查询和本人改密；目录内尚无端点的预留权限不会凭空打开访问。

| 方法 | 路径（省略 `/api/v1`） | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/auth/change-password` | `身份自助` | 本人改密 |
| POST | `/users/:id/reset-password` | `system.users.manage` | 管理员重置口令 |
| GET | `/roles` | `system.roles.manage` | 角色列表 |
| POST | `/roles` | `system.roles.manage` | 创建角色 |
| PATCH | `/roles/:id` | `system.roles.manage` | 修改角色 |
| GET | `/permissions` | `system.roles.manage` | 权限目录 |
| GET | `/auth/user-info` | `身份自助` | S1 当前登录用户信息 |
| GET | `/complaints` | `complaint.read` | R1 诉求总账列表 |
| GET | `/complaints/:id` | `complaint.read` | R2 诉求详情 |
| GET | `/complaints/:id/timeline` | `complaint.read` | R3 诉求时间线 |
| GET | `/complaints/:id/corrections` | `complaint.read` | R4 单条纠偏清单 |
| GET | `/enterprises` | `enterprise.read` | R5 企业主数据列表 |
| GET | `/enterprises/:id` | `enterprise.read` | R6 企业详情 |
| GET | `/dashboard/overview` | `dashboard.read` | R7 数据大屏 |
| GET | `/dicts/:id/items` | `dict.read` | R8 通用字典项只读查询 |
| GET | `/dispatch/orders` | `dispatch.read` | R9 交办列表 |
| GET | `/dispatch/orders/:id` | `dispatch.read` | R10 交办详情 |
| GET | `/dispatch/orders/:id/push-logs` | `dispatch.read` | R11 推送留痕 |
| GET | `/dispatch/orders/:id/approval-trace` | `dispatch.read` | R12 审批轨迹 |
| GET | `/corrections/pending` | `complaint.read` | R13 待纠偏队列 |
| GET | `/corrections/pending-complaints` | `complaint.read` | R23 诉求级待纠偏列表 |
| GET | `/analysis/records` | `analysis.read` | R14 分析库列表 |
| GET | `/analysis/records/:id` | `analysis.read` | R15 分析下钻 |
| GET | `/report-todos` | `report.read` | R16 待查报告待办 |
| GET | `/source-status` | `source_status.read` | R17 来源适配器状态 |
| GET | `/grids` | `grid.read` | R18 网格（501 桩，放行后仍 501） |
| GET | `/shutdowns` | `shutdown.read` | R19 停供（501 桩） |
| GET | `/pipeline-projects` | `pipeline.read` | R20 管道施工（501 桩） |
| GET | `/reports` | `report.read` | R21 分析报告（501 桩） |
| GET | `/heatmap/data` | `heatmap.read` | R22 热力图（501 桩） |
| POST | `/complaints/:id/assignment` | `complaint.assign` | W1 匹配/调整责任单位 |
| POST | `/complaints/:id/disposition` | `complaint.disposition` | W2 归库（无需交办/误报） |
| POST | `/complaints/:id/corrections/generate` | `complaint.correct` | W3 生成纠偏待办 |
| POST | `/complaints/:id/close` | `complaint.close` | W4 本系统办结 |
| POST | `/complaints/:id/source-sync` | `complaint.source_sync` | W5 来源状态回填 |
| POST | `/corrections/generate-batch` | `complaint.correct` | W6 批量补挂纠偏待办 |
| POST | `/corrections/:id/confirm` | `complaint.correct` | W7 纠偏确认 |
| POST | `/corrections/:id/reject` | `complaint.correct` | W8 判定无需纠偏 |
| POST | `/dispatch/orders` | `dispatch.create` | W9 创建交办 |
| POST | `/dispatch/orders/:id/cancel` | `dispatch.cancel` | W10 受控撤销（basis 必填 + 到人） |
| POST | `/dispatch/orders/:id/push` | `dispatch.push` | W11 推送交办 |
| POST | `/dispatch/orders/:id/repush` | `dispatch.push` | W12 重推交办 |
| POST | `/dispatch/orders/:id/archive` | `dispatch.archive` | W13 交办归档 |
| POST | `/dispatch/orders/:id/preflight` | `dispatch.push` | integration readiness |
| GET | `/dispatch/orders/:id/reporting-result` | `dispatch.read` | authorized reporting result |
| GET | `/dispatch/orders/:id/reporting-attachments/:id` | `dispatch.read` | authorized reporting attachment |
| POST | `/dispatch/orders/:id/reconcile` | `dispatch.reconcile` | integration reconciliation |
| GET | `/users` | `system.users.manage` | U1 用户列表（原 501 桩已摘除） |
| POST | `/users` | `system.users.manage` | U2 建号（bcrypt 入库，口令不回显） |
| PATCH | `/users/:id` | `system.users.manage` | U3 改角色/姓名/启停（无删除端点） |
| GET | `/dicts/sensitive-words` | `system.dict.manage` | D1 敏感词管理列表 |
| POST | `/dicts/sensitive-words` | `system.dict.manage` | D2 新增敏感词 |
| PATCH | `/dicts/sensitive-words/:id` | `system.dict.manage` | D3 编辑/启停敏感词 |
| POST | `/dicts/sensitive-words/rescan-preview` | `system.dict.manage` | D4 历史重扫预览 |
| POST | `/dicts/sensitive-words/rescan` | `system.dict.manage` | D5 确认历史重扫 |
| POST | `/address-candidates/backfill-preview` | `system.address.backfill` | 地址候选存量预览 |
| POST | `/address-candidates/backfill` | `system.address.backfill` | 地址候选存量补提取 |
| POST | `/external/tianbao/status-callback` | `system.integration.manage` | X1 旧轮询回调（501 桩；它在 requireAuth 之后，仍需 Bearer） |
