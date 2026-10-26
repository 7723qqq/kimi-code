/**
 * Build the per-release native artifact set and `manifest.json` from the
 * matrix runners' zip archives, written into the same input directory.
 *
 * Usage:
 *   bun produce-manifest.mjs <input-dir> <release-tag>
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

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { SUPPORTED_TARGETS } from './native-deps.mjs';

const [, , inputDir, tag] = process.argv;
if (!inputDir || !tag) {
  console.error('Usage: produce-manifest.mjs <input-dir> <release-tag>');
  process.exit(1);
}

// The extra formats are produced with external tools. Check up front so a
// missing one fails here rather than midway through the target loop, after
// some archives have already been written.
for (const tool of ['unzip', 'zstd', 'tar']) {
  if (Bun.which(tool) === null) {
    console.error(
      `produce-manifest.mjs requires \`${tool}\` on PATH (preinstalled on GitHub-hosted runners).`,
    );
    process.exit(1);
  }
}

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

async function run(command, args, options = {}) {
  try {
    const proc = Bun.spawn({
      cmd: [command, ...args],
      stdout: 'pipe',
      stderr: 'pipe',
      maxBuffer: 1024 * 1024,
      ...options,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      throw Object.assign(new Error(`${command} ${args.join(' ')} exited with code ${code}`), {
        stdout,
        stderr,
      });
    }
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
  const text = await Bun.file(resolve(inputDir, sumFile)).text();
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
    if (!(await Bun.file(exePath).exists())) {
      console.error(`${zipPath} does not contain ${exeName}`);
      process.exit(1);
    }

    const tarballName = `${artifactBase}.tar.gz`;
    const zstdName = `${artifactBase}.zst`;
    // -T0 uses every core: these binaries are ~150 MB, and -19 is the level
    // the published assets have always been built with.
    await run('zstd', ['-T0', '-19', '-q', '-f', '-o', resolve(inputDir, zstdName), exePath]);
    // GNU tar reads `C:\...` as `host:path` and tries to reach a remote host, so the
    // archive path is passed relative to the output directory instead of absolute.
    await run('tar', ['-C', workDir, '-czf', tarballName, exeName], { cwd: inputDir });

    for (const name of [tarballName, zstdName]) {
      const digest = await sha256(resolve(inputDir, name));
      await Bun.write(resolve(inputDir, `${name}.sha256`), `${digest}  ${name}\n`, {
        createPath: false,
      });
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

const manifest = { version, tag, bun };
const manifestPath = resolve(inputDir, 'manifest.json');

await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { createPath: false });

console.log(`Wrote ${manifestPath} (${Object.keys(bun).length} bun targets)`);
