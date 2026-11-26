import { amapGeocode, amapRegeocode } from '../clients/amapGeocoder';
import type { Tx } from '../db/tx';
import { isCimBoundarySource } from '../domain/cimBoundarySource';
import { parseFieldState } from '../domain/effectiveFieldPolicy';
import type { InitialPoint } from '../domain/locationFallback';
import { locationQuery } from '../domain/locationInitialization';
import { locationCandidates } from '../domain/locationCandidates';
import { classifyLocationBoundary } from './locationValidationService';
import { addressCommunityName, addressGridName, addressParts, extractAddressCandidate } from './rules/addressExtract';
import { getTownshipSnapshot } from './rules/townshipGazetteer';
import { extractLocation } from './rules/locationExtract';
import { validateGeometry } from './serviceGridService';

export interface ComplaintAddressQuery {
  address: string;
  query: string;
  districtCode: string | null;
  evidence: string;
  gridName: string | null;
}

export function complaintAddressQuery(row: Record<string, unknown>): ComplaintAddressQuery | null {
  const buildQuery = (address: string, districtCode: string | null, evidence: string): ComplaintAddressQuery | null => {
    const gridName = addressGridName(address);
    if (!gridName && address.endsWith('网格')) return null;
    const districtName = row.district_name || (gridName && getTownshipSnapshot().counties.find(county =>
      county.code === (row.district_code || districtCode))?.name);
    const query = locationQuery({ ...row, address, district_name: districtName || null }, gridName !== null);
    return query ? { address, query, districtCode, evidence, gridName } : null;
  };
  const current = buildQuery(String(row.address ?? '').trim(), null, '有效地址字段');
  if (current) return current;
  const state = parseFieldState(row.effective_field_state).address;
  if (row.parent_match === 'conflict' || state && (state.resolution !== 'unresolved' || state.correctionId)) return null;
  const extracted = extractAddressCandidate({ title: String(row.title ?? ''), content: String(row.content ?? '') });
  if (!extracted) return null;
  return buildQuery(extracted.value, extracted.districtCode, `${extracted.extractorVersion}/${extracted.sourceField}`);
}

/** Fall back to a uniquely registered community point as location evidence only. */
export async function registeredCommunityPoint(db: Tx, row: Record<string, unknown>, input: ComplaintAddressQuery | null): Promise<InitialPoint | null> {
  const text = { title: String(row.title ?? ''), content: String(row.content ?? '') };
  if (row.parent_match === 'conflict' || extractLocation(text).conflict) return null;
  const names = input ? [addressCommunityName(input.address)].filter(Boolean) :
    [...new Set(locationCandidates(row).filter(candidate => candidate.level === '小区').map(candidate => candidate.name))];
  if (names.length !== 1) return null;
  const district = String(row.district_code ?? input?.districtCode ?? '');
  const [matches] = await db.query<any[]>(
    'select name,district_code,location_lng,location_lat,location_coordinate_system from community ' +
    "where name=? and location_state='located' and location_lng is not null and location_lat is not null and (?='' or district_code=?)",
    [names[0], district, district]);
  const exact = matches.filter(match => match.name === names[0]);
  if (exact.length !== 1) return null;
  const match = exact[0];
  const county = getTownshipSnapshot().counties.find(entry => entry.code === match.district_code);
  if (!county || row.district_name && row.district_name !== county.name) return null;
  const coordinateSystem = match.location_coordinate_system;
  if (coordinateSystem !== 'WGS84' && coordinateSystem !== 'CGCS2000') return null;
  const longitude = Number(match.location_lng), latitude = Number(match.location_lat);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || longitude < 110 || longitude > 112.3 || latitude < 29.5 || latitude > 31.8) return null;
  return { longitude, latitude, coordinateSystem, score: 90, level: '小区', source: '待纠偏：小区主数据匹配，采用已定位小区点位，门牌和网格待核验' };
}

interface VerifiedAddress {
  point: InitialPoint;
  districtCode: string;
  districtName: string;
  streetCode: string | null;
  streetName: string | null;
  communityName: string | null;
  namedGrid?: { name: string; districtCode: string | null; providerNameVerified: boolean; hasUsableReferencePoint: boolean };
}

type AddressResolution =
  | { state: 'verified'; evidence: VerifiedAddress }
  | { state: 'review' | 'retry'; reason: string; point?: InitialPoint };

const PRECISE_LEVELS = new Set(['门牌号', '门址', '兴趣点', '建筑物', '门牌']);
const GRID_REFERENCE_LEVELS = new Set(['网格', '住宅区', '社区', '村庄', '道路']);

export async function verifyComplaintAddress(row: Record<string, unknown>, input: ComplaintAddressQuery): Promise<AddressResolution> {
  const forward = await amapGeocode(input.query);
  if (!forward.ok || forward.longitude === null || forward.latitude === null) {
    return { state: forward.failure ?? 'retry', reason: forward.reason ?? '高德地理编码无结果' };
  }
  const reverse = await amapRegeocode(forward.longitude, forward.latitude);
  if (!reverse.ok) return { state: reverse.failure ?? 'retry', reason: reverse.reason ?? '高德逆地理编码无结果' };

  const parts = addressParts(input.address);
  const district = getTownshipSnapshot().counties.find(county => county.code === reverse.adcode);
  const expectedCodes = [row.district_code, input.districtCode, parts.county?.code, parts.parent?.code].filter(Boolean);
  const expectedNames = [row.district_name, forward.district, reverse.district].filter(Boolean);
  if (!district || forward.adcode !== district.code || expectedCodes.some(code => code !== district.code) ||
      expectedNames.some(name => name !== district.name)) {
    return { state: 'review', reason: '高德正逆编码与诉求区县无法相互印证，待核验' };
  }
  const street = district.townships.find(township => township.name === reverse.township);
  if (parts.township && parts.township.code !== street?.code) {
    return { state: 'review', reason: '高德逆地理编码的街道与诉求地址无法相互印证，待核验' };
  }

  const level = forward.level ?? '未知';
  const communityName = addressCommunityName(input.address);
  const namedResidentialPlace = level === '住宅区' && communityName === parts.local;
  const point: InitialPoint = { longitude: forward.longitude, latitude: forward.latitude, level,
    score: 100, coordinateSystem: 'WGS84', source: `高德地址解析（${level}），正逆编码区县一致，GCJ02已转WGS84` };
  const mapAddress = addressParts(forward.formattedAddress ?? '');
  if (input.gridName) {
    const mapGridName = addressGridName(forward.formattedAddress ?? '');
    const providerNameVerified = mapGridName === input.gridName;
    const hasUsableReferencePoint = PRECISE_LEVELS.has(level) || GRID_REFERENCE_LEVELS.has(level);
    if (!providerNameVerified && !hasUsableReferencePoint) {
      return { state: 'review', reason: `高德定位精度不足以核验网格（${level}），网格待核验` };
    }
    if (mapGridName && !providerNameVerified || mapAddress.county && mapAddress.county.code !== district.code ||
        mapAddress.township && street?.code !== mapAddress.township.code) {
      return { state: 'review', reason: '高德标准地址与诉求网格无法相互印证，待核验' };
    }
    // The provider point can corroborate a polygon. A grid name does not identify where inside it the complaint occurred.
    return { state: 'verified', evidence: { point, districtCode: district.code, districtName: district.name,
      streetCode: parts.township?.code ?? null, streetName: parts.township?.name ?? null, communityName: null,
      namedGrid: { name: input.gridName, districtCode: expectedCodes.length || row.district_name ? district.code : null,
        providerNameVerified, hasUsableReferencePoint } } };
  }
  if (!PRECISE_LEVELS.has(level) && !namedResidentialPlace) {
    const reason = `待纠偏：高德近似地址定位（${level}），地址、街道及网格待核验`;
    return { state: 'review', reason, point: { ...point, score: 60, source: reason } };
  }
  // A provider can return a plausible point for a different place. Require the submitted
  // location text (including its number if present) to still be in the validated match.
  if (!parts.local || mapAddress.local !== parts.local ||
      mapAddress.county && mapAddress.county.code !== district.code ||
      mapAddress.township && street?.code !== mapAddress.township.code) {
    return { state: 'review', reason: '高德标准地址与提取地点或门牌无法相互印证，待核验' };
  }

  return { state: 'verified', evidence: { point, districtCode: district.code, districtName: district.name,
    streetCode: street?.code ?? null, streetName: street?.name ?? null, communityName } };
}

interface GridMatch {
  code: string;
  name: string;
  source: string;
  version: string;
}

const NON_OFFICIAL_GEOMETRY = /\bOSM\b|OpenStreetMap|DataV|geo\.datav|过渡|底稿|近似|缓冲|推导|栅格|模拟|示意|占位|\bbuffer\b|\bderived\b|\braster\b/i;

export async function matchComplaintGridIn(tx: Tx, evidence: VerifiedAddress): Promise<{ grid: GridMatch | null; reason: string }> {
  // Master-data JSON contains only admitted `grid_boundary` imports / manual grid maintenance.
  // Check authorization provenance and the admitted coordinate system before using a row.
  const [rows] = await tx.query<any[]>(
    'select code,name,district_code,geometry,coordinate_system,geometry_source,version from admin_grid ' +
    'where (district_code=? and geometry is not null)' +
    (evidence.namedGrid ? ' or (name=? and (? is null or district_code=?))' : '') + ' order by code for share',
    evidence.namedGrid ? [evidence.districtCode, evidence.namedGrid.name, evidence.namedGrid.districtCode, evidence.namedGrid.districtCode]
      : [evidence.districtCode]);
  const fineGrids = rows.filter(row => !/^\d{6}(?:\d{3})?$/.test(String(row.code)) &&
    !isCimBoundarySource(String(row.code), row.geometry_source, 'community'));
  let namedGridCode: string | null = null;
  if (evidence.namedGrid) {
    const { name, districtCode, providerNameVerified, hasUsableReferencePoint } = evidence.namedGrid;
    const exact = fineGrids.filter(row => row.name === name && (!districtCode || row.district_code === districtCode));
    if (exact.length !== 1) return { grid: null, reason: exact.length ? '正式目录中有同名网格，网格待核验' : '正式目录未匹配诉求网格名称，网格待核验' };
    const [registered] = exact;
    namedGridCode = String(registered.code);
    if (!registered.geometry && districtCode && providerNameVerified) {
      return { grid: { code: namedGridCode, name, source: '正式网格目录', version: String(registered.version) },
        reason: '正式网格目录、高德网格名称与诉求区县一致，尚无正式边界' };
    }
    if (!hasUsableReferencePoint) return { grid: null, reason: '高德定位精度不足以核验正式边界，网格待核验' };
  }
  const hits: GridMatch[] = [];
  const point = [evidence.point.longitude, evidence.point.latitude];
  for (const row of fineGrids) {
    const code = String(row.code), source = String(row.geometry_source ?? '').trim();
    if (row.district_code !== evidence.districtCode || !row.geometry || row.coordinate_system !== 'WGS84' || !source || NON_OFFICIAL_GEOMETRY.test(source)) continue;
    let geometry;
    try { geometry = validateGeometry(typeof row.geometry === 'string' ? JSON.parse(row.geometry) : row.geometry); }
    catch { continue; }
    if (!geometry) continue;
    const position = classifyLocationBoundary(point, geometry);
    if (position === 'edge') return { grid: null, reason: '落点位于正式网格边界，网格待核验' };
    if (position === 'inside') hits.push({ code, name: String(row.name), source, version: String(row.version) });
  }
  if (hits.length !== 1) return { grid: null, reason: hits.length ? '落点命中多个正式网格，网格待核验' : '落点未命中适用的正式网格，网格待核验' };
  if (namedGridCode) return hits[0].code === namedGridCode
    ? { grid: hits[0], reason: '诉求网格名与正式目录唯一对应，高德位置参考落在该正式网格内' }
    : { grid: null, reason: '高德位置参考与诉求网格名称对应的正式边界不一致，网格待核验' };
  return { grid: hits[0], reason: '依据授权正式网格边界唯一空间匹配' };
}
