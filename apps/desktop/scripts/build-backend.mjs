import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outDir = join(root, 'build', 'backend');
const bundlePath = join(outDir, 'entry.js');
const executablePath = join(outDir, process.platform === 'win32' ? 'kimi-desktop-backend.exe' : 'kimi-desktop-backend');
const searchWorker = join(root, 'out', 'search-worker.mjs');

const rawText = {
  name: 'raw-text',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => {
      const clean = args.path.split('?')[0];
      const absolute = resolve(args.resolveDir, clean);
      return { path: `${absolute}?raw`, namespace: 'raw-text' };
    });
    build.onLoad({ filter: /.*/, namespace: 'raw-text' }, async (args) => {
      const text = await Bun.file(args.path.split('?')[0]).text();
      return { contents: `export default ${JSON.stringify(text)};`, loader: 'js' };
    });
  },
};

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, 'src', 'backend', 'entry.ts')],
  outdir: outDir,
  target: 'bun',
  format: 'esm',
  splitting: false,
  sourcemap: 'none',
  external: ['canvas', 'electron', 'node-pty', 'fsevents', 'sharp', '@napi-rs/canvas'],
  plugins: [rawText],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const compiled = Bun.spawnSync(
  [process.execPath, 'build', '--compile', bundlePath, '--outfile', executablePath],
  { cwd: root, stdout: 'inherit', stderr: 'inherit' },
);
if (compiled.exitCode !== 0) process.exit(compiled.exitCode ?? 1);
if (existsSync(searchWorker)) copyFileSync(searchWorker, join(outDir, 'search-worker.mjs'));
console.log(`[backend] ${executablePath}`);
