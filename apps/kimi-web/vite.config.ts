/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

const webPort = Number(process.env.WEB_PORT) || 5175;
// Where the dev proxy forwards daemon traffic. Defaults to the local daemon
// (or `pnpm dev:stub`). Override to point dev at another daemon instance.
const daemonTarget = process.env.KIMI_DAEMON_URL || 'http://127.0.0.1:7878';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    port: webPort,
    strictPort: false,
    // Same-origin dev: the browser calls Vite, Vite forwards to the daemon.
    // No CORS anywhere. The real daemon serves REST + WS all under /api/v1.
    proxy: {
      '/api/v1': { target: daemonTarget, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
