import React from 'react';
import ReactDOM, { Root } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import { BASE_PATH } from './api/request';
import './assets/styles/global.css';

let root: Root | null = null;

function render(props: any = {}) {
  const container = props.container
    ? props.container.querySelector('#root')
    : document.getElementById('root');

  root = ReactDOM.createRoot(container!);
  root.render(
    <React.StrictMode>
      <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#1677ff' } }}>
        {/*
         * basename 优先级：qiankun 注入的 basePath > 与 vite base 同源的 BASE_PATH。
         * dev（base '/'）下 BASE_PATH 为空串 → 回退 '/'，与改动前逐字符一致；
         * 生产挂 /gqxq/ 时为 '/gqxq'，否则路由匹配不到任何 path，页面直接白屏。
         */}
        <BrowserRouter basename={props.basePath || BASE_PATH || '/'}>
          <App />
        </BrowserRouter>
      </ConfigProvider>
    </React.StrictMode>
  );
}

if (!(window as any).__POWERED_BY_QIANKUN__) {
  render();
}

export async function bootstrap() {}

export async function mount(props: any) {
  render(props);
}

export async function unmount() {
  if (root) {
    root.unmount();
    root = null;
  }
}
