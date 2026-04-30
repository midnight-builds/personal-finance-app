import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev + preview: expose to LAN and proxy /api -> API server (port 3001)
const apiProxy = {
  '/api': {
    target: 'http://127.0.0.1:3001',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: apiProxy,
  },
  preview: {
    host: true,
    port: 5173,
    proxy: apiProxy,
  },
});
