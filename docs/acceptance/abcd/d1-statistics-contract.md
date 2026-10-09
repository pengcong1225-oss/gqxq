# 统一候选统计接口（D1）

统计结果使用 `candidate-calendar-v1`，始终标为“待业务确认”。服务器不接受客户端把政策状态改成正式批准。正式满意率仍未知。此批没有部署、业务库迁移或真实外发。

`GET /api/v1/statistics/summary` 与 `/statistics/complaints` 使用同一 `StatisticsQuery`。必传 `dataset=ledger|analysis`、`projection=current|entry_snapshot`、`periodKind=month|quarter|year|custom`、`from`、`to`、`comparisonPolicyId=candidate-calendar-v1`。ledger 只支持 current；analysis 必须显式选择已入库集合的当前有效字段，或实际入库快照。

日期是上海业务日，含首尾两日，转换为半开时间区间。SQL DATETIME 及 driver 按上海墙钟/+08 读取，不重复转换。结束日不能晚于上海今日，单次最多 3660 日。月、季、年必须从期间首日开始；当前期页面明确提交“截至今日”，不会隐式裁剪输入。完整月同比去年同月、环比上月；完整季同比去年同季、环比上季度；年度同比上年，年度环比未定义。部分日历期间从基期首日取相同已过日数，到基期期末截短并披露实际日数。自定义同比两端回退一年（闰日夹至二月末），环比取前一等长区间。基期真实为零或数据不完整时变化率返回 null 和原因。

业务时间使用既有规范化 `source_reported_at`；缺失或无效时回落 `received_at` 并计数。这是候选来源填报口径，不代表来源时间经过认证。`source_updated_at` 不参与业务时序。旧分析入库记录没有日期快照时，日期统计排除并返回 `dateFilterUnavailableCount`、排除原因和 partial，不能拿当前字段冒充历史快照。旧分类、位置缺失继续显示未知。

可选稳定编码筛选为 `businessType`、`majorCode`、`minorCode`、`enterpriseCode`、`districtCode`、`serviceGridCode`。图表下钻额外传 JSON `bucket`，保留 dimension、code（未知为结构化 null）；分类桶还须传 level=major|minor 和 dictionaryVersion（未知显式 null）。所有卡片、趋势、维度和明细使用同一规范化查询及当前诉求权限范围。明细 `page`、`size` 保持已有分页边界。单次授权数据集超过 10 万条明确拒绝，不能截断后声称完整统计。

网格归属只由所选 projection 的业务日、成对且来源明确的 WGS84 点、该日实际有效的授权覆盖证据证明。声明的行政网格/社区和今日位置校验不是历史覆盖证明。draft、缺坐标/坐标系/来源/几何的记录仍保留总量并显示未定位。重叠网格保留全部命中，逐桶 distinct，桶不可相加；总量按稳定诉求键 unique，并给出 multiGridCount。服务网格读取同时要求当前对象及实际历史覆盖的全部区划授权。

户数使用所选 `to` 的 B2 历史区间、数量和版本，候选名称为“期末完整企业人口”。局部区划/网格范围、主数据无权、缺区间、未知和零分别返回 null 及原因。企业管理区划不能证明人口归属。事件分类筛选可以在可证明完整企业人口中算该类事件每万户数；总体多企业人口未证明无重叠，整体率仍为空。

新接口必须具备 `statistics.read`，ledger 另需 `dashboard.read`，analysis 另需 `analysis.read`，明细再需 `complaint.read`。首次迁移按实际内置角色既有能力矩阵补统计能力，重跑不会恢复被撤销的授权。自定义角色须显式补授；页面使用相同有效能力控制查询、下钻和明细。所有对象仍受当前范围限制。

旧 `/dashboard/overview?days` 保留 DTO，days 规范化为 ledger/current/custom 范围，所有面板共享该范围并追加 query/统计元数据。旧 `/analysis/records` 无日期请求保留原入库列、筛选、分页和排序（包括年代久远、日期未知的成员），追加 `legacy-membership/no-date` 元数据。它仅用于入库记录浏览，不计算有日期比较；传新统计参数清晰拒绝并指向新接口。代价是保留一个仅旧列表使用的无日期兼容分支。

后续 D2/D3 直接复用 `server/src/services/statisticsService.ts` 的 `captureStatistics` 和 `captureStatisticsIn`，以及 `server/src/types/statistics.ts`。前者拥有单一 READ ONLY REPEATABLE READ 事务；后者要求调用方传入同一读快照 executor。返回 summary、当期全部安全 rows、current/yoy/mom 实际 `periodFacts`（含 excludedRows 原因）、实际分类字典快照、授权历史覆盖几何/版本/原及当前归属、户数证据、全部统计贡献诉求的原及当前 `scopeFacts`。无原始来源 payload，不以 IDs 重新查询冒充冻结值。D3 仍须对冻结的全部原范围事实和当前对象再次授权；本批不实现报告 render/jobs。

审查修复后，内部 capture 还返回 `masterScopeFacts: {enterpriseCode:string; districtCode:string|null}[]`。这是通过同一 executor 读取并实际核验授权的户数企业 master 原归属；既不是诉求区划，也不是冻结后的当前企业值。确实未知的区划保持 null，不存在/没有主数据能力/主数据对象无权时不造 scope 事实，rate 保留相应不可用原因。该字段只属于内部冻结 DTO，不进入公开 summary 或前端户数 DTO。D3 必须分别检查冻结 master 原事实和当前企业 master 事实，不能凭投诉 scope 推断。

覆盖读取按当期/基期交叠版本批读，实际业务日对区间复用；同一次 capture 缓存当前关系、admin 区划、人口组合/日期区间和一次验证后的几何。覆盖 SQL 次数不随网格乘业务日增长，新统计及旧 dashboard 趋势均单遍聚合。保守资源边界会明确拒绝整个请求：相关企业/业务组合最多 200；候选交叠覆盖版本最多 1000；实际读取覆盖快照总量最多 4MiB；当前+历史 admin 引用最多 4000；实际相关几何顶点最多 100000；人口组合/业务日版本检查最多 2000000；点位与候选几何顶点检查最多 10000000。已有诉求数 100000、日期 3660 日界限仍在；所有边界均拒绝而不截断统计或证据。它们是本地保守资源控制，不代表生产性能承诺。
