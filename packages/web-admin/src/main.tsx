import React from 'react';
import ReactDOM, { Root } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { qiankunWindow, renderWithQiankun } from 'vite-plugin-qiankun/dist/helper';
import App from './App';
import { useAppStore } from './stores/appStore';
import { authStorage } from './stores/sessionStorage';
import { BASE_PATH } from './api/request';
import { exchangePlatformToken, getOidcStatus } from './api/auth';
import './assets/styles/global.css';


const portalOrigins = new Set([
  'http://127.0.0.1:8080',
  'https://zhuxin-service.sanxiacloud.net',
  ...(import.meta.env.VITE_PLATFORM_PORTAL_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
]);
let portalGeneration = 0;
let pendingPlatformToken: string | undefined;
let appliedPlatformToken: string | undefined;

async function applyPlatformToken(token: string) {
  if (!token || token === pendingPlatformToken || (token === appliedPlatformToken && useAppStore.getState().token)) return;
  const status = await getOidcStatus().catch(() => null);
  if (!status || status.enabled) return;
  if (token === pendingPlatformToken || (token === appliedPlatformToken && useAppStore.getState().token)) return;
  const generation = ++portalGeneration;
  pendingPlatformToken = token;
  useAppStore.getState().logout();
  try {
    const result = await exchangePlatformToken(token);
    if (generation !== portalGeneration) return;
    const state = useAppStore.getState();
    state.setUserInfo(result.userInfo);
    state.setToken(result.token);
    state.setPortalError(null);
    appliedPlatformToken = token;
  } catch (error) {
    if (generation === portalGeneration) {
      useAppStore.getState().setPortalError(error instanceof Error ? error.message : '门户授权暂不可用');
    }
  } finally {
    if (generation === portalGeneration) pendingPlatformToken = undefined;
  }
}

function clearPortalSession() {
  portalGeneration++;
  pendingPlatformToken = undefined;
  appliedPlatformToken = undefined;
  authStorage.removeItem('user');
  useAppStore.getState().logout();
  if (!window.location.pathname.includes('/login')) window.location.reload();
}

function installPortalBridge() {
  if (window.parent !== window) {
    void getOidcStatus().then(({ enabled }) => {
      if (enabled) return;
      window.addEventListener('message', (event) => {
        if (event.source !== window.parent || !portalOrigins.has(event.origin)) return;
        const data = event.data as { type?: string; token?: unknown } | null;
        if (data?.type === 'zhuxin:logout') clearPortalSession();
        if (data?.type === 'zhuxin:token' && typeof data.token === 'string') void applyPlatformToken(data.token);
      });
      if (document.referrer) {
        const parentOrigin = new URL(document.referrer).origin;
        if (portalOrigins.has(parentOrigin)) {
          useAppStore.getState().logout();
          window.parent.postMessage({ type: 'zhuxin:token-request' }, parentOrigin);
        }
      }
    }).catch(() => {});
  }
  window.addEventListener('zhuxin:logout', clearPortalSession);
  window.addEventListener('storage', (event) => {
    if (event.key === 'zhuxin_logout_at') clearPortalSession();
  });
}

/**
 * 开发模式兼容：vite-plugin-qiankun(useDevMode) 会把 base 改成 '/'，导致 BASE_PATH=''，
 * 直接用 /gqxq/ 访问会路由不匹配（白屏）。这里按实际路径前缀兜底，生产仍以 BASE_PATH 为准。
 */
function basenameForLocation(): string {
  const p = window.location.pathname;
  if (p.startsWith('/gqxq/') || p === '/gqxq') return '/gqxq';
  return BASE_PATH || '/';
}
let root: Root | null = null;

function render(props: any = {}) {
  // 作为子应用时只能渲染到平台给的容器，退回 document#root 会覆盖门户整棵树。
  const poweredByQiankun = Boolean(qiankunWindow.__POWERED_BY_QIANKUN__);
  const container = props.container
    ? props.container.querySelector('#root')
    : poweredByQiankun ? null : document.getElementById('root');
  if (!container) throw new Error('诉求应用缺少挂载容器，拒绝渲染到门户根节点');

  root = ReactDOM.createRoot(container);
  root.render(
    <React.StrictMode>
      <ConfigProvider locale={zhCN} theme={{
        token: {
          colorPrimary: '#1677ff', borderRadius: 8,
          fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif",
        },
        components: {
          Table: { headerBg: '#fafbfc' },
          Menu: { itemHeight: 44 },
          Layout: { bodyBg: '#f5f7fa' },
        },
      }}>
        {/*
         * basename 优先级：qiankun 注入的 basePath（平台路由 activeRule）> 与 vite base 同源的 BASE_PATH。
         * 嵌入门户时 URL 是 /apps/<appCode>，只有用 activeRule 作 basename 才能匹配到本应用路由。
         */}
        <BrowserRouter basename={props.basePath || basenameForLocation()}>
          <App />
        </BrowserRouter>
      </ConfigProvider>
    </React.StrictMode>
  );
}

/**
 * 入口脚本在 <head> 里用内联 `import(...)` 动态加载，属于经典脚本、会**立即执行**；
 * 而动态 import 在资源被缓存时几乎立刻 resolve —— 此时 <body> 还没解析完，
 * document.getElementById('root') 为 null，render() 会抛
 * 「诉求应用缺少挂载容器」。表现为：第一次打开正常，再进来白屏（缓存越快越容易踩到）。
 * 所以必须等 DOM 就绪后再挂载。
 */
function whenDomReady(fn: () => void): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}

// 作为子应用或被内嵌时，跟随门户退出。
installPortalBridge();

renderWithQiankun({
  bootstrap() {},
  mount(props: any) {
    if (typeof props.accessToken === 'string') void applyPlatformToken(props.accessToken);
    render(props);
  },
  unmount() {
    if (root) {
      root.unmount();
      root = null;
    }
  },
  update(props: any) {
    render(props);
  }
});

if (!qiankunWindow.__POWERED_BY_QIANKUN__) {
  whenDomReady(() => render());
}
