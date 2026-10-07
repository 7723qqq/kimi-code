/**
 * Build the per-release native artifact set and `manifest.json` from the
 * matrix runners' zip archives, written into the same input directory.
 *
 * Usage:
 *   node produce-manifest.mjs <input-dir> <release-tag>
 *
 * Input dir must contain kimi-code-bun-<target>.zip.sha256 for every
 * supported target (produced by package.mjs across the 6 native-build matrix
 * runners). Bun is the only packaged engine: the manifest carries a single
 * `bun` section, and a missing target would strand clients on that platform.
 *
 * Alongside the manifest this also unpacks each zip and emits, next to it:
 *   kimi-code-<target>.tar.gz    consumed by install.sh / install.ps1
 *   kimi-code-<target>.zst       zstd -19, the smallest published form
 *   <artifact>.sha256            sidecars in `<hex>  <name>` format
 *
 * These extra forms are release assets only. The updater stages the `bun`
 * entry's `.zip` (the manifest's `filename` keeps its archive semantics), so
 * neither additional format is referenced from `manifest.json` and adding
 * them cannot change what a client downloads.
 *
 * Requires `unzip`, `zstd`, and `tar` on PATH (preinstalled on
 * GitHub-hosted runners).
 *
 * Output:
 *   <input-dir>/manifest.json   ← consumed by src/cli/update/native-manifest.ts
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { SUPPORTED_TARGETS } from './native-deps.mjs';

const execFileAsync = promisify(execFile);

const [, , inputDir, tag] = process.argv;
if (!inputDir || !tag) {
  console.error('Usage: produce-manifest.mjs <input-dir> <release-tag>');
  process.exit(1);
}

// The extra formats are produced with external tools. Check up front so a
// missing one fails here rather than midway through the target loop, after
// some archives have already been written.
for (const tool of ['unzip', 'zstd', 'tar']) {
  try {
    await execFileAsync('sh', ['-c', `command -v ${tool}`]);
  } catch {
    console.error(
      `produce-manifest.mjs requires \`${tool}\` on PATH (preinstalled on GitHub-hosted runners).`,
    );
    process.exit(1);
  }
}

async function sha256(path) {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

async function run(command, args) {
  try {
    await execFileAsync(command, args);
  } catch (error) {
    const detail = [error.stdout?.trim(), error.stderr?.trim(), error.message]
      .filter(Boolean)
      .join('\n');
    console.error(`${command} failed: ${detail}`);
    process.exit(1);
  }
}

// Tag 格式 `@moonshot-ai/kimi-code@x.y.z` 或 `vx.y.z` 或 `x.y.z`，都归一化到 x.y.z
const version = tag.replace(/^@moonshot-ai\/kimi-code@/, '').replace(/^v/, '');

const entries = await readdir(inputDir);
const sumFiles = entries.filter((f) => /^kimi-code-bun-[a-z0-9]+-[a-z0-9]+\.zip\.sha256$/.test(f));

if (sumFiles.length === 0) {
  console.error(`No kimi-code-bun-<target>.zip.sha256 files found in ${inputDir}`);
  process.exit(1);
}

const bun = {};
for (const sumFile of sumFiles.sort()) {
  const text = await readFile(resolve(inputDir, sumFile), 'utf-8');
  const [checksum] = text.trim().split(/\s+/, 1);
  if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) {
    console.error(`Invalid checksum in ${sumFile}: ${checksum}`);
    process.exit(1);
  }
  const filename = basename(sumFile, '.sha256');
  // kimi-code-bun-linux-x64.zip → linux-x64
  const target = filename
    .replace(/^kimi-code-/, '')
    .replace(/^bun-/, '')
    .replace(/\.zip$/, '');
  if (!SUPPORTED_TARGETS.includes(target)) {
    console.warn(`Warning: ${sumFile} maps to unsupported target '${target}'; including anyway`);
  }
  bun[target] = { filename, checksum };
}

// The completeness check must run before anything is unpacked: a missing
// archive is a manifest-level failure, and unpacking first would surface it
// as an `unzip` error instead of naming the platform that has no artifacts.
const missingBunTargets = SUPPORTED_TARGETS.filter((t) => !(t in bun));
if (missingBunTargets.length > 0) {
  console.error(
    `No Bun (kimi-code-bun-<target>.zip) artifacts found for: ${missingBunTargets.join(', ')}; ` +
      'a partial bun section would strand clients on the missing platforms',
  );
  process.exit(1);
}

// Emit the tar.gz / zst forms of the same executable. The archive is
// unpacked into a temp dir because tar/zstd consume real files, and the
// member name is derived from the target rather than the host so a Windows
// or macOS runner still produces the right name for its target.
for (const [target, entry] of Object.entries(bun)) {
  const zipPath = resolve(inputDir, entry.filename);
  const exeName = target.startsWith('win32') ? 'kimi.exe' : 'kimi';
  const artifactBase = `kimi-code-${target}`;
  const workDir = await mkdtemp(join(tmpdir(), `native-manifest-${target}-`));
  try {
    await run('unzip', ['-o', zipPath, '-d', workDir]);
    const exePath = join(workDir, exeName);
    try {
      await stat(exePath);
    } catch {
      console.error(`${zipPath} does not contain ${exeName}`);
      process.exit(1);
    }

    const tarballName = `${artifactBase}.tar.gz`;
    const zstdName = `${artifactBase}.zst`;
    // -T0 uses every core: these binaries are ~150 MB, and -19 is the level
    // the published assets have always been built with.
    await run('zstd', ['-T0', '-19', '-q', '-f', '-o', resolve(inputDir, zstdName), exePath]);
    await run('tar', ['-C', workDir, '-czf', resolve(inputDir, tarballName), exeName]);

    for (const name of [tarballName, zstdName]) {
      const digest = await sha256(resolve(inputDir, name));
      await writeFile(resolve(inputDir, `${name}.sha256`), `${digest}  ${name}\n`);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

const manifest = { version, tag, bun };
const manifestPath = resolve(inputDir, 'manifest.json');

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Wrote ${manifestPath} (${Object.keys(bun).length} bun targets)`);
