/**
 * Aggregate per-platform zip archive `.sha256` files into a single
 * `manifest.json` written into the same input directory.
 *
 * Usage:
 *   node produce-manifest.mjs <input-dir> <release-tag>
 *
 * Input dir must contain files matching: kimi-code-<target>.zip.sha256
 * (produced by package.mjs across the 6 native-build matrix runners), plus
 * kimi-code-bun-<target>.zip.sha256 from the Bun pipeline — those land in the
 * manifest's `bun` section so a Bun-packaged client updates against Bun builds
 * instead of silently switching to the SEA binary. Both sections must cover
 * every supported target: a partial section would strand clients on the
 * missing platforms.
 *
 * Output:
 *   <input-dir>/manifest.json   ← consumed by install.sh / install.ps1
 *
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { SUPPORTED_TARGETS } from './native-deps.mjs';

const [, , inputDir, tag] = process.argv;
if (!inputDir || !tag) {
  console.error('Usage: produce-manifest.mjs <input-dir> <release-tag>');
  process.exit(1);
}

// Tag 格式 `@moonshot-ai/kimi-code@x.y.z` 或 `vx.y.z` 或 `x.y.z`，都归一化到 x.y.z
const version = tag.replace(/^@moonshot-ai\/kimi-code@/, '').replace(/^v/, '');

const entries = await readdir(inputDir);
const sumFiles = entries.filter((f) => /^kimi-code-(?:bun-)?[a-z0-9]+-[a-z0-9]+\.zip\.sha256$/.test(f));

if (sumFiles.length === 0) {
  console.error(`No kimi-code-<target>.zip.sha256 files found in ${inputDir}`);
  process.exit(1);
}

const platforms = {};
const bun = {};
for (const sumFile of sumFiles.sort()) {
  const text = await readFile(resolve(inputDir, sumFile), 'utf-8');
  const [checksum] = text.trim().split(/\s+/, 1);
  if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) {
    console.error(`Invalid checksum in ${sumFile}: ${checksum}`);
    process.exit(1);
  }
  const filename = basename(sumFile, '.sha256');
  // kimi-code-darwin-arm64.zip → darwin-arm64; kimi-code-bun-linux-x64.zip → linux-x64
  const target = filename.replace(/^kimi-code-/, '').replace(/^bun-/, '').replace(/\.zip$/, '');
  if (filename.startsWith('kimi-code-bun-')) {
    bun[target] = { filename, checksum };
  } else {
    platforms[target] = { filename, checksum };
  }
}

if (Object.keys(platforms).length === 0) {
  console.error('No SEA (kimi-code-<target>.zip) artifacts found; the platforms section would be empty');
  process.exit(1);
}

const missingBunTargets = SUPPORTED_TARGETS.filter((t) => !(t in bun));
if (missingBunTargets.length > 0) {
  console.error(
    `No Bun (kimi-code-bun-<target>.zip) artifacts found for: ${missingBunTargets.join(', ')}; ` +
      'a partial bun section would strand Bun clients on the missing platforms',
  );
  process.exit(1);
}

const manifest = { version, tag, platforms };
if (Object.keys(bun).length > 0) {
  manifest.bun = bun;
}
const manifestPath = resolve(inputDir, 'manifest.json');

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  `Wrote ${manifestPath} (${Object.keys(platforms).length} platforms` +
    `${Object.keys(bun).length > 0 ? `, ${Object.keys(bun).length} bun` : ''})`,
);
