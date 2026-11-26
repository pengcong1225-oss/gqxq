/**
 * 高德地图 SDK 共用入口（标书 1.2.12 指定高德，为平台唯一地图服务商）。
 *
 * 复用 AmapLocationPicker 的 SDK 加载和坐标系转换。
 */
import { wgs84ToGcj02 } from './AmapLocationPicker';
export { loadAmapSdk, gcj02ToWgs84, wgs84ToGcj02 } from './AmapLocationPicker';

/** 批量转换 WGS84 环 → 高德可绘制的 [lng,lat][]（GCJ-02） */
export function ringToGcj02(ring: number[][]): [number, number][] {
  return ring.map(([lng, lat]) => wgs84ToGcj02(Number(lng), Number(lat)));
}
