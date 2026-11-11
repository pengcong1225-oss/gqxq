# 诉求大屏只读接口

本文描述本地实现，未代表线上部署或真实数据验收。API 前缀 `/api/v1`，成功封套 `{code:200,message,data}`。仅 GET；沿用 Bearer 会话、动态角色及用户范围，所有接口至少需要 `statistics.read`、`dashboard.read`、`complaint.read`。真实经营企业户数另需 `enterprise.read`；空间和网格比较需要 `grid.read`、`heatmap.read`；停供和施工事件分别需要 `shutdown.read`、`pipeline.read`。无身份 401、无权限 403，策略见 `src/auth/rolePolicy.ts`。

## bootstrap

`GET /screen/bootstrap?mode=simulation&from=2026-11-01&to=2026-11-10`

- `mode=real|simulation`，默认 real；模拟必须显式选择，失败不会切换模拟。
- 日期为上海时区包含首尾的 `YYYY-MM-DD`，默认当月截至今日；`periodKind=custom|month|quarter|year` 受既有日历验证约束。周期卡的 `periodAnchor` 为“截至所选日期”，不能称为当前年或昨日而不展示锚点。
- 全局可选 `businessType=water|gas`、`districtCode`、`enterpriseCode`、`adminGridCode`、`communityCode`、`categoryCode`；网格/小区筛选需要网格和热力权限。未支持的参数拒绝，筛选交集适用于主账统计、固定周期、下钻和模拟研究。事件无已核验小区或分类关系时，选择小区/分类后事件为空；这不表示真实没有事件。
- 未知区划、企业、行政网格、小区、分类统一使用保留编码 `__missing__`，图表与下钻可用相同编码；权限不足导致的字段遮盖为 null。业务类型未知保留在总量，但 water/gas 业务视图不将它视为其中一类。

六个功能段均为 `{state:'available'|'partial'|'unavailable',reason:string|null,data:object}`，真实和模拟使用相同字段；具体类型见 `src/types/screen.ts`：

| 字段 | data |
| --- | --- |
| `supply` | `enterpriseRates`（id、name、count、households、per10k、reason、version、at）、`communities` 排名、`monthly`、`regions` |
| `dynamic` | `evaluation`（有效、满意、不满意、未评价及百分比）、`unsatisfiedBusiness`、`duration`（四段及各段评价）、`hourly`、`weekly`、`monthly` |
| `top3` | `items`（code、count）、往年对应 `from/to`、`coverage` |
| `warnings` | `items`（scenario、from、to、count、triggered、threshold、days、enabled、ruleVersion、evidenceKey）；无正式规则时字段为 null 并标不可用 |
| `research` | `seasons`：冬、夏各自 `years` 五季、`months` 本期/上期范围和数值、`topGrids`；无正式口径时空数组加不可用状态 |
| `spatial` | `grids`、`communities`、`events`、`pipelines`；模拟包含范围内零诉求网格、坐标、四类停供及施工样本。真实空间未核验时为空加原因 |

同一响应还有 `mode`、`window`、`contextId`、`generatedAt`、`expiresAt`、`source`、`permissionScope`、`summary`、`periods`、`quality`、`charts`、`layers`、`consistency`。`summary.total` 是所选窗口授权记录数；`unlocated` 是无行政网格编码数，不代表精确坐标覆盖。`charts.trend`、`monthly`、`weekly`、`hourly` 为选定窗口计数。`periods` 包含昨日、月、季、年，均截止所选 to，历史覆盖未核验。图表缺失桶编码统一为 `__missing__`。

正式诉求仅选择宜接就办来源、有 source_id 的授权主账，以 source_system + source_id 去重，当前按接收时间及 id 降序选择首条；来源受理时间优先，缺失回退接收时间。未映射专题历史不拼进合计。`quality` 中缺日期、缺来源键、重复和时间回退计数基于授权来源范围。主账和户数证据同一只读快照，事件单独读取；`source` 返回 utility 本地版本、feed 版本和最后同步时间（无证据为 null），不能声称跨来源原子一致。

企业万户按既有历史户数版本及业务查询权限，采用候选期末完整企业分母：件数 / 有效户数 × 10000；户数为零、无有效区间、局部辖区/网格或企业范围不足等返回 null 和原因。当前有企业主键的选中诉求才产生企业行；未证明跨期加权人口口径。正式有效评价优先规则与来源完成时间统计映射尚未确认，返回同形缺项。正式 CIM 状态为本接口未接入/未核验，模拟规则和几何只供演示。

## 明细与事件

`GET /screen/demands?contextId=...&metricKey=year&page=1&size=20`：`metricKey=selected|yesterday|month|quarter|year`；可附 `categoryCode`、`districtCode`、`enterpriseCode`、`adminGridCode`、`communityCode`、`from`、`to` 求交集。每页最多 100。返回稳定原诉求 ID、业务类型、分类、授权编码、日期、来源状态及安全标题（基于 ID 生成，不暴露原始自由文本）。固定周期和明细来自同一诉求快照。

`GET /screen/compare?contextId=...&gridCodes=A,B`：2–3 个不同授权网格，返回类别 × 网格 `count` 和 `maximum`，并列最高同时标记。模拟候选目录包括零诉求网格；正式模式目前仅使用授权诉求中出现的行政网格编码，正式网格几何和关系尚未核验。

`GET /screen/events/:id?contextId=...`：对应事件读取权限；返回安全事件摘要、历史和 `relatedDemands`。历史不依赖分类映射；真实事件版本变动返回 409。关联按现有行业、网格、分类和时间规则单独读取，仅表示相关而非因果，不与诉求快照声明一致。缺分类或网格返回 `total:null`。模拟使用明确标识的关联规则：当前筛选交集内同行业、共同网格、事件日期内，且分类为相应压力问题或费用咨询；仅供演示、不代表因果。模拟关联摘要字段为 `{id,type,occurredAt,gridId}`，其中 occurredAt 是 `YYYY-MM-DD` 日期精度；正式相同字段中 occurredAt 是来源时间。

上下文仅当前单进程内、最多 100 个、保留 120 秒，绑定用户和范围，访问时重新检查当前权限；过期/重启 409，跨用户或范围变化 404。多进程尚不共享，正式发布前需处理或确认单进程运行及容量。

## 本地离线预览与 fixture

`./node_modules/.bin/tsx.cmd scripts/screen-preview.ts` 只绑定 `127.0.0.1:3199`，使用固定模拟会话、同一后端聚合算法、独立模拟样本，不连接数据库，不加载生产 app 或定时器，拒绝 `mode=real`。仅供本地开发，不得部署或开放外网。可设置 `SCREEN_PREVIEW_PORT` 选择本地端口。

`./node_modules/.bin/tsx.cmd scripts/screen-preview.ts --fixture` 生成 `tests/fixtures/screen-simulation.json`，文件是完整模拟 bootstrap 消费样例，`contextId=offline-fixture-not-a-session` 仅作占位，不能用于下钻；下钻请通过预览服务重新 bootstrap。

## 权威字段与冲突

| 对象 | 权威来源 | 映射与冲突规则 |
| --- | --- | --- |
| 当前诉求、状态、区划、分类、业务时间 | 宜接就办同步主账 | 来源系统 + 来源主键；专题数据无映射时不合并、不覆盖 |
| 企业与户数 | 已确认企业编码和历史户数版本 | 不按名称自动合并；限制完整企业范围及有效期 |
| 事件审批、时间和修订 | utility 来源记录 | 按类别权限、当前区划企业范围过滤；独立版本读取 |
| 网格、几何和管线 | 经确认的行政网格及正式空间版本 | 不将服务覆盖网格当行政网格；模拟几何隔离 |
| 评价、办结时间和历史 | 已确认来源及可核验优先级 | 当前缺正式评价优先规则和完成时间安全统计映射，专题历史缺来源键，均不冒充正式统计 |

## 专题证据和模拟热力

`warnings.data.items[]`、`top3.data.items[]`、`research.data.seasons[].years[]` 的 `evidenceKey`，以及 `months[]`、`topGrids[]` 的 `currentEvidenceKey` 和 `previousEvidenceKey`，均为本次上下文内的不透明键，不能自行构造或跨上下文复用。调用 `GET /screen/evidence?contextId=...&evidenceKey=...&page=1&size=20` 返回 `{contextId,evidenceKey,state,reason,total,items,window,ruleVersion,page,size}`。每页最多 100；items 仅安全 ID、日期、业务及授权编码和生成标题。摘要与证据均来自同一套已过滤的来源；历史窗口不会被当前 from 截断。`window.coverageThrough` 表示该月实际季节覆盖截止；`total:null` 和 reason 表示正式证据不可用，并非零。来源、地区、企业、网格、小区、行业、类别和权限均继承 bootstrap；网格排行证据额外需要 `grid.read` 与 `heatmap.read`。过期 409，跨用户、权限范围变动或不存在的键 404；基础权限缺失或网格权限撤销 403。

`heat` 为 `{state,reason,data:{days,thresholds,coefficients,policyId,ruleVersion,grids}}`。模拟基于已过滤诉求的行政模拟网格计数，首尾日期均计入，阈值为天数乘五档模拟系数，使用 TENDER_1_1_9_V1 边界政策；每个网格提供 code/count/level/reason/ruleVersion，包含授权零件网格。`simulation-only` 不代表正式发布规则；正式空间或规则未核验，或缺网格/热力权限时 state 为 unavailable 且规则和天数为 null、grids 为空。热力没有另行拼入行政热力旧账本。
