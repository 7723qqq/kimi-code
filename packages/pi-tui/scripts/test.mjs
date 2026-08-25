// Bun cannot run these suites through its `node --test` shim (the node:test
// harness only arms under `bun test`), so dispatch on the current runtime.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const files = readdirSync(new URL('../test/', import.meta.url))
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => `test/${name}`);

const args = typeof Bun !== 'undefined' ? ['test', ...files] : ['--test', ...files];
const result = spawnSync(process.execPath, args, { stdio: 'inherit' });

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
