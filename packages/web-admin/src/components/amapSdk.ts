/**
 * 高德地图 SDK 共用入口（标书 1.2.12 指定高德；天地图已全部下线）。
 *
 * - loadAmapSdk / gcj02ToWgs84 复用 AmapLocationPicker 中已实现的加载与坐标系转换，避免两份实现漂移；
 * - wgs84ToGcj02 供"库内 WGS84 坐标 → 高德地图绘制"使用（高德地图使用 GCJ-02）。
 */
export { loadAmapSdk, gcj02ToWgs84 } from './AmapLocationPicker';

/** WGS84 → GCJ-02（百度/高德系地图绘制前必须转换）；公式与后端 domain/utilityCoordinates 对称。 */
export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return [lng, lat];
  const x = lng - 105;
  const y = lat - 35;
  const pi = Math.PI;
  let a = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  let b = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  const common = ((20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2) / 3;
  a += common + ((20 * Math.sin(y * pi) + 40 * Math.sin((y / 3) * pi)) * 2) / 3 + ((160 * Math.sin((y / 12) * pi) + 320 * Math.sin((y * pi) / 30)) * 2) / 3;
  b += common + ((20 * Math.sin(x * pi) + 40 * Math.sin((x / 3) * pi)) * 2) / 3 + ((150 * Math.sin((x / 12) * pi) + 300 * Math.sin((x / 30) * pi)) * 2) / 3;
  const rad = (lat * pi) / 180;
  const magic = 1 - 0.00669342162296594323 * Math.sin(rad) ** 2;
  const sqrt = Math.sqrt(magic);
  return [
    lng + (b * 180) / ((6378245 / sqrt) * Math.cos(rad) * pi),
    lat + (a * 180) / (((6378245 * (1 - 0.00669342162296594323)) / (magic * sqrt)) * pi),
  ];
}

/** 批量转换 WGS84 环 → 高德可绘制的 [lng,lat][]（GCJ-02） */
export function ringToGcj02(ring: number[][]): [number, number][] {
  return ring.map(([lng, lat]) => wgs84ToGcj02(Number(lng), Number(lat)));
}
