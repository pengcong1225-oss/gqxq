/**
 * 高德地图 Web 服务客户端（标书 1.2.12 指定的地图服务商）。
 *
 * 仅实现地址完善所需的两件事：
 *   1) 地理编码（地址 → 坐标）：/v3/geocode/geo
 *   2) 逆地理编码（坐标 → 行政区划/街道）：/v3/geocode/regeo
 *
 * 关键口径：
 *   - 高德返回 GCJ-02 坐标；平台位置字段统一按 WGS84/CGCS2000 存储，
 *     因此返回前必须做 GCJ-02 → WGS84 转换（复用 domain/utilityCoordinates）。
 *   - 只接受落在宜昌市域（含区县）的结果；越界或非 4205xx 一律视为无效，由调用方降级为"待纠偏"。
 *   - 不打印、不回传 key；失败只返回结构化原因，不抛网络细节。
 */
import {env} from '../config/env';
import {utilityGcj02ToWgs84} from '../domain/utilityCoordinates';

export interface AmapGeocodeResult {
  ok: boolean;
  /** WGS84 */
  longitude: number | null;
  latitude: number | null;
  /** 高德匹配级别（门牌号/兴趣点/道路/区县…） */
  level: string | null;
  adcode: string | null;
  district: string | null;
  township: string | null;
  formattedAddress: string | null;
  reason: string | null;
  failure?: 'retry' | 'review';
}

const EMPTY: AmapGeocodeResult = { ok: false, longitude: null, latitude: null, level: null, adcode: null, district: null, township: null, formattedAddress: null, reason: null };

/** 宜昌市行政区划码前缀：4205xx */
const YICHANG_PREFIX = '4205';
const isYichang = (adcode: string | null): boolean => !!adcode && adcode.startsWith(YICHANG_PREFIX);
const inBounds = (lng: number, lat: number): boolean => lng >= 110 && lng <= 112.3 && lat >= 29.5 && lat <= 31.8;

function amapKey(): string | null {
  const key = String(env.amapKey ?? '').trim();
  return key ? key : null;
}

/**
 * 高德个人/免费额度 QPS 很低（实测 3 次/秒即触发 CUQPS_HAS_EXCEEDED_THE_LIMIT），
 * 因此这里做两件事：① 全局串行 + 最小调用间隔；② QPS 错误退避重试。
 * 批量初始化是后台任务，串行牺牲吞吐换稳定，避免整批失败。
 */
const MIN_INTERVAL_MS = 400;
let queue: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callOnce(path: string, params: Record<string, string>): Promise<any | null> {
  const key = amapKey();
  if (!key) return null;
  const url = new URL(path, env.amapBaseUrl);
  for (const [k, v] of Object.entries(params)) if (v !== '') url.searchParams.set(k, v);
  url.searchParams.set('key', key);
  url.searchParams.set('output', 'JSON');
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** 串行化 + 限速 + QPS 退避；返回 null 表示不可重试的失败。 */
async function call(path: string, params: Record<string, string>): Promise<any | null> {
  if (!amapKey()) return null;
  const run = async (): Promise<any | null> => {
    const gap = Date.now() - lastCallAt;
    if (gap < MIN_INTERVAL_MS) await wait(MIN_INTERVAL_MS - gap);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      lastCallAt = Date.now();
      const body = await callOnce(path, params);
      if (!body) return null;
      const info = String(body.info ?? '');
      const qpsLimited = String(body.status) !== '1' && /CUQPS|QPS|LIMIT/i.test(info);
      if (!qpsLimited) return body;
      await wait(600 * (attempt + 1));
    }
    return null;
  };
  const next = queue.then(run, run);
  queue = next.catch(() => null);
  return next;
}

const str = (v: unknown): string | null => (v === null || v === undefined || v === '' || Array.isArray(v) ? null : String(v));

/** 地址 → WGS84 坐标（失败返回 ok=false + reason，不抛异常）。 */
export async function amapGeocode(address: string): Promise<AmapGeocodeResult> {
  if (!amapKey()) return { ...EMPTY, reason: '未配置 GQXQ_AMAP_KEY' };
  const keyword = address.trim();
  if (!keyword) return { ...EMPTY, reason: '地址为空' };
  // 防"强制匹配"：city=宜昌 + citylimit 会让高德把外地地址硬凑成宜昌点位
  // （实测"北京市朝阳区建国路1号"被匹配成当阳市门址）。地址里显式写了非湖北/宜昌的城市就拒绝。
  const cityTokens = (keyword.match(/[一-鿿]{2,8}?(?:市|自治州|地区|盟)/g) ?? []).filter(
    (token) => !/宜昌|湖北/.test(token),
  );
  if (cityTokens.length) return { ...EMPTY, failure: 'review', reason: '地址指向其他城市，需人工核验' };
  const body = await call('/v3/geocode/geo', { address: keyword, city: '宜昌', citylimit: 'true' });
  if (!body) return { ...EMPTY, reason: '高德地理编码请求失败' };
  if (String(body.status) !== '1') return { ...EMPTY, reason: '高德返回错误：' + String(body.info ?? 'unknown') };
  const matches = Array.isArray(body.geocodes) ? body.geocodes : [];
  if (matches.length > 1) return { ...EMPTY, failure: 'review', reason: '高德返回多个地址匹配，需人工核验' };
  const first = matches[0];
  const location = str(first?.location);
  if (!first || !location) return { ...EMPTY, failure: 'review', reason: '高德未返回可确认地址，需人工核验' };
  const [gcjLng, gcjLat] = location.split(',').map(Number);
  if (!Number.isFinite(gcjLng) || !Number.isFinite(gcjLat)) return { ...EMPTY, reason: '高德坐标格式无效' };
  const [lng, lat] = utilityGcj02ToWgs84(gcjLng, gcjLat);
  const adcode = str(first.adcode);
  if (!inBounds(lng, lat)) return { ...EMPTY, failure: 'review', reason: '匹配结果不在宜昌市域范围内' };
  if (!isYichang(adcode)) return { ...EMPTY, failure: 'review', reason: '高德匹配的行政区划不在宜昌市' };
  return {
    ok: true,
    longitude: lng,
    latitude: lat,
    level: str(first.level),
    adcode,
    district: str(first.district),
    township: str(first.township),
    formattedAddress: str(first.formatted_address),
    reason: null,
  };
}

/** WGS84 坐标 → 行政区划/街道（供校验区县一致、补街道线索）。 */
export async function amapRegeocode(longitude: number, latitude: number): Promise<AmapGeocodeResult> {
  if (!amapKey()) return { ...EMPTY, reason: '未配置 GQXQ_AMAP_KEY' };
  // 逆地理编码要求输入 GCJ-02：这里把 WGS84 反算回 GCJ-02
  const [gcjLng, gcjLat] = (await import('../domain/utilityCoordinates')).utilityWgs84ToGcj02(longitude, latitude);
  const body = await call('/v3/geocode/regeo', { location: gcjLng.toFixed(6) + ',' + gcjLat.toFixed(6), extensions: 'base' });
  if (!body) return { ...EMPTY, reason: '高德逆地理编码请求失败' };
  if (String(body.status) !== '1') return { ...EMPTY, reason: '高德返回错误：' + String(body.info ?? 'unknown') };
  const regeocode = body.regeocode;
  const component = regeocode?.addressComponent;
  if (!component) return { ...EMPTY, reason: '高德逆地理编码无结果' };
  const adcode = str(component.adcode);
  const city = str(component.city) ?? str(component.province);
  if (!isYichang(adcode)) return { ...EMPTY, failure: 'review', reason: '逆地理编码结果不属于宜昌市（' + String(city ?? '—') + '）' };
  return {
    ok: true,
    longitude,
    latitude,
    level: null,
    adcode,
    district: str(component.district),
    township: str(component.township),
    formattedAddress: str(regeocode.formatted_address),
    reason: null,
  };
}

export function amapConfigured(): boolean {
  return amapKey() !== null;
}
