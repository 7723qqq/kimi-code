import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  detectFdPath,
  ensureFdPath,
  getFdAssetName,
  type FdDetectDeps,
  type FdSpawnSync,
} from '#/utils/process/fd-detect';

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function recordingSpawn(
  calls: { command: string; args: readonly string[]; stdio: string }[],
  status: number,
): FdSpawnSync {
  return (command, args, options) => {
    calls.push({ command, args, stdio: options.stdio });
    return { status };
  };
}

describe('getFdAssetName', () => {
  it('returns the macOS arm64 asset name', () => {
    expect(getFdAssetName('darwin', 'arm64')).toBe('fd-v10.4.2-aarch64-apple-darwin.tar.gz');
  });

  it('returns the macOS x64 asset name pinned to the available upstream release', () => {
    expect(getFdAssetName('darwin', 'x64')).toBe('fd-v10.3.0-x86_64-apple-darwin.tar.gz');
  });

  it('returns the Linux x64 musl asset name', () => {
    expect(getFdAssetName('linux', 'x64')).toBe('fd-v10.4.2-x86_64-unknown-linux-musl.tar.gz');
  });

  it('returns the Windows x64 asset name', () => {
    expect(getFdAssetName('win32', 'x64')).toBe('fd-v10.4.2-x86_64-pc-windows-msvc.zip');
  });

  it('returns null for unsupported platforms or architectures', () => {
    expect(getFdAssetName('freebsd', 'x64')).toBeNull();
    expect(getFdAssetName('darwin', 'arm')).toBeNull();
  });
});

describe('detectFdPath', () => {
  it('returns the absolute resolved path for a system fd binary', () => {
    const binDir = makeTempDir('kimi-fd-bin-');
    const calls: { command: string; args: readonly string[]; stdio: string }[] = [];

    const detected = detectFdPath({
      binDir: () => binDir,
      platform: 'linux',
      resolveCommandPath: (name) => (name === 'fd' ? '/usr/local/bin/fd' : undefined),
      spawnSync: recordingSpawn(calls, 0),
    });

    expect(detected).toBe('/usr/local/bin/fd');
    expect(calls).toEqual([{ command: '/usr/local/bin/fd', args: ['--version'], stdio: 'ignore' }]);
  });

  it('prefers the managed fd binary in the injected bin dir', () => {
    const binDir = makeTempDir('kimi-fd-bin-');
    writeFileSync(join(binDir, 'fd'), '#!/bin/sh\necho fd 10.4.2\n');
    const probed: string[] = [];

    const detected = detectFdPath({
      binDir: () => binDir,
      platform: 'linux',
      resolveCommandPath: () => '/usr/local/bin/fd',
      spawnSync: (command) => {
        probed.push(command);
        return { status: 0 };
      },
    });

    expect(detected).toBe(join(binDir, 'fd'));
    expect(probed).toEqual([join(binDir, 'fd')]);
  });

  it('looks for fd.exe on a Windows platform', () => {
    const binDir = makeTempDir('kimi-fd-bin-');
    writeFileSync(join(binDir, 'fd.exe'), 'MZ');

    const detected = detectFdPath({
      binDir: () => binDir,
      platform: 'win32',
      resolveCommandPath: () => undefined,
      spawnSync: () => ({ status: 0 }),
    });

    expect(detected).toBe(join(binDir, 'fd.exe'));
  });

  it('falls back to a system fd when the managed binary is not runnable', () => {
    const binDir = makeTempDir('kimi-fd-bin-');
    const managed = join(binDir, 'fd');
    writeFileSync(managed, '#!/bin/sh\nexit 1\n');
    const calls: { command: string; args: readonly string[]; stdio: string }[] = [];

    const detected = detectFdPath({
      binDir: () => binDir,
      platform: 'linux',
      resolveCommandPath: (name) => (name === 'fdfind' ? '/usr/bin/fdfind' : undefined),
      spawnSync: (command, args, options) => {
        calls.push({ command, args, stdio: options.stdio });
        return { status: command === managed ? 1 : 0 };
      },
    });

    expect(detected).toBe('/usr/bin/fdfind');
    expect(calls.map((call) => call.command)).toEqual([managed, '/usr/bin/fdfind']);
  });

  it('returns null when neither a managed nor a system fd runs', () => {
    const binDir = makeTempDir('kimi-fd-bin-');

    const detected = detectFdPath({
      binDir: () => binDir,
      platform: 'linux',
      resolveCommandPath: (name) => `/usr/bin/${name}`,
      spawnSync: () => ({ status: 1 }),
    });

    expect(detected).toBeNull();
  });

  it('skips a candidate whose version probe throws', () => {
    const binDir = makeTempDir('kimi-fd-bin-');

    const detected = detectFdPath({
      binDir: () => binDir,
      platform: 'linux',
      resolveCommandPath: (name) => (name === 'fd' ? '/usr/local/bin/fd' : undefined),
      spawnSync: () => {
        throw new Error('EACCES');
      },
    });

    expect(detected).toBeNull();
  });
});

describe('ensureFdPath', () => {
  it('returns the detected binary without downloading', async () => {
    const binDir = makeTempDir('kimi-fd-bin-');
    writeFileSync(join(binDir, 'fd'), '#!/bin/sh\necho fd 10.4.2\n');
    let downloads = 0;

    const detected = await ensureFdPath({
      binDir: () => binDir,
      platform: 'linux',
      arch: 'x64',
      resolveCommandPath: () => undefined,
      spawnSync: () => ({ status: 0 }),
      fetch: (async () => {
        downloads += 1;
        throw new Error('offline');
      }) as unknown as FdDetectDeps['fetch'],
    });

    expect(detected).toBe(join(binDir, 'fd'));
    expect(downloads).toBe(0);
  });

  it('returns null when the download fails', async () => {
    const binDir = makeTempDir('kimi-fd-bin-');
    let downloads = 0;

    const detected = await ensureFdPath({
      binDir: () => binDir,
      platform: 'linux',
      arch: 'x64',
      resolveCommandPath: () => undefined,
      spawnSync: () => ({ status: 1 }),
      fetch: (async () => {
        downloads += 1;
        throw new Error('offline');
      }) as unknown as FdDetectDeps['fetch'],
    });

    expect(detected).toBeNull();
    expect(downloads).toBe(1);
  });
});
