import { defineConfig } from 'vite'
import path from 'path'
import vue from '@vitejs/plugin-vue'
import inspect from 'vite-plugin-inspect'
import { viteExternalsPlugin } from 'vite-plugin-externals'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { cimTileCachePlugin } from './vite-plugin-cimtile'

/**
 * CIM 受控代理（dev / preview 有效；生产由 nginx 承担同样职责）
 * 前端 cim.json 只写 /cim 相对路径；真实地址与 X-ACCESS-TOKEN 注入只在服务端/代理完成。
 */
const CIM_ORIGIN = 'https://drs.sc.yichang.gov.cn'
const TOKEN_PATH = '/onemap/getToken?apiCode=1'

function cimProxyPlugin() {
  let cache = null

  function tokenExpiresAt(token) {
    try {
      const jwt = Buffer.from(token, 'base64').toString('utf8')
      const payloadB64 = jwt.split('.')[1]
      if (!payloadB64) throw new Error('not jwt')
      const json = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'))
      const sec = Number(json.expire_time)
      if (Number.isFinite(sec) && sec > 0) return sec > 1e12 ? sec : sec * 1000
    } catch {
      /* 忽略：走默认 8 小时 */
    }
    return Date.now() + 8 * 60 * 60 * 1000
  }

  async function getAccessToken(force = false) {
    if (!force && cache && Date.now() < cache.expiresAt - 60_000) return cache.token
    const delays = [0, 400, 1_200, 2_500]
    let lastErr = null
    for (const [idx, wait] of delays.entries()) {
      if (wait) await new Promise((r) => setTimeout(r, wait))
      try {
        const res = await fetch(`${CIM_ORIGIN}${TOKEN_PATH}`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) throw new Error(`CIM token HTTP ${res.status}`)
        const body = await res.json()
        if (!body?.data) throw new Error('CIM token 响应缺少 data')
        const expiresAt = tokenExpiresAt(body.data)
        cache = { token: body.data, expiresAt: Math.min(expiresAt, Date.now() + 8 * 60 * 60 * 1000) }
        if (idx > 0) console.info(`[cim-proxy] token 第 ${idx + 1} 次尝试获取成功`)
        return cache.token
      } catch (e) {
        lastErr = e
        console.warn(`[cim-proxy] token 获取失败（第 ${idx + 1}/${delays.length} 次）：${lastErr.message}`)
      }
    }
    if (cache && Date.now() < cache.expiresAt) {
      console.warn('[cim-proxy] 沿用上次成功的 token（stale），等待下轮刷新')
      return cache.token
    }
    throw lastErr ?? new Error('CIM token 获取失败')
  }

  async function handleCim(req, res, next) {
    const rawUrl = req.url || '/'
    const path = rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`
    const target = `${CIM_ORIGIN}${path}`
    const method = (req.method || 'GET').toUpperCase()
    // 超图 iClient3D 加载 S3M 时会对 iServer 发 POST（login.json / datas 等），只对 iServer 路径放行 POST。
    const isIserverPath = /\/iserver\/services\//.test(path)
    const allowPost = method === 'POST' && isIserverPath
    if (method !== 'GET' && method !== 'HEAD' && !allowPost) {
      res.statusCode = 405
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end('CIM proxy only supports GET/HEAD (POST allowed for iServer paths)')
      return
    }
    const reqBody = allowPost
      ? await new Promise((resolve) => {
          const chunks = []
          req.on('data', (c) => chunks.push(Buffer.from(c)))
          req.on('end', () => resolve(Buffer.concat(chunks)))
          req.on('error', () => resolve(Buffer.alloc(0)))
        })
      : undefined

    const isTokenCall = path.startsWith('/onemap/getToken')
    let token = ''
    if (!isTokenCall) {
      try {
        token = await getAccessToken()
      } catch (e) {
        console.warn('[cim-proxy] token 获取失败：', e.message)
      }
    }

    const headers = { Accept: req.headers?.accept || '*/*' }
    if (token) headers['X-ACCESS-TOKEN'] = token
    headers['X-Requested-With'] = 'XMLHttpRequest'

    const doFetch = async () =>
      fetch(target, {
        method,
        headers: reqBody ? { ...headers, 'content-type': String(req.headers?.['content-type'] ?? 'application/json') } : headers,
        body: reqBody,
        signal: AbortSignal.timeout(30_000),
        redirect: 'follow',
      })

    let upstream
    try {
      upstream = await doFetch()
    } catch (e) {
      res.statusCode = 502
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(`CIM upstream error: ${e.message}`)
      return
    }

    // token 失效：清缓存并重取一次再转发（HTTP 401/403）
    if ((upstream.status === 401 || upstream.status === 403) && !isTokenCall) {
      try {
        headers['X-ACCESS-TOKEN'] = await getAccessToken(true)
        upstream = await doFetch()
      } catch {
        /* 保留第一次响应 */
      }
    }

    let body = method === 'HEAD' ? null : Buffer.from(await upstream.arrayBuffer())
    let ctype = upstream.headers.get('content-type')

    // 网关瓦片鉴权失败的坑：HTTP 200 但 body 是 JSON {"code":401,...tip-token...}
    const looksJson = (ctype || '').includes('json')
    if (body && looksJson && !isTokenCall) {
      const text = body.toString('utf8')
      if (text.includes('"code":401') || text.includes('token无效')) {
        try {
          headers['X-ACCESS-TOKEN'] = await getAccessToken(true)
          upstream = await doFetch()
          body = method === 'HEAD' ? null : Buffer.from(await upstream.arrayBuffer())
          ctype = upstream.headers.get('content-type')
        } catch {
          /* 仍失败：原样返回网关错误体，前端据此降级显示（不伪造瓦片） */
        }
      }
    }

    res.statusCode = upstream.status
    if (ctype) res.setHeader('content-type', ctype)
    res.setHeader('cache-control', 'no-store')
    if (req.method === 'HEAD' || !body) {
      res.end()
      return
    }
    res.setHeader('content-length', String(body.length))
    res.end(body)
    void next
  }

  return {
    name: 'cim-controlled-proxy',
    configureServer(server) {
      server.middlewares.use('/cim', (req, res) => {
        void handleCim(req, res, () => undefined)
      })
      void getAccessToken().catch(() => undefined)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/cim', (req, res) => {
        void handleCim(req, res, () => undefined)
      })
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [
    vue(),
    cimProxyPlugin(),
    cimTileCachePlugin(),
    // 使用 index.html 中引入的超图版 Cesium，避免再打包另一套引擎
    viteExternalsPlugin({ 'mars3d-cesium': 'Cesium' }, { useWindow: true }),
    inspect(),
    AutoImport({ resolvers: [ElementPlusResolver()] }),
    Components({ resolvers: [ElementPlusResolver()] }),
  ],
  build: {
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4000,
    commonjsOptions: {
      include: /node_modules|packages/,
    },
  },
  esbuild: {
    drop: ['debugger'],
    pure: ['console.log', 'console.info', 'console.debug'],
  },
  optimizeDeps: {
    include: ['mars3d', 'mars3d-cesium'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 8002,
    host: true,
    open: false,
    /**
     * 文件监听忽略规则 —— 修 EBUSY 崩溃。
     *
     * 问题：某些写文件的工具（编辑器的原子写、DSH 的 edit 工具等）会在目标文件同目录下
     * 创建 `.<name>.<pid>.<uuid>.tmpdir/` 临时目录再改名。vite 的 chokidar watcher 会去
     * watch 这个临时文件，而临时文件的句柄此时正被写入方持有 → Windows 抛
     * `EBUSY: resource busy or locked, watch ...tmpdir\*.tmp`，直接把整个 dev server 干掉。
     * 实测本仓库已因此崩过 3 次。
     *
     * 处理：忽略所有隐藏临时目录与临时后缀，从源头不让 watcher 碰到它们。
     */
    watch: {
      ignored: [
        '**/.*.tmpdir/**',
        '**/*.tmpdir/**',
        '**/*.tmp',
        '**/.git/**',
        '**/dist/**',
        '**/node_modules/.cache/**',
      ],
    },
    proxy: {
      // 业务接口：真实诉求平台 gqxq/server（生产由 nginx 反代同一相对路径）
      '/api/v1': { target: process.env.SCREEN_API_TARGET || 'http://127.0.0.1:3100', changeOrigin: true },
      // /cimtile 由 cimTileCachePlugin 在 proxy 之前拦截（磁盘缓存 24h，无需再配 proxy 规则）
    },
  },
})
