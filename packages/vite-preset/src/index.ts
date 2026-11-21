import { execFileSync } from 'node:child_process';

import vue from '@vitejs/plugin-vue';
import type { UserConfig } from 'vite';

import { kimiIconPlugins } from './iconPlugins';

function resolveCommitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function resolveBranch(): string {
  const fromEnv = process.env['GITHUB_REF_NAME'];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return fromEnv.trim();
  }
  try {
    return execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

export interface KimiRendererViteOptions {
  readonly root: string;
  readonly iconsDir: string;
  readonly defines?: Record<string, string>;
  readonly target?: string;
}

export function kimiRendererViteConfig(opts: KimiRendererViteOptions): UserConfig {
  const { root, iconsDir, defines, target = 'es2022' } = opts;
  return {
    root,
    plugins: [vue(), ...kimiIconPlugins(iconsDir)],
    define: {
      __KIMI_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
      __KIMI_COMMIT_SHA__: JSON.stringify(resolveCommitSha()),
      __KIMI_BRANCH__: JSON.stringify(resolveBranch()),
      ...defines,
    },
    assetsInclude: ['**/*.riv', '**/rive.wasm', '**/rive_fallback.wasm'],
    build: {
      target,
    },
    worker: {
      format: 'es',
    },
  };
}
