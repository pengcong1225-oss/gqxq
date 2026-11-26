# CIM 社区网格边界（栅格代理）

> 数据来源：宜昌 CIM 平台「抖动-行政区划-社区网格」地图服务（《CIM-配置2》给的 token + 内网网关）。
> 定位：**边界参考层**，不是网格数据源。看完这页就知道为什么这么接、以及还缺什么。

## 1. 为什么只做栅格

2026-11-24 对 `http://10.55.69.155:8885/gtis/map/rest/<uuid>/rest/maps/<map>` 逐项实测：

| 能力 | 结果 |
|---|---|
| `map.json` / `layers.json` / `image.png` | ✅ 200 可用 |
| `layers.json` 的 `queryable` | ❌ 5 个图层全部 false |
| `queryResults.json`（要素查询） | ❌ 404 |
| `/gtis/data/rest/...`（数据服务） | ❌ 404（该 uuid 属于另一套环境） |
| WMS / MVT / vectortile / tileFeature | ❌ 404 |

结论：这批服务只开放「出图」，没有要素/属性通道。所以能做的只有：
按视野取一张边界图（`image.png?viewBounds=...&transparent=true`），当图层叠上去。

**由此带来的能力边界（必须写进验收口径）**：

| 标书要求 | 本方案 |
|---|---|
| 网格图层可见、可叠加 | ✅ 有（CIM 真实网格线，EPSG:4490 与影像贴合） |
| hover 显示社区名/网格名/诉求量 | ❌ 无（要属性） |
| 五色热力按诉求量着色 | ❌ 无（要网格面几何） |
| 点击网格下钻 | ❌ 无（要网格编码+几何） |

## 2. 接口

```
GET /api/v1/cim/grid-overlay?level=sqwg&bbox=W,S,E,N&w=1024&h=768   → image/png
GET /api/v1/cim/grid-overlay/status                               → 配置摘要（不含 token）
```

- `level`：`sqwg`(社区网格) / `sqjcglqy`(社区居村管理区域) / `xzj`(乡镇街) / `qx`(区县) / `sz`(市州)，白名单；
- `bbox`：EPSG:4490 经纬度 W,S,E,N；**超出宜昌市域直接拒绝**（不做任意代理）；
- `w/h`：128~2048；
- 权限：与 `/assessment/*` 同权限（`assessment.read`，三档角色可读）；
- 响应头：`x-cim-cache: hit|miss`；上游失败时回退过期缓存并写 `x-cim-note`。

## 3. 配置

```bash
GQXQ_CIM_TOKEN=<CIM-配置2 里的 token>     # 平台级凭证，只放服务端
GQXQ_CIM_BASE=http://10.55.69.155:8885/gtis/map/rest
GQXQ_CIM_CACHE_DIR=                       # 留空 = server/.dev-logs/cim-overlay-cache
GQXQ_CIM_CACHE_TTL_MS=21600000            # 6h，边界准静态
GQXQ_CIM_TIMEOUT_MS=20000
```

## 4. 大屏入口

- 打开诉求大屏 `/#/accept` 的二维地图，在图层控制条找到「CIM 参考边界」。默认显示社区网格，也可选择社区居村管理区域、乡镇街、区县、市州或关闭。
- 选定图层后，按当前视野请求透明栅格边界。图层切换和关闭会清除旧影像，加载失败会显示原因和可用的重试入口。上游故障时若命中该视野、该层级的过期缓存，状态会标为「缓存」。
- 青绿边界供目视比对。点位、正式网格、热力及其下钻沿用业务图层。CIM 栅格影像不参与点选或归属计算。
- 管理端可用同源 `/screen/#/accept?cimLevel=sqjcglqy` 打开社区居村边界。有已核验的宜昌市域 WGS84 坐标时，在片段中添加 `lon` 和 `lat` 可显示「参考位置」标记。链接可在大屏常规登录后继续使用。

## 5. 政务数据中台的独立矢量服务

2026-11-26 通过政务数据中台正式路由核验 `IC42050020230626000008`。数据源名为 `宜昌网格20230512`，使用 EPSG:4490。社区网格 `skjc_xzq_wangge_new` 有 11,343 个面，抽样 `BM` 为 14 位。村和社区 `skjc_xzq_cun_new` 有 1,648 个面，抽样 `BM` 为 12 位。现存的 9 位编码用于乡镇和街道。保留源 `BM` 原样，按各自层级审核。

该接口的目录、数据集元信息、字段及 `GET .../features/{SmID}.json` 均能读取。政务网关本次返回集合 GET 500、空间查询及重投影 POST 404。独立版本 `IC42050020250401000001` 和 `IC42050020231008000003` 的正式路由也返回 404。上述结果仅核验了历史版本，使用前需确认时效及共享范围。

## 6. 本地预览和导入准备

先从授权方确认同一层级需要核验的 SmID，然后在 `server` 目录运行下面的命令。每批最多 100 个 SmID。源坐标和完整编码保存在仓库外的 `cim-preview.json`。

```powershell
node --import tsx scripts/prepare-cim-boundaries.ts --level community-grid --ids 9 --out 'D:/codex/tmp/cim-boundary-review'
```

- `--level` 支持 `community-grid` 和 `community`。配置项 `GQXQ_CIM_VECTOR_ENDPOINT` 可指定数据中台授权的 HTTPS 正式数据入口。令牌通过服务端 `GQXQ_CIM_VECTOR_TOKEN` 提供，未设置时调用同源平台令牌接口。
- 用 `--district <已核验六位区县编码>` 可额外准备 `admin_grid.csv`，源要素须全部匹配同一已核验区县前缀。使用已有 B4 批量导入预览核查权限、区划及新增目录项。
- 文件以稳定编码排序，同一输入重跑生成同样的 SHA-256。目标有不同内容时会停止并要求新目录。
- `convert-cim-preview.py` 使用已有的 `pyproj` 环境查找有已知精度的转换，强制经度、纬度顺序。宜昌范围实测 PROJ 9.8.1 未找到有已知精度的 EPSG:4490→4326 操作，转换脚本会拒绝生成文件。仅离线点位验证可在相同 EPSG:4490 坐标系下直接完成。

```powershell
python scripts/convert-cim-preview.py 'D:/codex/tmp/cim-boundary-review/cim-preview.json' 'D:/codex/tmp/cim-boundary-review/converted.json'
```

拿到授权方认定的 EPSG:4326 转换文件后，用 `--converted <文件>` 和 `--approval <授权依据>` 准备 `grid_boundary.geojson`。转换文件记录源预览校验值 `sourceSha256`、转换操作 `operation` 和已知精度 `accuracyMeters`。脚本核对完整网格码、几何结构、来源和 B4 文件校验。提交前使用已有 B4 导入预览和幂等提交接口，边界仅关联已登记的同级编码。
