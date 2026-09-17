import React from 'react';
import ReactDOM, { Root } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
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
        <BrowserRouter basename={props.basePath || '/'}>
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
