/**
 * 三维白模页的**数据面**：场景枚举 / 场景文档 / 数据集配置 全部走既有 vite `/cim` 受控代理
 * （token 只由代理在服务端换取并注入 X-ACCESS-TOKEN，前端不持有任何凭据）。
 *
 * 实测（2026-11-12，dev 5191 经代理）：
 *  - `GET {REALSPACE}/scenes.json`              → 200，10 个场景；但 `path` 字段是内网绝对地址
 *    `http://10.55.176.56:30003/...`（公网不可达），前端一律不用它，只用 `name`。
 *  - `GET {REALSPACE}/scenes/{scene}.json`      → 200，含相机位姿与图层（dataName / dataConfigPath / isWebDatasource=false）。
 *  - `GET {REALSPACE}/datas/{scene}/config`     → 200，S3M 瓦片索引（城区 804 个瓦片）+ geoBounds + `s3m:FileType=OSGBCacheFile`。
 *  - `GET .../datas/{scene}/Tile_xxx.s3mb`      → 200 `application/s3mb`（真实 S3M 瓦片，代理注入 token 后可取）。
 *
 * 以上都是**真实数据请求**；页面不生成任何假几何。
 */

/** iServer 3D 服务（经 /cim 代理） */
export const CIM_3D_PREFIX =
  '/cim/api/restapi/prod/IC42050020260922000001/iserver/services/3D-qsbm-new-jitter-qx';

/** realspace 根路径：scenes / datas / login 都挂在它下面 */
export const REALS_PACE = `${CIM_3D_PREFIX}/rest/realspace`;

/** 10 个区县场景（客户口径全量；已由 scenes.json 实测确认） */
export interface CimScene {
  /** 场景名 / 数据集名（两者同名） */
  key: string;
  /** 中文名（展示用） */
  district: string;
  /** 场景中心坐标（由 scenes.json 顺序与客户口径对应，仅用于选择器排序，不参与贴图） */
  order: number;
}

export const CIM_SCENES: CimScene[] = [
  { key: 'yilingqu_jitter', district: '夷陵区', order: 1 },
  { key: 'chengqu_jitter', district: '城区', order: 2 },
  { key: 'zhijiang_jitter', district: '枝江市', order: 3 },
  { key: 'zigui_jitter', district: '秭归县', order: 4 },
  { key: 'yuanan_jitter', district: '远安县', order: 5 },
  { key: 'changyang_jitter', district: '长阳土家族自治县', order: 6 },
  { key: 'dangyang_jitter', district: '当阳市', order: 7 },
  { key: 'wufeng_jitter', district: '五峰土家族自治县', order: 8 },
  { key: 'xingshan_jitter', district: '兴山县', order: 9 },
  { key: 'yidu_jitter', district: '宜都市', order: 10 },
];

export function findScene(key: string): CimScene | undefined {
  return CIM_SCENES.find((s) => s.key === key);
}

export interface SceneDocCamera {
  longitude?: number;
  latitude?: number;
  altitude?: number;
  heading?: number;
  tilt?: number;
}

export interface SceneDocLayer {
  name?: string;
  caption?: string;
  dataName?: string;
  dataConfigPath?: string;
  isWebDatasource?: boolean;
  layer3DType?: string;
}

export interface SceneDoc {
  name?: string;
  camera?: SceneDocCamera;
  layers?: SceneDocLayer[];
}

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface DatasetConfig {
  crs?: string;
  dataType?: string;
  geoBounds?: { left: number; right: number; bottom: number; top: number };
  position?: { x: number; y: number; z?: number };
  tiles?: unknown[];
  extensions?: Record<string, unknown>;
}

/** 统一的取数错误：带上 HTTP 状态，页面据此区分「未授权 / 404 / 网络不可达」 */
export class CimFetchError extends Error {
  status: number;
  url: string;
  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = 'CimFetchError';
    this.status = status;
    this.url = url;
  }
}

async function getJson<T>(path: string, timeoutMs = 20_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(path, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
  } catch (e) {
    const msg = (e as Error)?.name === 'AbortError' ? `请求超时（${timeoutMs / 1000}s）` : (e as Error).message;
    throw new CimFetchError(`CIM 代理不可达：${msg}`, 0, path);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let body = '';
    try {
      body = (await res.text()).slice(0, 200);
    } catch {
      /* 忽略 */
    }
    const hint =
      res.status === 401 || res.status === 403
        ? 'iServer 未授权（需 AK/SK 或 SSO）'
        : res.status === 404
          ? '资源不存在（路径或场景名不匹配）'
          : res.status === 502
            ? '代理上游不可达'
            : 'iServer 返回异常';
    throw new CimFetchError(`${hint}：HTTP ${res.status}${body ? ` · ${body}` : ''}`, res.status, path);
  }
  try {
    return (await res.json()) as T;
  } catch {
    const head = await res.text().catch(() => '');
    throw new CimFetchError(`响应不是 JSON（可能被网关换成登录页/HTML）：${head.slice(0, 120)}`, res.status, path);
  }
}

/** 场景枚举：返回真实场景名列表；`path` 字段是内网地址，丢弃不用 */
export async function fetchSceneNames(): Promise<string[]> {
  const list = await getJson<{ name?: string; path?: string }[]>(`${REALS_PACE}/scenes.json`);
  const names = (Array.isArray(list) ? list : [])
    .map((s) => s?.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
  if (!names.length) throw new CimFetchError('scenes.json 未返回任何场景', 200, `${REALS_PACE}/scenes.json`);
  return names;
}

/** 场景文档：相机位姿 + 图层清单（用于定位相机 / 说明图层来源） */
export function fetchSceneDoc(scene: string): Promise<SceneDoc> {
  return getJson<SceneDoc>(`${REALS_PACE}/scenes/${encodeURIComponent(scene)}.json`);
}

/** 数据集配置：S3M 瓦片索引 + 空间范围（真实文件，城区约 176 KB / 804 瓦片） */
export function fetchDatasetConfig(scene: string): Promise<DatasetConfig> {
  return getJson<DatasetConfig>(`${REALS_PACE}/datas/${encodeURIComponent(scene)}/config`, 40_000);
}

/** geoBounds → 经纬度范围（iServer 用 left/right/bottom/top，轴序是经/纬） */
export function toBounds(cfg: DatasetConfig | null, doc: SceneDoc | null): Bounds | null {
  const g = cfg?.geoBounds;
  if (g && [g.left, g.right, g.bottom, g.top].every((v) => Number.isFinite(v))) {
    return { west: g.left, south: g.bottom, east: g.right, north: g.top };
  }
  const c = doc?.camera;
  if (c && Number.isFinite(c.longitude) && Number.isFinite(c.latitude)) {
    // 场景文档没有范围时，用相机点兜一个 0.05° 视窗（仅用于相机定位，不代表数据范围）
    return {
      west: (c.longitude as number) - 0.05,
      south: (c.latitude as number) - 0.05,
      east: (c.longitude as number) + 0.05,
      north: (c.latitude as number) + 0.05,
    };
  }
  return null;
}

/** S3M 图层配置地址（超图 iClient3D 的 addS3MTilesLayerByScp 入参，文档口径） */
export function datasetConfigUrl(scene: string): string {
  return `${REALS_PACE}/datas/${encodeURIComponent(scene)}/config`;
}

/**
 * iClient 登录握手探测：
 *  超图 iClient3D 在加载 S3M 图层前会 `GET login.json`（拿 random/jsessionID）再 `POST login.json`。
 *  本项目的 dev 代理只放行 GET/HEAD，POST 会被 405 拒绝；而直接打上游网关同路径 POST 返回 404。
 *  这里**真实探测一次**，把结果如实写进状态条，而不是猜。
 */
export async function probeLoginHandshake(): Promise<{
  getStatus: number | null;
  postStatus: number | null;
  postBody: string;
  ok: boolean;
  reason: string;
}> {
  const url = `${REALS_PACE}/login.json`;
  let getStatus: number | null = null;
  let postStatus: number | null = null;
  let postBody = '';
  try {
    const g = await fetch(url, { headers: { Accept: 'application/json' } });
    getStatus = g.status;
  } catch {
    getStatus = null;
  }
  try {
    const p = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Accept: 'application/json' },
      body: '{"jsessionID":"0","random":"0"}',
    });
    postStatus = p.status;
    postBody = (await p.text()).slice(0, 160);
  } catch (e) {
    postStatus = null;
    postBody = (e as Error).message;
  }
  const ok = postStatus !== null && postStatus >= 200 && postStatus < 300;
  const reason = ok
    ? 'login.json 握手可用'
    : postStatus === 405
      ? '代理仅放行 GET/HEAD，iClient 的 login.json（POST）被 405 拒绝'
      : postStatus === 404
        ? '上游网关未路由 login.json 的 POST（404 Route Not Found）'
        : `login.json POST 失败（${postStatus ?? '网络错误'}）`;
  return { getStatus, postStatus, postBody, ok, reason };
}