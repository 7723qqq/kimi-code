import { fileURLToPath } from 'node:url';

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

import { kimiCodeWebPlugin } from './src/vite-plugin';

export default defineConfig({
  plugins: [vue(), kimiCodeWebPlugin()],
  define: {
    __KIMI_CODE_WEB_WORK_DIR__: JSON.stringify(process.cwd()),
    __KIMI_CODE_WEB_VERSION__: JSON.stringify(process.env['npm_package_version'] ?? '0.0.0'),
  },
  resolve: {
    alias: {
      '#': fileURLToPath(new URL('./src', import.meta.url)),
      '@moonshot-ai/kimi-code-sdk/browser': fileURLToPath(
        new URL('../../packages/node-sdk/dist/browser.mjs', import.meta.url),
      ),
    },
  },
  server: {
    port: Number(process.env['WEB_PORT']) || 5173,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
