# community-location-jitter（历史留存，勿在新批次复用）

该批次脚本使用天地图 geocoder（`api.tianditu.gov.cn` + `GQXQ_TIANDITU_KEY`），用于 2025–2026 年小区主数据定位与坐标抖动的一次性数据生产；产出报告见 `server/.dev-logs/import-2025-2026/reports/`（community-geocode-*、community-location-jitter.json 等）。

**该批次脚本使用天地图 geocoder，天地图已于 2026-11-18 停用，脚本仅作历史留存，不得在新批次复用；新批次请用 `server/src/clients/amapGeocoder.ts`（高德，GCJ02→WGS84）。**

补充说明：

- 本目录不是运行时代码：未被 package.json / server 启动 / 构建 / 测试/CI 引用，仅在需要追溯历史定位数据来源时查阅；
- 脚本内 `GQXQ_TIANDITU_KEY` 在 server/.env 中已不存在，直接重跑会失败，属预期（天地图已停用）；
- 历史写入的 `community.location_source` 文案仍可能包含"天地图"字样，属于既有数据溯源信息，不在本目录清理范围。
