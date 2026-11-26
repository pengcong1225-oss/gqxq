import type { ComplaintDetail } from '../types/api';

type SavedLocation = Pick<ComplaintDetail, 'locationLng' | 'locationLat' | 'locationCoordinateSystem' | 'locationCoordinateSource'>;

// The CIM address-reference view accepts WGS84 coordinates inside this published map extent.
const CIM_EXTENT = { west: 110.251, south: 29.935, east: 112.089, north: 31.572 };

export function cimAddressReference(basePath: string, detail: SavedLocation) {
  const query = new URLSearchParams({ cimLevel: 'sqjcglqy' });
  const { locationLng: lon, locationLat: lat, locationCoordinateSystem: crs, locationCoordinateSource: source } = detail;
  const representativePoint = /代表点|行政区中心|实际精度区县|非诉求实际发生位置/.test(source ?? '');
  if (crs === 'WGS84' && source?.trim() && !representativePoint && lon != null && lat != null
    && Number.isFinite(lon) && lon >= CIM_EXTENT.west && lon <= CIM_EXTENT.east
    && Number.isFinite(lat) && lat >= CIM_EXTENT.south && lat <= CIM_EXTENT.north) {
    query.set('lon', String(lon));
    query.set('lat', String(lat));
  }
  return { href: `${basePath}/screen/#/accept?${query}`, hasPoint: query.has('lon') };
}
