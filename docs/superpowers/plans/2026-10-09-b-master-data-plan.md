# gqxq B 主数据与分类 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户已授权拆分并交由 GPT-6.1 Sol / High 子代理执行；逐任务开发、独立复核。

**Goal:** 交付真实可维护的通用字典、业务分类、企业和服务网格，并提供统一的基础数据模板、校验预览与导入，供办理及统计复用。

**Architecture:** 优先扩展已存在的数据表和读取服务，以版本和生效期保留历史。行政网格、企业服务网格及小区明确建模，空间关系校验与用户授权分开。

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

- 全部停用字典项后枚举回退使选项复活：B1 区分未配置与全部停用。
- 启用中的子类关联停用父类：B1 校验整条父级链。
- 户数变更重算历史每万户指标：B2 保存生效期及版本。
- 多对多覆盖造成重复诉求：B3 校验关系唯一，D1 按诉求键聚合。
- 缺几何被渲染成默认范围：B3 明示边界缺失，不生成替代边界。
- 预览后有人修改记录，或重复确认同一批次：B4 检查目标版本与引用依赖，失效预览重新生成，批次执行幂等。

## B1 通用字典与正式大小类（SQ-07/11）

**文件：**
- 扩展 `server/src/repositories/dictRepo.ts`、`routes/dicts.ts`，新增 `services/dictService.ts`、`services/categoryService.ts`。
- 修改 `services/correctionService.ts`、`repositories/complaintMapper.ts` 及分类 DTO。
- 修改 `packages/web-admin/src/views/DictManager.tsx`，新增 `components/CategorySelector.tsx`，接入诉求详情及纠偏表单。
- 测试 `server/tests/dictionary-governance.test.ts`、`category-correction.test.ts`；新增字典版本、父项、排序、业务分类列及引用查询所需迁移。

**接口与决定：**
- `DictionaryService.saveType(input, ctx)`、`saveItem(input & {expectedVersion:number}, ctx)`、`setItemStatus(code, enabled, expectedVersion, ctx)`；类型定义放 `server/src/types/masterData.ts`。
- 现有 `GET /dicts/:code/items` 保持兼容；新增受管理权限保护的 `/dict-types`、`/dict-types/:code/items` CRUD 和引用查询。
- `CategoryRef = {majorCode:string; minorCode:string|null; dictionaryVersion:string}`。
- `validateCategory(ref, {forNewSelection:boolean}): Promise<void>` 服务端校验类别、父子关系、启用状态及版本；独立保存来源分类、有效大小类和既有诉求性质。
- 业务字典可维护，状态机枚举仅展示说明，不允许通过通用字典页任意增改状态流转。
- 有引用的类型/条目禁止物理删除；未引用草稿可删除，发布项停用并保留历史。编码唯一且不复用；停用父项的子项处理必须显式确认。
- 对已在分析库中的诉求重分类，保留入库门槛；追加有效分类修订历史。D1 明确实时分类与历史快照统计方式，旧报告不变。
- 不自动将旧 complaint_type 转成未经业务确认的大小类；历史缺失显示未分类。真实批量映射另有预览和明确执行决定。

- [ ] 编写用例：编码重复、父子环、非法父项、父停子启、停用项新选失败、旧引用可读、全部停用不回退默认值、两窗口版本冲突。
- [ ] 在 server 运行 `npx --no-install tsx --test tests/dictionary-governance.test.ts tests/category-correction.test.ts` 确认失败。
- [ ] 完成维护 API 和真实页签，前端级联清除不兼容小类；纠偏写入使用 A1 版本和保护规则，权限使用 A5 的 `system.dict.manage`。
- [ ] 同命令、既有敏感词测试、类型检查通过；在虚构样本验证费用改气压后同口径分组减一加一且总量不变，旧报告仍保持原分类版本。
- [ ] 留存 UI、持久化及重启证据，独立提交 `feat: govern dictionaries and version complaint categories`。

## B2 企业档案及服务户数（SQ-08）

**文件：**
- 扩展 `repositories/enterpriseRepo.ts`、`routes/enterprises.ts`，新增 `services/enterpriseService.ts`。
- 修改 `packages/web-admin/src/views/CompanyList.tsx`、`api/enterprises.ts`。
- 新增 `server/tests/enterprise-management.test.ts`；增量扩展企业字段、企业部门映射、服务户数生效版本与变更审计，先核验基线已有列。

**接口与决定：**
- 在既有读取基础增加 `POST /enterprises`、`PATCH /enterprises/:enterpriseCode`；使用登记编码为稳定键。
- `EnterpriseWriteInput = {enterpriseCode:string; enterpriseName:string; businessType:string; status:'enabled'|'disabled'; expectedVersion?:number}` 为最低必填；联系人等附加字段按 Q3 清单约束。
- `HouseholdVersion = {enterpriseCode:string; households:number|null; validFrom:string; validTo:string|null; version:string}`；输入非负整数，时间段不交叠，null 表示未知。
- `getHouseholdsAt(enterpriseCode, date): Promise<HouseholdVersion|null>` 供 D1 使用。期末/期均选择由 Q3 决定，不在查询中偷偷换算法。
- 部门映射以来源系统+来源部门码为键，名称作展示，未核验别名不自动合并企业；政府机构与企业主体分清。
- 有交办、网格、统计引用时只允许受控停用；历史交办目标及报告快照不跟着名称修改重写。
- 企业维护使用显式管理能力，经营数据查看仍受 A2 范围约束；授予企业管理不意味着自动获得所有诉求原件。

- [ ] 编写测试：新增后重查、重复编码、未知引用、负数/小数户数拒绝、生效期交叠拒绝、已引用企业不能无痕删除。
- [ ] 在 server 运行 `npx --no-install tsx --test tests/enterprise-management.test.ts` 确认失败后实现真实 CRUD、户数版本及部门映射。
- [ ] 验证 10 件/20000 户×10000=5 件每万户；0/null 分母返回不可计算和原因；修改户数后按旧时间取值不变。
- [ ] 同命令和类型检查通过，回归 A3 企业校验、交办选单和新停用企业的可选状态。
- [ ] 留证并独立提交 `feat: maintain enterprise master data and household history`。

## B3 企业服务网格与空间关系（SQ-10）

**文件：**
- 新增 `repositories/serviceGridRepo.ts`、`services/serviceGridService.ts`、`routes/grids.ts`。
- 修改 `routes/index.ts`、`routes/legacy.ts`，真实实现后才摘除 /grids 501。
- 修改 `packages/web-admin/src/views/GridManager.tsx`，新增 `api/grids.ts`、`components/GridBoundaryPreview.tsx`。
- 新增 `server/tests/service-grid.test.ts`；按已存在表设计增量关系和有效期迁移，不能凭注释重复建表。

**接口与决定：**
- `ServiceGridInput = {code:string; enterpriseCode:string; businessType:string; adminGridCodes:string[]; communityCodes:string[]; validFrom:string; validTo:string|null; expectedVersion?:number}`。
- `GridCoverage = {serviceGridCode:string; adminGridCodes:string[]; communityCodes:string[]; version:string; geometry:GeoJSON|null}`。
- `saveServiceGrid(input, ctx): Promise<GridCoverage>`；读取和写入遵守 A2 范围。
- 行政网格、小区为有稳定编码的主数据；从权威资料导入或受控维护，不能从文本候选自动创建。没有授权边界数据时返回 geometry=null。
- 企业服务网格与行政网格是不同对象；重复关系拒绝/规范去重，类型不符、小区不属关联行政网格拒绝，覆盖变更保留有效期。
- 几何预览沿用已批准地图供应商；先确认坐标系和资源许可。空间计算中统一坐标系，不把 WGS84/GCJ02 等坐标直接混用。

- [ ] 测试 G1/G2、X/Y 关系保存与重载、类型冲突、小区归属不符、同企业多网格、旧版本冲突、范围变更后旧覆盖可查询。
- [ ] 在 server 运行 `npx --no-install tsx --test tests/service-grid.test.ts` 确认失败后实现维护和真实边界预览。
- [ ] 验证缺几何明确提示；重叠覆盖不自动判唯一网格；未授权用户不能通过替换网格码读取边界。
- [ ] 同命令、类型检查及 API/DB/重启核对通过。
- [ ] 留证并独立提交 `feat: maintain versioned enterprise service grids`。

## B4 基础数据模板与统一导入（SQ-07/08/10/11）

**依赖：**A2/A5 的对象和功能权限、A6 的操作日志，以及 B1—B3 的业务校验与版本规则。各类模板可先编制；正式执行入口在相应主数据写入服务完成后接入。

**导入范围：**

| 数据类型 | 文件格式 | 模板内容与稳定键 |
|---|---|---|
| 企业、责任单位及来源部门映射 | XLSX、CSV | 经 Q3 确认的对象类型、单位编码、名称、业务类型、别名、状态；部门映射以来源系统＋来源部门码识别，不按姓名或名称自动合并主体 |
| 企业服务户数 | XLSX、CSV | 企业编码、非负整数户数、生效起止日期；沿用 B2 的有效期版本规则 |
| 通用字典、正式大小类 | XLSX、CSV | 类型编码、条目编码、名称、父项编码、排序、状态；不导入业务状态机枚举 |
| 行政网格、小区 | XLSX、CSV | 网格或小区编码、名称、所属区划、父级关系；编码按文本读取，保留前导零 |
| 企业服务网格和覆盖关系 | XLSX、CSV | 企业服务网格编码、企业编码、业务类型、生效期；覆盖关系独立模板，一行一条网格或小区关联，不用自由文本逗号列表 |
| 网格边界 | GeoJSON | 按既有网格编码绑定 Polygon/MultiPolygon；声明来源坐标参考及转换信息，沿用 B3 的空间校验，不以几何上传创建未知网格 |

XLSX 模板含字段说明、必填约束、枚举说明和虚构示例；数据页与说明页分开。CSV 提供同版字段说明，默认 UTF-8；编码不能可靠识别时明确报错。GeoJSON 模板提供虚构边界及坐标说明。模板有版本号，旧模板不兼容时返回可理解的错误与新模板入口。

**用户操作：**下载模板 → 填写上传 → 校验预览 → 核对新增/更新差异 → 确认导入 → 查看批次结果和错误明细。

**文件：**
- 新增 `server/src/types/masterDataImport.ts`、`services/masterDataImportService.ts`、`services/masterDataImportParser.ts`、`repositories/masterDataImportRepo.ts`、`routes/masterDataImports.ts`。
- 新增 `server/templates/imports/`、`packages/web-admin/src/api/masterDataImports.ts`、`components/MasterDataImportDialog.tsx`、`views/ImportBatchList.tsx`。
- 在字典、企业、网格维护页面增加模板和导入入口；登记 `masterdata.import` 权限及批次/错误文件下载范围。
- 新增 `server/tests/master-data-import.test.ts`、`master-data-geometry-import.test.ts`；批次、校验结果、预览版本和执行结果采用增量迁移。解析依赖在实施时核验并锁定，本次只编制方案。

**接口与执行规则：**
- `MasterDataImportKind = 'enterprise'|'department_mapping'|'household'|'dictionary_type'|'dictionary_item'|'category'|'admin_grid'|'community'|'service_grid'|'grid_coverage'|'grid_boundary'`；每个批次只处理一种模板类型，按 B1—B3 的引用依赖顺序导入。
- `ImportPreview = {batchId:string; templateVersion:string; previewVersion:number; expiresAt:string; counts:{total:number; create:number; update:number; unchanged:number; error:number}; canCommit:boolean}`。分页差异明细包含工作表、行号、业务键、动作、旧新值及逐字段错误。
- `ImportBatchResult = {batchId:string; state:'succeeded'|'failed'; created:number; updated:number; unchanged:number; failureReason:string|null; completedAt:string}`。失败批次 created/updated 均为 0，不能将预览数量当作执行成功数量。
- `previewImport(file, kind, ctx): Promise<ImportPreview>` 只保存批次暂存和校验记录，不写主数据；复用相应业务服务的校验，覆盖文件内和数据库中的重复编码、父子环、无效引用、户数及有效期冲突。
- `commitImport({batchId, previewVersion, requestId}, ctx): Promise<ImportBatchResult>` 在执行前重新校验当前权限、文件哈希、目标记录与依赖版本；任一变化使预览失效，返回 409 要求重新预览，不能静默套用旧确认。
- 路由：`GET /master-data/import-templates/:kind`、`POST /master-data/imports/preview`、`GET /master-data/imports`、`GET /master-data/imports/:batchId`、`POST /master-data/imports/:batchId/commit`、`GET /master-data/imports/:batchId/errors`；全部挂在现有鉴权之后。
- 按稳定业务键新增或更新，名称只作展示和校验。更新先展示差异；文件中不存在的记录不自动删除或停用，空值清除必须通过模板明确字段规则，不能把缺列当清空。
- 一期采用“全量校验通过后整批事务提交”：有任意错误则修正文件后重新预览，不提供不透明的跳过错误行写入。执行失败整批主数据回滚，失败批次结果另外持久化；批次成功标记与主数据写入处于同一事务。
- 同一批次只能成功提交一次；同幂等键同请求返回原结果，不同请求返回冲突。响应丢失时通过 batchId 查询恢复；新批次重新上传相同数据应预览为不变，不重复新增或伪造版本。
- 保留每次变更的前后值、规则版本、操作者和结果；已引用主体、字典、网格沿用停用及历史保护。需要撤销已成功导入时通过经校验的新修正批次处理，不能无条件覆盖此后人工修改。
- 建议一期限制单文件 10 MiB、每批 2000 数据行；超限拒绝并提示拆批。XLSX 解压后体积、工作表、单元格及 GeoJSON 顶点数另设服务端硬限额，实施时形成配置表并通过超限测试。
- 不执行单元格公式、宏或外部链接；公式单元格明确拒绝。错误文件和结果下载按纯文本转义，防止公式注入；临时文件由服务端标识定位，客户端文件名不参与磁盘路径拼接。
- 上传、确认和结果下载均要求 `masterdata.import` 加相应模块维护权限，并核对对象范围；首次新增对象也必须验证其父级/企业范围。只能查看本人批次，或由具备明确全域导入管理权限的管理员查看其他批次。
- 原始上传文件和错误明细按配置保留至有效期；错误明细只输出纠错所需字段，下载不可绕过授权。停用角色或收回权限后不能继续确认或下载旧批次。

- [ ] 准备每类模板的虚构成功和失败文件；测试前导零编码、重复编码、无效父项/环、未知企业、负数/小数户数、生效期交叠、覆盖关系冲突及坐标系错误。
- [ ] 在 server 运行 `npx --no-install tsx --test tests/master-data-import.test.ts tests/master-data-geometry-import.test.ts`，记录新增用例在实现前的失败。
- [ ] 完成模板、上传解析、预览差异、服务端确认、批次查询及页面，复用 B1—B3 规则；验证预览前后主数据行数与版本完全不变。
- [ ] 验证两次确认不重复执行、预览后人工改动返回 409、批次事务中途失败零主数据写入、响应丢失后可查成功结果、相同文件再次上传为不变。
- [ ] 验证上传/下载越权、权限收回、公式单元格、伪扩展名、损坏文件和体积超限被正确处理；GeoJSON 自交或非法几何被拒，不生成替代边界。
- [ ] 重跑上述测试、根目录 `npm run typecheck` 及 B1—B3 受影响回归；页面导入后刷新及服务重启，记录与批次结果一致，历史统计仍按旧主数据版本解释。
- [ ] 留存字段模板说明、导入操作步骤、逐行错误样例和验收证据，独立提交 `feat: import validated and versioned master data`。

## B 批验收出口

字典、企业和网格页面均使用真实接口；一项修改能在刷新和重启后复查。分类、户数、覆盖各有历史版本，既有敏感词和交办规则回归通过。B4 的 XLSX/CSV 模板、GeoJSON 边界、校验预览、显式确认、批次结果与错误明细均有验收证据，且不影响既有诉求数据。系统管理五项中的“字典”在本批闭环。


