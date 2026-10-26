import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { ZipFile } from 'yazl';

import { fail } from './exec.mjs';
import { executableName, nativeArtifactsDir, nativeBinPath, targetTriple } from './paths.mjs';

const target = targetTriple();
// Member name must follow the resolved target platform (KIMI_CODE_BUILD_TARGET),
// mirroring nativeBinPath()'s platform derivation, not the host running this script.
const execName = executableName(target.split('-')[0]);
const sourceBinary = nativeBinPath(target);
const artifactsDir = nativeArtifactsDir();

// Optional engine segment so parallel packaging pipelines never collide on
// artifact filenames (e.g. KIMI_CODE_NATIVE_ENGINE=bun -> kimi-code-bun-<target>.zip).
const engineSegment = process.env.KIMI_CODE_NATIVE_ENGINE ?? null;

// Flat-name archive for GH Release (GitHub Release assets do not support subdirectories).
const artifactName = `kimi-code${engineSegment ? `-${engineSegment}` : ''}-${target}.zip`;
const artifactPath = resolve(artifactsDir, artifactName);
const checksumPath = `${artifactPath}.sha256`;

async function sha256(path) {
  const hasher = new Bun.CryptoHasher('sha256');
  const reader = Bun.file(path).stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
  }
  return hasher.digest('hex');
}

if (!(await Bun.file(sourceBinary).exists())) {
  fail(`Native executable not found at ${sourceBinary}. Run build:native:bun first.`);
}

await mkdir(artifactsDir, { recursive: true });

const zip = new ZipFile();
zip.addFile(sourceBinary, execName, { mode: 0o100755 });
zip.end();
await pipeline(zip.outputStream, createWriteStream(artifactPath));

const digest = await sha256(artifactPath);
await Bun.write(checksumPath, `${digest}  ${basename(artifactPath)}\n`, { createPath: false });

console.log(`Wrote native artifact: ${artifactPath}`);
console.log(`Wrote artifact checksum: ${checksumPath}`);
