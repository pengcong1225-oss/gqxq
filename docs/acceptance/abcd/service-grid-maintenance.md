# 企业服务网格与空间主数据

服务网格、行政网格、小区是独立的稳定编码对象。页面已使用真实接口；无边界时显示“无授权边界数据”。先核验维护行政网格的区县编码及小区父级，再关联登记企业、业务类型和覆盖对象。不会从候选地址或自由文本自动生成主数据。

覆盖有效期为 `[validFrom, validTo)`；结束日为空表示开放期。修改覆盖应填写较晚的新生效日，前一开放期自动截止，原关联和几何快照保留。相同输入不增版本。冲突时页面保留草稿，需核对当前版本后重新保存。一个企业可有多个服务网格，重叠不会自动确定唯一网格。本次维护模型为一网格一登记企业，企业归属不自动改绑。

`grid.read` 控制菜单、读取及选单；`grid.manage` 控制维护按钮和写端点。整网格的全部实际企业＋覆盖区县组合都须授权，不能凭一个可见区县读取另一区县成员或边界。企业档案的管理归属区县不参与覆盖推断。行政网格、小区本身按其实际区县授权；仅企业范围、无区县范围的用户不能维护共享空间主数据。历史先校验最新覆盖范围，再逐版本检验旧覆盖，页面只展示授权版本。

边界维护只接受已核验授权来源的 WGS84 Polygon/MultiPolygon，并校验闭合、面积、自交、孔洞和面重叠。全部关联行政网格都具备有效几何时，覆盖返回 GeoJSON FeatureCollection，保留各成员的独立几何，不虚构空间并集。缺任一成员几何则整体返回 null。已有覆盖的几何快照不随主数据更新改变，新有效期才能采用新几何。平台不混用 GCJ02/WGS84，不自动转换坐标。页面采用本地 SVG 几何预览，无底图、供应商、密钥或面积距离推算。

## 端点与权限

| 方法 | 路径（相对 `/api/v1`） | 功能权限 |
| --- | --- | --- |
| GET | `/grids` | grid.read |
| GET | `/grids/:code` | grid.read |
| GET | `/grids/:code/history` | grid.read |
| GET | `/grids/:code/boundary` | grid.read |
| GET | `/grid-reference-options` | grid.read |
| GET | `/admin-grids/:code` | grid.read |
| POST | `/grids` | grid.manage |
| PATCH | `/grids/:code` | grid.manage |
| POST | `/admin-grids` | grid.manage |
| POST | `/communities` | grid.manage |

详情和边界支持 `?at=YYYY-MM-DD`，没有该日有效版本则 404。创建 `expectedVersion=0`；已有对象须带当前版本。写路径在同一事务锁定依赖、对象、历史和审计。审计动作：`service_grid/SERVICE_GRID_SAVE`、`admin_grid/ADMIN_GRID_SAVE`、`community/COMMUNITY_SAVE`，业务键分别是真实稳定网格/行政网格/小区编码；查询以当前对象范围授权，不从审计明细或同名诉求推断。

## 迁移前提与尚未验证项

原始 canonical DDL 未提供。迁移 `20261009090000` 使用明确的最小兼容契约：既有 service_grid 含唯一 grid_code、grid_name、business_type、可空 district_code；既有 grid_enterprise 含 grid_code、enterprise_code 唯一组合；依赖 B2 enterprise 的稳定 code/business_type/status/version。编码和业务类型列至少64字符，grid_name至少64字符；稳定键需匹配 utf8mb4 排序规则，业务表为 InnoDB。额外必填无默认列、关系孤儿/类型差异、多企业历史模型或已有扩展结构冲突会在首次变更前明确拒绝。不得把历史多企业解释成非法数据，应先核验模型并决定后续兼容方案。

迁移不重建既有主表，不清旧行，不猜历史映射。无企业关系的旧网格仅显式全域用户可读，显示未维护覆盖/null几何；全域维护者可核验补登记关系并保留原名称。已有关系但无覆盖的旧网格不凭 district_code 猜覆盖；区县受限范围拒绝未知覆盖。

开发验证仅使用明确声明的 synthetic legacy fixture 和真实增量迁移。真实原基线兼容、完整迁移链、业务数据处理与重启部署尚未验证，需原 DDL/授权资料后安排。不存在生产迁移或业务库写入验收证据。
