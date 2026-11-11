import { defineConfig } from 'vite'
import path from 'path'
import vue from '@vitejs/plugin-vue'
import inspect from 'vite-plugin-inspect'
import { viteExternalsPlugin } from 'vite-plugin-externals'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

export default defineConfig({
  base: './',
  plugins: [
    vue(),
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
    proxy: { "/api/v1": { target: process.env.SCREEN_API_TARGET || "http://127.0.0.1:3199", changeOrigin: true } },
    // 框架版不含任何后端接口。
    // 接入新项目时在此处按后端地址补充 server.proxy。
  },
})
