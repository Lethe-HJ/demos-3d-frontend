import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [['babel-plugin-react-compiler']],
      },
    }),
  ],
  // 定义全局常量，支持分支编译（dead code elimination）
  // 在构建时会进行静态替换，生产环境下 if (__DEV__) 内的代码会被完全移除
  define: {
    __DEV__: 'import.meta.env.DEV',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      // 代理 /api 请求到后端服务器
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        rewrite: (path) => {
          const newPath = path.replace(/^\/api/, '');
          console.log(`[代理] ${path} -> http://127.0.0.1:8080${newPath}`);
          return newPath;
        },
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            console.log(`[代理请求] ${req.method} ${req.url} -> ${proxyReq.path}`);
          });
          proxy.on('proxyRes', (proxyRes, req) => {
            console.log(`[代理响应] ${req.method} ${req.url} -> ${proxyRes.statusCode} ${proxyRes.statusMessage}`);
          });
          proxy.on('error', (err, req) => {
            console.error(`[代理错误] ${req.method} ${req.url}:`, err.message);
          });
        },
      },
    },
  },
})
