import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';


const appRoot = resolve(dirname(Bun.fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '../..');
const source = resolve(repoRoot, 'apps/desktop/web-dist');
const target = resolve(appRoot, 'dist-web');

const build = spawnSync(process.execPath, ['run', 'build:web'], {
  cwd: resolve(repoRoot, 'apps', 'desktop'),
  stdio: 'inherit',
});
if (build.status !== 0) {
  throw new Error(`desktop web-variant build failed (exit ${String(build.status)})`);
}
if (!existsSync(resolve(source, 'index.html'))) {
  throw new Error(`expected the web bundle at ${source}/index.html after build:web`);
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });

const files = await readdir(target, { recursive: true });
console.log(`Synced web assets: ${source} -> ${target} (${files.length} entries)`);
