/**
 * 影像瓦片磁盘缓存中间件（dev / preview 生效）。
 *
 * 背景：CIM 0.5 米影像瓦片经第三方网关（59.208.236.145）转发，单张 0.4~0.8s；
 * 三维一屏几十张、拖拽旋转时反复请求同一批瓦片 → 体感很慢。
 * 这里按 z/x/y 落盘缓存 24 小时，二次进入/平移回看直接命中本地。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TILE_UPSTREAM = 'http://59.208.236.145';
const TILE_PATH = '/apps/gas-catering-risk/__deps/inspection/api/terminal/publicUtilities/map/wmts/tile';
const TTL_MS = 24 * 60 * 60 * 1000;

export function cimTileCachePlugin(): Plugin {
  const cacheDir = join(process.cwd(), 'node_modules', '.cache', 'cimtiles');
  let hits = 0;
  let misses = 0;

  const middleware = (req: any, res: any, next: () => void) => {
    const url: string = req.url || '';
    if (!url.startsWith('/cimtile')) return next();
    const qs = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    // Cesium WMTS provider 发送大写 LAYER/TILEMATRIX/TILEROW/TILECOL，URL 模板分支发送小写；统一大小写兼容
    const get = (name: string) => {
      const direct = qs.get(name);
      if (direct != null) return direct;
      const lower = name.toLowerCase();
      for (const [k, v] of qs) if (k.toLowerCase() === lower) return v;
      return '';
    };
    const layer = get('layer');
    const z = get('tilematrix');
    const y = get('tilerow');
    const x = get('tilecol');
    if (!z || !y || !x) return next();
    const key = createHash('sha1').update(`${layer}|${z}|${y}|${x}`).digest('hex');
    const file = join(cacheDir, `${key}.jpg`);

    const serve = (buf: Buffer) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'image/jpeg');
      res.setHeader('cache-control', 'public, max-age=86400');
      res.setHeader('x-cimtile-cache', hits + '/' + misses);
      res.end(buf);
    };

    (async () => {
      try {
        const st = await stat(file);
        if (Date.now() - st.mtimeMs < TTL_MS) {
          hits += 1;
          return serve(await readFile(file));
        }
      } catch {
        /* 未命中 */
      }
      misses += 1;
      try {
        const upstream = await fetch(`${TILE_UPSTREAM}${TILE_PATH}?${qs.toString()}`, {
          signal: AbortSignal.timeout(20_000),
        });
        const buf = Buffer.from(await upstream.arrayBuffer());
        if (upstream.status === 200 && buf.length > 0) {
          await mkdir(cacheDir, { recursive: true });
          await writeFile(file, buf).catch(() => undefined);
          return serve(buf);
        }
        res.statusCode = upstream.status || 502;
        res.setHeader('content-type', upstream.headers.get('content-type') ?? 'text/plain');
        res.end(buf);
      } catch (e) {
        res.statusCode = 504;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end(`cimtile upstream error: ${(e as Error).message}`);
      }
    })();
  };

  return {
    name: 'cim-tile-cache',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}