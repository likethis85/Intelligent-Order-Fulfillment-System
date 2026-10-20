import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [inspectAttr(), react()],
  server: {
    host: true,
    port: 3700,
    // 端口被占用时直接报错，避免静默切到 3701 导致统一登录回调地址对不上
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3737',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://127.0.0.1:3737',
        changeOrigin: true,
      },
      '/fabric': {
        target: 'http://127.0.0.1:3737',
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
