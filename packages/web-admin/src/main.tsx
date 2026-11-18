import React from 'react';
import ReactDOM, { Root } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { qiankunWindow, renderWithQiankun } from 'vite-plugin-qiankun/dist/helper';
import App from './App';
import { useAppStore } from './stores/appStore';
import { BASE_PATH } from './api/request';
import './assets/styles/global.css';


/**
 * 统一退出：门户退出时清掉本应用会话并回到本应用登录页。
 *
 * 支持三种信号（与门户的 logoutBridge 约定一致）：
 *   postMessage（iframe/父窗口）、同窗口事件（qiankun）、storage 信号（同源页签）。
 */
function installLogoutBridge() {
  const clear = () => {
    try {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
    } catch {
      // 忽略：存储不可用时后端令牌已撤销，刷新即可。
    }
    useAppStore.getState().logout();
    if (!window.location.pathname.includes('/login')) {
      window.location.reload();
    }
  };
  window.addEventListener('message', (event) => {
    const type = (event.data as { type?: string } | null)?.type;
    if (type === 'zhuxin:logout') clear();
  });
  window.addEventListener('zhuxin:logout', clear);
  window.addEventListener('storage', (event) => {
    if (event.key === 'zhuxin_logout_at') clear();
  });
}


/**
 * 跨域内嵌时的令牌握手。
 *
 * 独立域名后，本应用读不到门户的 localStorage，改由门户 postMessage 推送平台令牌：
 *   1. 挂载后先向父窗口要一次（zhuxin:token-request）；
 *   2. 收到 zhuxin:token 就存入本地并刷新登录态。
 * 独立打开（非内嵌）时这段逻辑不生效，仍按自己的登录流程走。
 */
function installEmbeddedAuth() {
  if (window.parent === window) return;

  const apply = (token: string) => {
    if (!token) return;
    localStorage.setItem('token', token);
    useAppStore.getState().setToken(token);
  };

  window.addEventListener('message', (event) => {
    const data = event.data as { type?: string; token?: string } | null;
    if (data?.type === 'zhuxin:token' && data.token) apply(data.token);
  });

  // 父窗口可能在我准备好之前就发过了，主动要一次
  try {
    window.parent.postMessage({ type: 'zhuxin:token-request' }, '*');
  } catch {
    // 极少数跨域策略下可能失败，不影响用户手工登录
  }
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

// 作为子应用或被内嵌时，跟随门户退出。
installLogoutBridge();
installEmbeddedAuth();

renderWithQiankun({
  bootstrap() {},
  mount(props: any) {
    // 统一身份：平台已登录时把平台令牌写入本应用会话存储，
    // 本应用随后的接口调用携带该令牌，由后端按 platform_identity 绑定解析身份。
    // 平台令牌只用于证明"你是谁"，本应用的角色与权限仍由本地库决定。
    if (props.accessToken) {
      localStorage.setItem('token', props.accessToken);
      if (props.user) localStorage.setItem('user', JSON.stringify(props.user));
      // store 在模块加载时就从 localStorage 读了 token（此时平台还没注入），
      // 这里必须回写一次，否则路由守卫仍判定为未登录、把用户挡在自己的登录页。
      useAppStore.getState().setToken(props.accessToken);
    }
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
  render();
}
