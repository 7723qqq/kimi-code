import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { ZipFile } from 'yazl';

import { fail } from './exec.mjs';
import {
  executableName,
  nativeArtifactsDir,
  nativeBinPath,
  nativeStdioCliPath,
  targetTriple,
} from './paths.mjs';

const target = targetTriple();
// Member name must follow the resolved target platform (KIMI_CODE_BUILD_TARGET),
// mirroring nativeBinPath()'s platform derivation, not the host running this script.
const execName = executableName(target.split('-')[0]);
const sourceBinary = nativeBinPath(target);
const stdioCliPath = nativeStdioCliPath(target);
const artifactsDir = nativeArtifactsDir();

// Optional engine segment so parallel packaging pipelines never collide on
// artifact filenames (e.g. KIMI_CODE_NATIVE_ENGINE=bun -> kimi-code-bun-<target>.zip).
const engineSegment = process.env.KIMI_CODE_NATIVE_ENGINE ?? null;

// Flat-name archive for GH Release (GitHub Release assets do not support subdirectories).
const artifactName = `kimi-code${engineSegment ? `-${engineSegment}` : ''}-${target}.zip`;
const artifactPath = resolve(artifactsDir, artifactName);
const checksumPath = `${artifactPath}.sha256`;

async function sha256(path) {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

try {
  await stat(sourceBinary);
} catch {
  fail(`Native executable not found at ${sourceBinary}. Run build:native:bun first.`);
}

await mkdir(artifactsDir, { recursive: true });

const zip = new ZipFile();
zip.addFile(sourceBinary, execName, { mode: 0o100755 });
// The Rust engine's stdio JSON-RPC fallback, staged by build-bun.mjs next to
// the executable. Absent when no cargo build ran (test fixtures, napi-only
// bundles); the zip then carries just the main binary.
try {
  await stat(stdioCliPath);
  zip.addFile(stdioCliPath, basename(stdioCliPath), { mode: 0o100755 });
} catch {
  console.warn(`kimi-agent stdio CLI not found at ${stdioCliPath}; skipping it in the archive.`);
}
zip.end();
await pipeline(zip.outputStream, createWriteStream(artifactPath));

const digest = await sha256(artifactPath);
await writeFile(checksumPath, `${digest}  ${basename(artifactPath)}\n`);

console.log(`Wrote native artifact: ${artifactPath}`);
console.log(`Wrote artifact checksum: ${checksumPath}`);
