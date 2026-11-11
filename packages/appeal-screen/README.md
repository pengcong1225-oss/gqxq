# 宜昌市供气供水诉求大屏

Vue 3 + ECharts + 现有超图 Cesium。默认真实数据模式，真实请求失败不会自动改用模拟数据。真实功能依赖诉求后台授权、正式数据和已验收的空间服务，不能以本地模拟代替验收。

## 本地离线预览

1. 在 `../../server` 启动 `node_modules/.bin/tsx.cmd scripts/screen-preview.ts`，该服务只监听 `127.0.0.1:3199`，仅模拟、不连接数据库。
2. 在本目录执行 `npm install`，然后 `npm run dev -- --host 127.0.0.1 --port 8002`。
3. 打开 http://127.0.0.1:8002/，点击“切换模拟演示”。未启动预览服务或真实接口不可用时页面显示错误，不自动造数据。

`npm run build:prod` 生成 `dist`；`node --test tests-screen-contract.test.js tests-request-generation.test.js` 运行领域契约检查。静态引擎从 public 复制，使用相对路径支持子路径，实际网关和 MIME 仍需部署验证。

## 登录与 API

默认 API `/api/v1`，本地 Vite 代理目标默认 `http://127.0.0.1:3199`；可通过环境变量 `SCREEN_API_TARGET` 指向开发后端。构建时 `VITE_API_BASE` 可设置 API 路径。大屏登录使用已有 `/auth/login`、同源 `localStorage.token` 和 Bearer；密码与 token 不放 URL。必须修改密码的账号需先在后台完成；若配置 `VITE_MANAGEMENT_URL`，它须为同源、无查询参数及片段的后台入口；未配置显示明确提示。

## CIM 配置

`public/config/cim.json` 默认 `wmts: null, s3m: null`。无资源时状态明确显示未配置。配置示例（仅结构占位，非实际可用服务）：

```json
{
  "wmts": {
    "url": "/gis/approved-wmts/{TileMatrix}/{TileRow}/{TileCol}",
    "crs": "EPSG:4490",
    "layer": "approved-layer",
    "style": "default",
    "format": "image/png",
    "tileMatrixSetID": "approved-matrix-set",
    "tileMatrixLabels": ["0", "1", "2"],
    "levelZeroTilesX": 2,
    "levelZeroTilesY": 1,
    "rectangle": [-180, -90, 180, 90],
    "minimumLevel": 0,
    "maximumLevel": 2
  },
  "s3m": {"url": "/gis/approved-s3m/config"}
}
```

以上矩阵、范围、CRS、轴序与层级只是占位，须依据资源方 Capabilities、控制点和 SDK 文档确认。只接受同源固定路径且不带查询串；配置中不得放密码或令牌。应由已授权的同源受控网关处理身份、固定资源白名单和 S3M 全部相对路径、纹理、分页子资源；本前端不提供任意 URL 代理，也不提供该网关。配置被接受不等于瓦片、模型及纹理成功或坐标精度通过。EPSG:4490/4326 仅按声明使用 GeographicTilingScheme，实际资源兼容性必须验收。

模拟网格、小区、事件、管线及热力均是演示，地图明确标记非正式边界。正式空间未核验时不生成虚构几何；正式热力或证据未核验返回不可计算原因。详情和大屏统计来自各自接口所说明的快照与来源，事件相关诉求不代表因果。

## Git 同步依赖边界

超图/Cesium、Mars3D 现有授权静态引擎不随源码提交。使用已有授权分发包，将 `lib` 放到本目录 `public/lib`，按 `vendor-assets.manifest.json` 核对 SHA-256。当前工作区原引擎完整保留，不从未知 CDN 下载替代。缺少该目录时可编译业务代码，但地图不能运行；这不算完整浏览器验收。正式 CIM 配置也不随源码提交，仓库仅提供空配置。
