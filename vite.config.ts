import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Vite 워커는 기본이 ESM이지만 명시해둠(팀/미래 변경 대비)
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // dev 최적화에서 ffmpeg가 꼬이는 경우 방지
    exclude: ['@ffmpeg/ffmpeg'],
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
