import { defineConfig, type UserConfig } from 'tsdown';
import { resolve } from 'node:path';
import { browserAotPlugin } from './scripts/browser-aot-plugin.mjs';
import { rawTextPlugin } from './scripts/raw-text-plugin.mjs';
import { KIMI_CORE_VERSION } from './scripts/kimi-core-version.mjs';

const isDev = process.env.KIMI_DESKTOP_DEV === '1';

// The engine's code-runtime imports bun:ffi at module load for its Windows
// job-object memory cap. Electron main cannot resolve that module, and the
// runtime itself executes in the Bun backend, so the main bundle resolves the
// specifier to a shim that reports the capability as unavailable.
const bunFfiShimPlugin = {
  name: 'kimi-bun-ffi-shim',
  resolveId(source: string) {
    if (source !== 'bun:ffi') return null;
    return resolve(import.meta.dirname, 'src/main/bun-ffi-unavailable.ts');
  },
};

const entries = {
  main: 'src/main/app/index.ts',
  preload: 'src/main/ipc/preload.ts',
  'browser-receipt-worker': 'src/main/browser/browser-receipt-worker.ts',
  'browser-control-preload': 'src/main/browser/browser-control-preload.ts',
  'browser-overlay-preload': 'src/main/browser/browser-overlay-preload.ts',
  shotPreload: 'src/main/screenshot/screenshot-overlay-preload.ts',
  shotPinPreload: 'src/main/screenshot/screenshot-pin-preload.ts',
};

export default defineConfig(Object.entries(entries).map(([name, entry]): UserConfig => ({
  entry: { [name]: entry },
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  outDir: 'out',
  clean: name === 'main',
  dts: false,
  minify: !isDev,
  fixedExtension: true,
  outputOptions: name === 'main' ? undefined : { codeSplitting: false },
  plugins: [rawTextPlugin(), bunFfiShimPlugin, ...(name.includes('preload') ? [browserAotPlugin()] : [])],
  define: {
    __KIMI_CORE_VERSION__: JSON.stringify(KIMI_CORE_VERSION),
  },
  deps: {
    alwaysBundle: [/^@moonshot-ai\//, /^typebox(?:\/|$)/],
    neverBundle: [
      'electron',
      'node-pty',
      'electron-updater',
      'canvas',
    ],
    onlyBundle: false,
  },
})));
