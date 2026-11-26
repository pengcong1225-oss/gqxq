# 边界数据包（Boundary Pack）—— 街道/社区边界的可替换数据源

> 解决的问题：标书 1.2 要求「社区网格图层」「区域分布采用真实边界」，但**街道级边界没有稳定公开来源**：
> 高德 `/v3/config/district` 对街道返回 `polyline` 为空（官方文档明示），
> `admin_grid.geometry` 124 条全为 NULL。此前只能用「小区点位缓冲合并」画近似面。
>
> 本模块把边界来源**外置成一个文件契约**：先接 OSM 底稿，后续换甲方 SHP 导出 / 高德企业智图 /
> 天地图数据，**只换文件 + 改一个环境变量，代码与前端契约不动**。

## 1. 优先级（同一网格码只出一份面，不叠面）

```
admin_grid.geometry（甲方正式边界，权威）
        ↓ 没有几何时
GQXQ_BOUNDARY_PACK 指定的数据包（OSM 底稿 / 商业授权 / 甲方导出）
        ↓ 仍没有时
小区点位缓冲合并（近似，source=buffer）
```

接口 `GET /api/v1/assessment/admin-boundaries` 的 `streetSource` 会如实返回
`official | pack | buffer | mixed | none`，并新增：

| 字段 | 含义 |
|---|---|
| `streetCount` | `{official, pack, buffer}` 各来源的街道面数量 |
| `packMatched` | 数据包要素中**已与 admin_grid 编码对齐**的数量 |
| `pack` | 数据包溯源：`dataset/provider/license/fetchedAt/adminLevels/featureCount/dropped/error` |

> 前端状态条据此显示「街道 41（OSM 底稿，3 个未对齐编码）· 底稿 2026-11-24 · ODbL-1.0」。
> **未对齐编码**必须显式提示：这类面有几何但没有网格编码，诉求量会聚不上（显示 0 件是假象）。

## 2. 文件契约（换数据只改这个文件）

```jsonc
{
  "type": "FeatureCollection",
  "metadata": {
    "dataset": "yichang-admin8-osm",
    "provider": "osm",                    // 必填：osm | amap-adat | official-export | 自定义
    "providerDetail": "OpenStreetMap / Overpass API",
    "license": "ODbL-1.0",                // 许可证/授权依据，前端会展示
    "attribution": "© OpenStreetMap contributors",
    "srid": 4326,                         // 必须 4326；其他坐标系**直接拒绝**，不做隐式投影
    "adminLevels": [8],
    "fetchedAt": "2026-11-24T07:30:00.000Z",
    "note": "OSM 底稿，非权威边界，验收前须替换"
  },
  "features": [
    {
      "type": "Feature",
      "properties": {
        "code": "420502001",              // 9 位官方码优先；可为空（服务端按名称对齐或生成占位码）
        "name": "西陵街道",
        "level": "street",                // street | community | grid
        "adminLevel": 8,
        "osmRelationId": 1234567
      },
      "geometry": { "type": "Polygon", "coordinates": [[[111.28,30.70], "..."]] }
    }
  ]
}
```

加载器纪律（`src/services/boundaryPackService.ts`）：

- `srid != 4326` → 拒绝加载（错误原因透出到接口 `pack.error`，不静默换算）；
- 环不闭合 → 自动补闭合并计数；点数 < 3、越出市域框（109.5~112.5E / 29.0~32.5N）→ 丢弃并计数；
- 文件按 **mtime + size** 自动重载：**替换文件后无需重启服务**，下次请求即生效；
- 大小上限 `GQXQ_BOUNDARY_PACK_MAX_MB`（默认 32MB），防止误配超大文件。

## 3. 环境变量

```bash
# 留空 = 不启用（退回 official → buffer）
GQXQ_BOUNDARY_PACK=data/boundaries/osm-yichang-admin8.geojson
GQXQ_BOUNDARY_PACK_MAX_MB=32
```

相对路径按 **server 根目录**解析（与启动 cwd 无关）。

## 4. 生成 OSM 底稿

```bash
cd server
npm run boundary:osm            # = node scripts/fetch-osm-boundaries.mjs --levels=8 --tiles=2
# 只统计不落盘
node scripts/fetch-osm-boundaries.mjs --levels=8 --dry-run
# 村/社区级（更慢，覆盖取决于 OSM 数据质量）
node scripts/fetch-osm-boundaries.mjs --levels=10 --tiles=3
```

产物：`server/data/boundaries/osm-yichang-admin8.geojson`（WGS84），
原始 Overpass 响应落在 `server/.dev-logs/osm-fetch/` 便于复核。

**抓取现实**（2026-11-24 本机实测）：只有 `overpass-api.de` / `lz4.overpass-api.de` 能返回中国数据，
且高峰期会 502「queue full」——脚本内置 30/60/120s 退避重试与 bbox 分块；
`kumi.systems`、`private.coffee` 会挂起，`overpass.osm.ch` 是瑞士区域镜像（中国范围静默返回 0，已排除）。

## 5. 换源步骤（从 OSM 换到正式数据）

1. 拿到新数据（SHP/GeoJSON/数据库导出），统一转 **EPSG:4326** 并写成上面的 FeatureCollection；
   - SHP：`ogr2ogr -f GeoJSON out.geojson in.shp -t_srs EPSG:4326`
   - GCJ-02 来源（高德企业智图）：先走 `domain/utilityCoordinates` 的 GCJ02→WGS84，**不要**用 `-t_srs`；
2. `metadata.provider/license/fetchedAt/note` 如实填写（验收要追溯）；
3. 覆盖 `data/boundaries/` 下的文件（或新路径改了 `GQXQ_BOUNDARY_PACK`）；
4. 刷新接口即可，无需重启：`curl -H "Authorization: Bearer <token>" localhost:3100/api/v1/assessment/admin-boundaries`
   看 `streetSource`、`packMatched`、`pack.provider` 是否符合预期；
5. 若编码已对齐（`packMatched == streetCount.pack`），可在验收材料里把该层从「底稿」改称「正式边界」——
   但**前提是数据确实来自甲方/授权方**，不能只因为对齐率 100% 就改口径。

## 6. 已知限制（写进验收口径，不粉饰）

- OSM 在中国**街道/乡镇边界覆盖不完整**，宜昌各区县覆盖不均；缺失的网格仍走 `buffer` 近似；
- OSM 的 `division_code` 并非全部存在，未对齐编码的网格诉求量会显示 0（前端已提示）；
- ODbL 许可要求署名：大屏角落需标注 `© OpenStreetMap contributors`（`pack.attribution` 已随接口返回）；
- 本模块**不产生**任何"官方网格"的说法：`source=pack` 时前端一律标注「底稿」。

## 7. 没有权威边界时的「推导面」（泰森多边形）

CIM 那边只给栅格出图、拿不到要素时，用平台自有事实推导网格面：

```bash
cd server && npm run boundary:derive     # 生成 data/boundaries/derived-grid-faces.geojson
```

- 输入：`community` 表的小区点位（带 9 位 `admin_grid_code`）+ `admin_grid` 名称；
- 算法：每个点做 Voronoi 单元（裁剪到 6km 圆 + 市域框）→ 同一网格的单元 union；
- 输出：与 OSM/官方数据**同一份数据包契约**，`provider` 逐要素标注：
  `osm`（实测面）/ `derived-voronoi`（推导面）；
- 前端按 provider 如实显示「点位泰森多边形（近似）」，悬停名字带 `≈`，绝不冒充正式边界；
- 已知边界：只有**有小区点位的网格**才有面（宜昌 110 个街道网格里 42 个：35 推导 + 7 OSM）。

拿到 CIM 数据服务后，用同一套包格式重建（provider 改 official-export）即可替换，前端零改动。

## 8. 高德不可用时的降级链（2026-11-24 实测）

| 层 | 主源 | 降级 1 | 降级 2 |
|---|---|---|---|
| 区县边界 | 高德 `/v3/config/district`（12h 缓存） | **本地快照** `data/boundaries/yichang-districts-snapshot.geojson`（source=snapshot） | CIM `level=qx` 栅格（只读参考线） |
| 街道/网格面 | 边界数据包（OSM + 推导面） | 点位缓冲近似 | — |
| 底图 | CIM 影像（drs/网关） | — | 高德影像（仅兜底） |
| 小区地理编码（新增数据） | 高德 geocode | 数据服务中心 / 人工复核 | — |

区县降级的实现要点：

- `adminBoundaryService` 在高德**返回不足 13 个**（QPS 打满、超时、部分失败）时按编码补齐快照，**只补缺、不覆盖实时值**；
- 未配置 `GQXQ_AMAP_KEY` 时直接返回快照（原来直接返回空数组，会让整层消失）；
- 接口新增 `districtSource:{amap,snapshot}` 与 `districtSnapshot:{fetchedAt}`，前端提示「区县边界来自本地快照（高德不可用，快照 2026-11-24）」；
- 快照生成/更新：`npm run boundary:districts`（GCJ-02→WGS84 用与线上同一套迭代转换，不能用 `-t_srs`）。

实测：把 `GQXQ_AMAP_KEY` 置空重启 → 接口仍返回 13 个区县（source 全为 snapshot），五色区县着色、区域下钻照常；
恢复 key 重启 → `districtSource={amap:13,snapshot:0}`。截图见 `deliverables/cim-社区网格-可调用性核查-20261124/screenshot-district-snapshot.png`。

## 9. 政务网形态（2026-11-24 定稿）

大屏部署在政务网，**高德大概率不可用**，因此把外部依赖从"运行时"挪到"离线"：

| 项 | 政务网形态 | 开关 |
|---|---|---|
| 区县边界 | 运行时只读本地快照，**不访问高德**（实测接口 173ms；原来实时要串行 13 次约 5s+） | `GQXQ_DISTRICT_SOURCE=snapshot`（默认） |
| 高德底图兜底 | **构建时关闭**：CIM 两条源都不通时如实显示"影像不可达"，不拿 GCJ-02 影像兜底（与点位差约 680m，比深色底更误导） | 默认 `VITE_BASEMAP_AMAP=false`；有外网演示环境构建时传 `VITE_BASEMAP_AMAP=true` |
| 街道/网格面 | 边界数据包（OSM + 推导面），零外部依赖 | `GQXQ_BOUNDARY_PACK` |
| 社区网格参考线 | 走我方后端代理访问内网 CIM（`10.55.69.155`），token 不下发前端 | `GQXQ_CIM_TOKEN` |
| 高德 key | **只给离线刷新快照的脚本用**，线上不需要 | `GQXQ_AMAP_KEY`（离线机器） |

实测（清空/不配置高德访问、构建 `VITE_BASEMAP_AMAP=false` 后）：

- 大屏页面 **0 次**请求 amap.com / webst0（瓦片、接口都没有）；
- `/assessment/admin-boundaries` 200，`districtSource={amap:0,snapshot:13}`，耗时 173ms；
- 底图仍正常（CIM 影像 drs 源），区县五色着色、区域下钻、网格五色/悬停/下钻全部照常。

截图：`deliverables/cim-社区网格-可调用性核查-20261124/screenshot-govnet-mode.png`。

> 唯一还需要外网的是**新增小区的地址落点**（高德 geocode）。政务网内做法：在有外网的机器上批量geocode 后导入，
> 或改用数据中台的地址/门牌服务；历史已落点数据不受影响。
