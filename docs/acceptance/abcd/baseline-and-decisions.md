# A—D 开工预检报告

日期：2026-10-09。只读检查五份计划、spec-source.txt、代码与 `009f40a..a564e3e`；本预检未运行测试、迁移、服务、数据库或外部接口。仅写本报告；不修改代码、计划、索引、分支或真实数据。

## 基线与结论

- HEAD：`a564e3ec18a9af1e5dd1b3a1b19cd38f889d8f43`，父提交为 `009f40afa93112c3f9cc6faf350fb701c0b52645`；当前分支 `codex/abcd-delivery-20261009`，本机远程引用 `origin/feature/public-utility-integration-20261003` 包含该提交。五份计划为既有未跟踪文件。计划中“新提交尚未取得”的描述已过时，应由协调者更新。
- 差异共 25 文件，643 增/213 删。A3 的回调绑定与 C4 的请求快照、回调重放、已有任务结果对账已部分覆盖；不能重复从零开发，也不能据此判定完整 A3/C4 已验收。
- 17 项数量与 A6+B4+C4+D3 一致，范围与用户授权一致：E/F 延后，钉钉以后复用其他项目，不重导诉求，不批量刷新当前数据，不改变既有纠偏/交办/分析准入/人工办结规则。
- 可立即开展纯规则、服务框架、DTO、页面与假传输开发。缺真实 MySQL/外部契约只阻断相应落库、真实联调和发布证据，不阻断其余 A—D。
- 协调者已告知：本基线根 `npm run typecheck` PASS；9 个无需真实 DB 的测试文件共 100 项 PASS，reporting mock 有既有 callback audit 警告。此为协调者运行结果，本预检未复跑。新任务测试文件目前尚未存在。

## A1 必须先明示的实施裁决（建议协调者记录后开始）

| 问题与证据 | 建议裁决 | 不应默默采取的替代 |
|---|---|---|
| `correctionService.decide` 已有 complaint→correction 锁序及 pending 状态互斥，但无客户端 expectedVersion；A1/B1/C2 会同时改有效值 | 新增 complaint 级 `edit_version` 作为共同编辑版本；详情/纠偏读取返回它。确认、判定无需纠偏及有效值修改在同事务校验并递增；缺版本 400，旧版 409，页面保留输入。只更新来源快照时是否递增应在 DTO 中明确，建议只有效值/决定变化递增 | 将单纠偏项 pending 检查当成两窗口旧内容保护；不同模块分别创建不兼容版本 |
| correction 字段键与列不同：`summary→title`，`district_name` 与 `district_code` 成对；经纬度目前分项 | 从 `CORRECTION_FIELD_DEFS` 建立明确映射；区域成对保护、经纬度按位置组保留，后续 C2 共用；新增正式大小类也接入同策略 | 只按字段字符串匹配导致 title/区码漏保护 |
| `confirmed` 和 `rejected` 均为已处理；`rejected` 含义是“无需纠偏”。记录 oldValue 是清单生成时旧值，不必等于决策时有效值 | 新决定在持有 complaint 锁时保存当刻有效值、来源版本/摘要、决定版本；已确认但无 newValue 也保护决定当刻有效值。旧记录按纠偏+字段版本证据推导，不能证明时保持现值并标待核验 | 用旧清单 oldValue 恢复 rejected 的值；将所有旧记录默认未确认；自动覆写真实历史数据 |
| `intakeService` 变包直接遍历 REDELIVERY_UPDATABLE_COLUMNS，address/title/分类/区域/坐标仍在名单；a564e3e 未改此路径 | 来源快照及差异继续保存；有效字段通过纯 `EffectiveFieldPolicy` 判定；人工已确认/无需纠偏保留，不可判定则 hold_for_review 并记录原因 | 因已有 corrected_address 保护就认定 address 已受保护；吞掉原始来源证据 |
| 当前 `source_updated_at` 在 intakeService 取 receivedAt；来源顺序契约不可证明 | receivedAt 只表示到达/快照时间。可信来源顺序缺失时显式 unknown，保留变包差异，不宣称后到包是较新来源；可信顺序具备后才比较版本/时序 | 把 source_updated_at 当对方业务更新时间；按接收时间回滚来源状态 |
| 本任务 hold_for_review 与既有纠偏门槛可能相互影响 | 保留原纠偏状态及分析准入；hold 为字段技术保护/异常证据，不自动重开已处理纠偏、不撤销历史分析、不批量重算 | 为保护字段而重新设计状态机或重新挂满全库待办 |

## 17 项实施状态与依赖

“保留”表示计划内部基本自洽且仍需实施；“收窄”表示已有代码覆盖部分工作。Q1—Q8 为局部口径裁决，不是再次批准全项目。

| 任务 | 判定/真实缺口 | 上游与关键裁决 | 验证重点 |
|---|---|---|---|
| A1 | 保留；已有事务/哈希/字段历史，缺有效字段策略和客户端旧版本保护 | 上表六项先定；迁移在现有 20261003 三项之后编号 | 同包/变包/旧包、confirmed/rejected、两窗口、回滚 |
| A2 | 保留；现有三档 RBAC 无对象范围，详情整包 sourcePayload | A5 授权解析；Q1 单规则企业×辖区交集、多规则并集、空拒绝；明确内置角色迁移范围 | 全入口同范围、撤权即生效、原件投影；包含新 reporting-result/attachment/reconcile 入口 |
| A3 | 收窄；回调关系校验已实现，直接 createDispatch 仍只取请求企业码名并写入，未复用主数据校验 | 复用 assignmentService 码名核验；Q8 合法改派边界；B2 之后补企业停用校验回归 | 未知企业、码名错配、历史轮次、签名有效但案件/企业错、重复事件；不要重建已存在绑定算法 |
| A4 | 保留条件项；新提交未增加宜接就办应用身份认证 | Q8 真实来源签名/网络契约；只做可验证的封闭边界，契约缺失不得自创协议开放 | 坏签名/代理头/重放用假传输；网关及公网实测单列待联调 |
| A5 | 保留；已有用户 CRUD、角色回查、末位管理员保护；缺动态能力目录/角色维护/改密会话版本 | Q1 一人一业务角色；明确内置 admin 的管理权与数据全域分别迁移 | 旧三档兼容、未知能力默认拒绝、最后管理员并发、改密/撤权、幂等初始化 |
| A6 | 保留；复用 operation_audit_log，缺分页查询/安全投影/页面 | A5 `system.audit.read`；A2 若日志含对象数据需共同范围规则；不将日志导出自动扩入范围 | 稳定分页、敏感数据投影、各模块新增动作可定位 |
| B1 | 保留；通用读取与敏感词完整链路已有，缺通用治理与正式分类版本 | A1/A5；Q2 编码/父子/停用；Q6 当前分类与分析快照分开 | 全停用不回落默认枚举、环/引用、重分类总量不变、旧报告不变 |
| B2 | 保留；企业读取真实，维护/户数生效版本/部门映射缺失 | A2/A5；Q3 字段清单及期末/期均；与 A3 共用有效企业查询 | 户数 0/null 原因、引用停用、生效期不重叠、历史解释 |
| B3 | 保留；/grids 501，外部基线已有 service_grid/grid_enterprise，不能重复建同义表 | B2/A2/A5；权威区划/小区编码、几何坐标系；关系版本先稳定 | 多网格覆盖、归属、重叠、范围授权、有效期、无 geometry 如实展示 |
| B4 | 保留；计划预览→确认→结果自洽；目前无相应导入链路 | A2/A5/A6+B1—B3；各服务需提供接受同一 Tx 的校验/写入接口 | 预览不写主数据、版本失效 409、全批事务、幂等、范围、公式/资源限额 |
| C1 | 保留；本地 timeline/新 reporting 轨迹不是来源全过程 | A1/A2；Q4 14/15 字段与节点 ID/版本；先查询详情/存储适配器，真实节点等待契约 | source_id 搜索、稳定分页、原/有效地址、空值、完整批次水位 |
| C2 | 保留；已有规则与天地图人工选点，缺位置组原子保存/层级校验 | A1 版本+B3 关系+A2；Q5 供应商替代/自动采纳；无边界不判坐标错误 | 坐标成对、区码名、小区网格、同名候选、地图失败人工处理、整组回滚 |
| C3 | 保留；来源满意度不等于回访，独立历史/幂等/更正缺失 | A2/A5；Q5 有效评价、主管权限与来源优先；无上游网格强依赖 | 未接通不计不满意、末次有效评价按案件去重、来源不覆盖、不改办理状态 |
| C4 | 收窄；已有持久不可变 push snapshot、重推与回调恢复；缺出站任务状态/租约/重启续发和首次未知查询 | A3/A2；Q8 对方 requestId+同 body 幂等及查询契约；复用 snapshot 不复制字节真源 | 发送前/发送后崩溃、多执行器、重复点击、unknown 与 failed 分开、附件类型/授权 |
| D1 | 保留；已有概览与分析分页，缺统一期间/明细/指标及范围 | A2+B1/B2/B3；Q3/Q6；满意度指标若使用需 C3 | 半开上海业务日、比较部分期、0 基期、来源回落、唯一诉求去重 |
| D2 | 保留；热力 endpoint 501+演示散点，缺规则发布 | A2/A5+B1+B3+D1；Q7 真值表确认后才能正式发布 | 450 候选例+300/600 端点共同自洽、整数定点、无规则、历史版本 |
| D3 | 保留；/reports 501；reportTodo 非正式报告，缺冻结数据/持久任务/渲染下载 | A2/A5+D1，按模板需要 B/D2 版本；Q6 格式/字段/留存 | 当前授权覆盖整快照、固定字节、失败恢复、路径/公式防护、真实 DOCX/XLSX 打开与视觉检查 |

## a564e3e 已实施能力与剩余边界

| 代码落点 | 已实施（源码证据） | 应保留/补验或新做 |
|---|---|---|
| callbackService.ts:438—469 | v2 按 assignmentId 精确查交办；v1 按已登记 taskId；relationError 校验 app/案件/企业/task，v2 加 request/assignment/item，存在快照时验证 scene/template | 历史晚到不会按“最新单”猜测；旧 misleading 查找注释应协调修正。A3 补真实 DB/多轮负向，不需强行新建 dispatchBindingService 才算交付 |
| callbackService.ts:477—604 | 未关联/逆序事件 pending 持久保存，sequence 顺序推进；重复/变内容拒绝；重放事件行和交办行加锁；全局 numeric keyset 游标跨 500 pending 公平轮转 | 重放是回调 inbox，不是出站 outbox。只证明代码/假 DB，不能代替真实死锁/重启验证 |
| dispatchPushService.ts:129,264—289 | 首次成功 readiness 后、外发前持久原始请求 body+hash；已有 snapshot 或旧 request log 恢复；新旧配置/诉求变化不重新构造；关联身份校验 | 保留 dispatch_push_snapshot 单一字节真源；C4 追加调度元数据而非第二份 body。当前行锁在 HTTP 发送前事务结束，不等于发送期间多执行器租约 |
| dispatchPushService.ts:294—366 | 同 requestId+字节，新 nonce/时间；created:false 有 taskId 视为成功；成功回填 task 并重放 pending | 当前最多三次同步尝试/手工 repush。无持久 sending/unknown/nextAttemptAt/lease、无 outbox 启动扫描；异常前后须补稳定状态恢复 |
| reportingEvidenceService.ts / index.ts | 已知 taskId 的签名 state 对账、固定分页快照+durable cursor，启动/定时 pending 与开放任务扫描；证据面板、结果/附件路由 | queryContext 要求已登记 taskId，不能恢复“已创建但 taskId 未回填”的首次未知。Q8 确认按 requestId 查询或同体幂等后复用 |
| reportingAttachment | 附件必须属于 applied 提交版本，固定签名服务端取件、禁重定向、20 MiB、大小/hash核对 | A2 对象/字段权限目前缺失，真实 MIME/内容验证未见；前端结果 events 整包 payload 也需投影。不可把它当任意 URL 下载器 |
| publicUtilityClient / env / payload | context path 签名、禁重定向、响应限额，配置化 scene/template/approval/subscription，v2 assignment/sourceContext/sourceAttachments | 16 字段白名单与真实对方版本仍需契约对账；已有本地实现不是对方书面幂等保证 |
| 三个新增迁移 | 20261003100000：dispatch_order sequence/item/reconciledAt + dispatch_push_snapshot；110000：event cursor；120000：integration_replay_cursor | 不重占编号，不重复建表；迁移执行尚无当前 MySQL 证据 |

## 共用文件与接口协调规则

| 共用面 | 任务 | 建议协调者明确的归属/顺序 |
|---|---|---|
| correctionService/correctionRepo/complaintMapper；ComplaintDetail/AddressCorrection | A1、B1、C1/C2 | A1 先定义 editVersion 与有效字段映射；B1 接分类；C1 扩投影；C2 接组保存。单一锁序/版本，不并行覆盖同段 |
| auth/requireAuth/requireRole/userRepo；UserManager | A5、A2 | A5 resolveAuthorization→A2 resolveAccessContext；可以先固定接口但合入按顺序。roles 数组是兼容 DTO，不默认支持多角色 |
| rolePolicy、permissionCatalog、routes/index、legacy、菜单 | 全部 | 协调者统一登记能力与路由；尤其已有 reporting 四条新路由加入 A2，摘 501 时避免旧 handler 抢占；RBAC 文档/断言与旧 admin 全量放行同步升级 |
| server/src/types/api.ts 与 web-admin/src/types/api.ts | 全部 | 服务端 DTO 真源；a564e3e 只改服务端 api.ts，须核对前端内联/镜像。复杂 DTO 可独立导出，禁止各模块自行发明同义 shape |
| enterpriseRepo/assignmentService/dispatchService | A3、B2 | A3 先复用当前真实读取核验；B2 后将 enabled 语义共享化，旧交办/快照保持历史码名 |
| dispatchPush/callback/reportingEvidence/DispatchOrders | A3、A2、C4 | 保留现有签名/ACK/sequence/inbox；A2 加范围投影；C4 扩出站租约恢复，不混同入站重放和出站待发 |
| master-data import→主数据 service | B1—B4 | 业务服务提供显式 tx 参数，禁止导入事务中调用自开事务；批次成功标记同事务，失败记录另事务 |
| statisticsQuery、网格/户数/分类版本、report snapshot | B1—B3、C3、D1—D3 | 数据集显式 ledger/analysis；D1 单一 normalize/scope；报告冻结实际计算字段而非仅 ID；网格关系 join 后 distinct 稳定诉求键 |
| migrations/验收 runner | 全部 | 统一递增编号/迁移清单；已有外部19表、service_grid/report_record 不重复造。verify-abcd 仅登记明确隔离用例 |

建议顺序：A1/A3 可先做 → A5 → A2/A6 → B1/B2 → B3 → B4 → C1/C2/C3/C4 → D1/D2/D3。A4 从头登记契约并保持封闭，缺契约不阻塞其余开发；C3 无需等 B4，D 草稿和虚构模板可提前准备。上述是依赖建议，不在本预检修改总方案。

## 测试分类及可执行范围

| 类型 | 当前入口/命令 | 环境与限制 |
|---|---|---|
| 无 DB 静态 | 根 npm run typecheck；npm run gate（读取源码） | 协调者已报告 typecheck PASS；本预检未跑。gate 不是业务验收 |
| 无 DB 规则/假仓储 | server 下 `npx --no-install tsx --test tests/address-extraction.test.ts tests/location-extraction.test.ts tests/location-clue-repo.test.ts` | 纯规则/传入假 Queryable；仍按文件检查 env import |
| 无真实 DB，需显式虚构配置/替身 | address-candidate-intake/detail/backfill；reporting-integration、reporting-pagination、integration-audit-regressions | Pool 被 mock，fetch 被 mock；不运行服务入口。reporting 测试主动 nonexistent dotenv；地址测试静态 import pool，启动命令显式给无效 dotenv 路径和虚构 DB/JWT，避免读取真实配置 |
| 前端无 DB | `npm run verify:workflow-navigation` | UI 测试独立；不把 UI PASS 当 API/落库 PASS |
| 显式 MySQL | reporting-integration-mysql、pending-replay-mysql | 强制 `GQXQ_DB_NAME=gqxq_rehearsal_20261003`；需外部基线+所有增量+REHEARSAL-C1 fixture；写入事件/交办/游标。reporting MySQL finally 未清理全部 business_event/audit，应在一次性测试库运行，不能声称零残留 |
| 显式 MySQL 集成 | sensitive-word-management；verify:rbac | 敏感词直接创建 MySQL pool（不是无 DB 测试）；RBAC 默认自起测试实例并写入。必须核验 host/库名、构建入口和外发替身 |
| 需逐脚本审查 | verify:hardening、acceptance:g1—g4、来源适配器 | 不 broad-run：脚本可能起实例/读写本地服务或库；先登记参数和隔离保护 |
| 新任务测试 | 计划中的 A1—D3 新测试文件均待建立 | 规则/适配器/假事务可先测试；事务/锁/索引/重启另设 MySQL 文件，不能 mock 假装真实落库 |

根 `npm run verify` 会执行 sensitive-word-management，不能作为“无 DB 全套”直接运行。协调者最初报告本机无 GQXQ 环境变量/.env；随后使用相邻项目配置验证本机 MySQL 连接，用户授权新建本地测试库，空库 `gqxq_rehearsal_20261003` 已建立。仍缺 canonical V1/V3/V8，空库尚不具备业务迁移/落库验收条件。本预检不读取/输出凭据，不建立伪造19表来绕过 M0。

## 外部契约与真源（局部阻断范围）

| 真源缺口 | 可先实施 | 仅待确认/待联调部分 |
|---|---|---|
| 正式合同/已核准业务规则；spec-source 是差距报告，不是合同原文 | 按用户 A—D 授权与既定流程实施框架、虚构验收样本 | Q1—Q7 的业务差异正式验收口径；不得把技术标建议自动当承诺 |
| 外部 zhuxin-platform Flyway V1/V3/V8（M0 明确要求19表+uk_source） | 增量迁移设计、类型和假事务测试 | 当前真实 MySQL DDL/索引/迁移/重启证据；整体恢复仍属 F |
| 来源节点/日期/认证契约 | C1 DTO、存储、适配器、查询；A4 边界测试 | 节点 ID/version/顺序、14/15字段、完整性水位，真实认证和公网开放 |
| public-utility v2/历史单/改派/查询/同体幂等 | 复用现有协议框架、精确绑定、出站持久恢复与假传输 | 首次未知按 requestId 查询、书面幂等依据、真实附件/结果/ACK 对账；不要重设旧状态机 |
| 正式字典/企业部门映射/历史户数/空间资源 | B 版本治理与统一导入、候选和无几何界面 | Q2/Q3/Q5、授权边界/坐标系/地图替代，禁止编造正式数据 |
| 热力端点/统计/模板 | D 草稿、规则策略接口、双数据集筛选、冻结和虚构文件 | Q6/Q7 正式 policyId、真值表、格式/留存；未确认规则不发布 |
| 钉钉其他项目身份 | 本地 app_user 权限/会话/账号管理 | 未来可信身份绑定与停用传播复用验证；本轮不建扫码免登/通讯录/批量人员 |

协调者已接受 A1 版本/保护/锁序裁决，将写入实施 brief。建议同时记录 A3/C4 收窄裁决并推进框架实施；保持未验证状态准确，只让缺口阻断对应真实验收项。

## 协调者实施裁决与分配

用户已授权执行 A—D，所有开发/复核均使用 GPT-6.1 Sol / High。上文 A1 六项建议和共享接口顺序全部采纳；A3 收窄为企业校验和绑定补验，C4 复用不可变 snapshot 追加出站任务管理。按 A1 → A3 → A5 → A2 → A6 → A4 → B1 → B2 → B3 → B4 → C1 → C2 → C3 → C4 → D1 → D2 → D3 执行，每项独立提交与复核。

可逆默认采用计划建议；真实字典/业务口径/外部契约不得伪造。A4 认证协议与 D2 规则正式发布仍受对应真源约束；开发框架与待联调结果分别记录。当前主工作区保持原状，实施分支 codex/abcd-delivery-20261009 位于 .worktrees/abcd-delivery-20261009。

迁移预留：A1 20261009010000；A3 020000（如需要）；A5 030000；A2 040000；A6 050000；B1 070000；B2 080000；B3 090000；B4 100000；C1 110000；C2 120000；C3 130000；C4 140000；D1 150000；D2 160000；D3 170000。同任务若多文件按秒递增，不覆盖已有编号。
