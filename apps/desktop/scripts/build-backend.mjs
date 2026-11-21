import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { build } from 'tsdown';

import { KIMI_CORE_VERSION } from './kimi-core-version.mjs';

const root = Bun.fileURLToPath(new URL('..', import.meta.url));
if (process.versions.bun !== '1.4.4') throw new Error('Desktop backend builds require Bun 1.4.4');
const targets = { win32: 'windows', darwin: 'darwin', linux: 'linux' };
const platform = targets[process.platform];
if (platform === undefined || !['x64', 'arm64'].includes(process.arch))
  throw new Error('Unsupported Desktop backend target');
const output = join(root, 'backend-dist');
await mkdir(output, { recursive: true });
await build({ cwd: root, config: join(root, 'tsdown.backend.config.ts') });
const name = `kimi-desktop-backend${process.platform === 'win32' ? '.exe' : ''}`;
const compiled = Bun.spawn(
  [
    process.execPath,
    'build',
    '--compile',
    '--target',
    `bun-${platform}-${process.arch}`,
    '--format',
    'esm',
    '--bytecode',
    '--no-compile-autoload-dotenv',
    '--no-compile-autoload-bunfig',
    '--compile-autoload-package-json',
    '--define',
    '__KIMI_DESKTOP_COMPILED__=true',
    '--external',
    'canvas',
    '--outfile',
    join(output, name),
    join(root, 'out-backend', 'backend.mjs'),
  ],
  { cwd: root, stdout: 'inherit', stderr: 'inherit' },
);
if ((await compiled.exited) !== 0) throw new Error('Desktop Bun backend compilation failed');
for (const name of ['search-worker.mjs', 'text-build-worker.mjs'])
  await copyFile(join(root, 'out-backend', name), join(output, name));
const manifest = {
  protocol: 1,
  bun: process.versions.bun,
  coreVersion: KIMI_CORE_VERSION,
  target: `${process.platform}-${process.arch}`,
  files: {},
};
for (const file of [name, 'search-worker.mjs', 'text-build-worker.mjs'])
  manifest.files[file] = new Bun.CryptoHasher('sha256')
    .update(await Bun.file(join(output, file)).bytes())
    .digest('hex');
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(
  `[desktop-backend] compiled ${name}, Bun ${process.versions.bun}, core ${KIMI_CORE_VERSION}`,
);
