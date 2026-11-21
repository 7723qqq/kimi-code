import { spawn } from 'node:child_process';

import electron from 'electron';

if (process.versions.bun !== '1.4.4') throw new Error('Desktop development requires Bun 1.4.4');
const child = spawn(electron, ['.', ...process.argv.slice(2).filter((arg) => arg !== '--')], {
  cwd: Bun.fileURLToPath(new URL('..', import.meta.url)),
  stdio: 'inherit',
  env: { ...process.env, KIMI_DESKTOP_BUN_PATH: process.execPath },
});
child.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once('close', (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    child.kill(signal);
  });
