import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { inflateRawSync, zstdDecompressSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';

import { SUPPORTED_TARGETS } from '../../../scripts/native/native-deps.mjs';
import { appRoot, nativeStdioCliPath } from '../../../scripts/native/paths.mjs';

const execFileAsync = promisify(execFile);
const packageScript = resolve(appRoot, 'scripts/native/package.mjs');
const manifestScript = resolve(appRoot, 'scripts/native/produce-manifest.mjs');
const artifactsDir = resolve(appRoot, 'dist-native/artifacts');
const target = 'test-zip-artifact';
// Member/binary names follow the fake target's platform segment ('test' is not
// win32), independent of the platform running this test.
const executableName = 'kimi';
const fakeBinary = resolve(appRoot, 'dist-native/bin', target, executableName);

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function zipEntryNames(zipPath: string): readonly string[] {
  const zip = readFileSync(zipPath);
  const eocdOffset = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  let offset = zip.readUInt32LE(eocdOffset + 16);
  const names: string[] = [];

  for (let i = 0; i < entryCount; i += 1) {
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    names.push(zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf-8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return names;
}

function readZipEntry(zipPath: string, expectedName: string): Buffer {
  const zip = readFileSync(zipPath);
  const eocdOffset = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  let offset = zip.readUInt32LE(eocdOffset + 16);

  for (let i = 0; i < entryCount; i += 1) {
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf-8');
    if (name === expectedName) {
      return readLocalEntry(zip, localHeaderOffset, method, compressedSize);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }

  throw new Error(`zip entry not found: ${expectedName}`);
}

function readLocalEntry(
  zip: Buffer,
  localHeaderOffset: number,
  method: number,
  compressedSize: number,
): Buffer {
  expect(zip.readUInt32LE(localHeaderOffset)).toBe(0x04034b50);
  const nameLength = zip.readUInt16LE(localHeaderOffset + 26);
  const extraLength = zip.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + nameLength + extraLength;
  const compressed = zip.subarray(dataStart, dataStart + compressedSize);
  if (method === 0) return compressed;
  if (method === 8) return inflateRawSync(compressed);
  throw new Error(`unsupported zip compression method: ${String(method)}`);
}

function findEndOfCentralDirectory(zip: Buffer): number {
  for (let offset = zip.length - 22; offset >= 0; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('end of central directory not found');
}

// The produce-manifest script extracts the main executable from each bun zip,
// so the manifest tests materialize real archives with yazl instead of only
// writing checksum sidecars.
function writeBunZip(dir: string, zipTarget: string, content: string): Promise<string> {
  const zipName = `kimi-code-bun-${zipTarget}.zip`;
  const memberName = zipTarget.startsWith('win32') ? 'kimi.exe' : 'kimi';
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(content), memberName, { mode: 0o100755 });
  zip.end();
  const zipPath = join(dir, zipName);
  return new Promise((resolveZip, rejectZip) => {
    zip.outputStream
      .pipe(createWriteStream(zipPath))
      .on('error', rejectZip)
      .on('close', () => resolveZip(zipPath));
  });
}

describe('native release artifacts', () => {
  afterEach(() => {
    rmSync(resolve(appRoot, 'dist-native/bin', target), { recursive: true, force: true });
    rmSync(resolve(artifactsDir, `kimi-code-${target}.zip`), { force: true });
    rmSync(resolve(artifactsDir, `kimi-code-${target}.zip.sha256`), { force: true });
    rmSync(resolve(artifactsDir, `kimi-code-bun-${target}.zip`), { force: true });
    rmSync(resolve(artifactsDir, `kimi-code-bun-${target}.zip.sha256`), { force: true });
  });

  it('packages the native binary as a zip archive and checksums the archive', async () => {
    const binaryContent = 'native binary payload\n';
    mkdirSync(resolve(appRoot, 'dist-native/bin', target), { recursive: true });
    writeFileSync(fakeBinary, binaryContent, { mode: 0o755 });

    await execFileAsync(process.execPath, [packageScript], {
      cwd: appRoot,
      env: { ...process.env, KIMI_CODE_BUILD_TARGET: target },
    });

    const archivePath = resolve(artifactsDir, `kimi-code-${target}.zip`);
    const checksumPath = `${archivePath}.sha256`;
    expect(existsSync(archivePath)).toBe(true);
    expect(existsSync(checksumPath)).toBe(true);
    expect(zipEntryNames(archivePath)).toEqual([executableName]);
    expect(readZipEntry(archivePath, executableName).toString('utf-8')).toBe(binaryContent);
    expect(readFileSync(checksumPath, 'utf-8')).toBe(
      `${sha256(readFileSync(archivePath))}  kimi-code-${target}.zip\n`,
    );
  });

  it('inserts the engine segment into the archive name when configured', async () => {
    mkdirSync(resolve(appRoot, 'dist-native/bin', target), { recursive: true });
    writeFileSync(fakeBinary, 'bun binary payload\n', { mode: 0o755 });

    await execFileAsync(process.execPath, [packageScript], {
      cwd: appRoot,
      env: { ...process.env, KIMI_CODE_BUILD_TARGET: target, KIMI_CODE_NATIVE_ENGINE: 'bun' },
    });

    const archivePath = resolve(artifactsDir, `kimi-code-bun-${target}.zip`);
    expect(existsSync(archivePath)).toBe(true);
    expect(existsSync(`${archivePath}.sha256`)).toBe(true);
    expect(zipEntryNames(archivePath)).toEqual([executableName]);
  });

  it('includes a staged kimi-agent stdio CLI in the archive when present', async () => {
    mkdirSync(resolve(appRoot, 'dist-native/bin', target), { recursive: true });
    writeFileSync(fakeBinary, 'bun binary payload\n', { mode: 0o755 });
    const stdioCliPath = nativeStdioCliPath(target);
    writeFileSync(stdioCliPath, 'stdio fallback payload\n', { mode: 0o755 });

    await execFileAsync(process.execPath, [packageScript], {
      cwd: appRoot,
      env: { ...process.env, KIMI_CODE_BUILD_TARGET: target },
    });

    const archivePath = resolve(artifactsDir, `kimi-code-${target}.zip`);
    expect(zipEntryNames(archivePath)).toEqual(
      expect.arrayContaining([executableName, 'kimi-agent-cli']),
    );
    expect(readZipEntry(archivePath, 'kimi-agent-cli').toString('utf-8')).toBe(
      'stdio fallback payload\n',
    );
  });

  it('produces compressed artifacts and a manifest paired with the bare binary', async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), 'kimi-manifest-bun-'));
    try {
      const contents = new Map<string, string>();
      for (const zipTarget of SUPPORTED_TARGETS) {
        const content = `native binary payload for ${zipTarget}\n`;
        contents.set(zipTarget, content);
        await writeBunZip(releaseDir, zipTarget, content);
      }

      await execFileAsync(process.execPath, [
        manifestScript,
        releaseDir,
        '@moonshot-ai/kimi-code@0.5.0',
      ]);

      const manifest = JSON.parse(
        await readFile(join(releaseDir, 'manifest.json'), 'utf-8'),
      ) as {
        version: string;
        tag: string;
        bun: Record<
          string,
          { filename: string; checksum: string; compressed: { filename: string; checksum: string } }
        >;
      };
      expect(manifest.version).toBe('0.5.0');
      expect(manifest.tag).toBe('@moonshot-ai/kimi-code@0.5.0');
      expect(Object.keys(manifest.bun).toSorted()).toEqual(SUPPORTED_TARGETS);
      expect(manifest).not.toHaveProperty('platforms');

      for (const zipTarget of SUPPORTED_TARGETS) {
        const content = contents.get(zipTarget);
        if (content === undefined) throw new Error(`missing content for ${zipTarget}`);
        const binaryName = zipTarget.startsWith('win32')
          ? `kimi-code-${zipTarget}.exe`
          : `kimi-code-${zipTarget}`;
        const zstName = `kimi-code-${zipTarget}.zst`;
        const entry = manifest.bun[zipTarget];
        expect(entry).toEqual({
          filename: binaryName,
          checksum: sha256(content),
          compressed: {
            filename: zstName,
            checksum: sha256(readFileSync(join(releaseDir, zstName))),
          },
        });
        expect(zstdDecompressSync(readFileSync(join(releaseDir, zstName))).toString('utf-8')).toBe(
          content,
        );
        expect(readFileSync(join(releaseDir, `${binaryName}.sha256`), 'utf-8')).toBe(
          `${sha256(content)}  ${binaryName}\n`,
        );
        expect(readFileSync(join(releaseDir, `${zstName}.sha256`), 'utf-8')).toBe(
          `${entry!.compressed!.checksum}  ${zstName}\n`,
        );
      }
    } finally {
      rmSync(releaseDir, { recursive: true, force: true });
    }
  });

  it('fails when the bun section is incomplete', async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), 'kimi-manifest-partialbun-'));
    const [...missing] = SUPPORTED_TARGETS;
    const uncovered = missing.pop();
    if (uncovered === undefined || missing.length === 0)
      throw new Error('expected multiple supported targets');

    try {
      for (const zipTarget of missing) {
        await writeBunZip(releaseDir, zipTarget, `native binary payload for ${zipTarget}\n`);
      }

      await expect(
        execFileAsync(process.execPath, [
          manifestScript,
          releaseDir,
          '@moonshot-ai/kimi-code@0.5.0',
        ]),
      ).rejects.toThrow(new RegExp(`No Bun.*${uncovered}`));
    } finally {
      rmSync(releaseDir, { recursive: true, force: true });
    }
  });
});