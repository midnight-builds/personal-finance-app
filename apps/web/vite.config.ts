import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `vite` (development) talks to the demo API on 3101; `vite preview` is what
// the production service runs, and talks to the real API on 3001. A dev server
// therefore never reaches real data. API_TARGET overrides both.
// See docs/ENVIRONMENTS.md.
const apiProxy = (target: string) => ({
  '/api': {
    target: process.env.API_TARGET ?? target,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
});

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: Number(process.env.DEV_WEB_PORT ?? 5174),
    proxy: apiProxy('http://127.0.0.1:3101'),
  },
  preview: {
    host: true,
    port: 5173,
    proxy: apiProxy('http://127.0.0.1:3001'),
  },
});
