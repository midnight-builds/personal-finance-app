import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev UX:
// - expose Vite server to LAN (so you can open http://your-server:5173)
// - proxy /api -> local API server to avoid CORS + localhost confusion
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
