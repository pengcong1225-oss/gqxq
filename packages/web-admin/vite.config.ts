import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import qiankun from 'vite-plugin-qiankun';
import path from 'path';

// 微前端：qiankun 的 import-html-entry 按传统脚本执行 HTML 中的 script 标签，
// @vitejs/plugin-react 注入的 react-refresh 前导是 type="module" 的内联脚本，会被当作
// 传统脚本执行而抛 "Cannot use import statement outside a module"。
// 该前导只服务于 Fast Refresh，作为子应用运行时去掉不影响功能。
function stripModulePreamble() {
  return {
    name: 'strip-react-refresh-module-preamble',
    // 只在构建时剥离：生产 qiankun 子应用不需要 react-refresh 前导；
    // dev 直连时必须保留，否则 @vitejs/plugin-react 检测不到 preamble，页面白屏。
    apply: 'build' as const,
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return html.replace(/<script type="module">[\s\S]*?@react-refresh[\s\S]*?<\/script>\s*/g, '');
      }
    }
  };
}


// 'useDevMode' 仅影响开发服务器；生产构建走标准 qiankun 生命周期导出。
export default defineConfig({
  // 独立域名部署用 '/'；被门户按子路径反代时用 VITE_BASE_PATH=/gqxq/
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react(), qiankun('gqxq-service', { useDevMode: true }), stripModulePreamble()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') }
  },
  server: {
    port: 5173,
    headers: {
      'Access-Control-Allow-Origin': '*'
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3100',
        changeOrigin: true
      }
    }
  }
});