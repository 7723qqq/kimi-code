#!/usr/bin/env bun
import { rebuild } from '@electron/rebuild';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version } = require('electron/package.json');
if (process.versions.bun !== '1.4.4') throw new Error('Desktop native rebuild requires Bun 1.4.4');
try {
  await rebuild({ buildPath: Bun.fileURLToPath(new URL('..', import.meta.url)), electronVersion: version, onlyModules: ['node-pty'], force: true });
} catch (error) {
  throw new Error(`node-pty could not be rebuilt for Electron ${version}; install the platform C++ build toolchain before packaging. An unverified prebuild is not an ABI check.`, { cause: error });
}
