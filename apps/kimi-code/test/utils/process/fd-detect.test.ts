import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { detectFdPath, FD_ARCHIVE_SHA256, getFdAssetName } from '#/utils/process/fd-detect';
import { getBinDir } from '#/utils/paths';

const mocks = vi.hoisted(() => ({
  resolveCommandPath: vi.fn(),
  spawnSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('#/utils/process/resolve-command', () => ({
  resolveCommandPath: mocks.resolveCommandPath,
}));
vi.mock('node:child_process', () => ({
  spawnSync: mocks.spawnSync,
  execFile: mocks.execFile,
}));

const originalEnv = { ...process.env };
let tempHome: string | undefined;

afterEach(() => {
  if (tempHome !== undefined) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  }
  process.env = { ...originalEnv };
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('getFdAssetName', () => {
  // The literal names are deliberately NOT asserted here. `downloadFd` looks the
  // digest up by asset name and returns null on a miss, so the invariant worth
  // locking is the coupling between the two tables — reciting the version
  // strings here would only ever fail when someone already bumped the source.
  it('returns a name with a pinned SHA-256 for every supported platform/arch', () => {
    const supported: [NodeJS.Platform, string][] = [
      ['darwin', 'arm64'],
      ['darwin', 'x64'],
      ['linux', 'arm64'],
      ['linux', 'x64'],
      ['win32', 'arm64'],
      ['win32', 'x64'],
    ];

    for (const [plat, architecture] of supported) {
      const name = getFdAssetName(plat, architecture);
      expect(name, `${plat}/${architecture} must resolve an asset`).not.toBeNull();
      expect(
        FD_ARCHIVE_SHA256[name ?? ''],
        `${plat}/${architecture} resolves to ${String(name)}, which has no pinned SHA-256; ` +
          `downloadFd would return null and the managed fd would silently stop installing`,
      ).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('returns null for unsupported platforms or architectures', () => {
    expect(getFdAssetName('freebsd', 'x64')).toBeNull();
    expect(getFdAssetName('darwin', 'arm')).toBeNull();
    expect(getFdAssetName('linux', 'arm')).toBeNull();
  });
});

describe('detectFdPath', () => {
  it('returns the absolute resolved path for a system fd binary', () => {
    tempHome = mkdtempSync(join(tmpdir(), 'kimi-fd-home-'));
    process.env['KIMI_CODE_HOME'] = tempHome;
    mocks.resolveCommandPath.mockImplementation((name: string) =>
      name === 'fd' ? '/usr/local/bin/fd' : undefined,
    );
    mocks.spawnSync.mockReturnValue({ status: 0 });

    expect(detectFdPath()).toBe('/usr/local/bin/fd');
    expect(mocks.spawnSync).toHaveBeenCalledWith('/usr/local/bin/fd', ['--version'], {
      stdio: 'ignore',
    });
  });

  it('prefers the managed fd binary under KIMI_CODE_HOME', () => {
    tempHome = mkdtempSync(join(tmpdir(), 'kimi-fd-home-'));
    process.env['KIMI_CODE_HOME'] = tempHome;
    mkdirSync(getBinDir(), { recursive: true });

    const binaryPath = join(getBinDir(), process.platform === 'win32' ? 'fd.exe' : 'fd');
    if (process.platform === 'win32') {
      // Creating a real Windows PE executable in a unit test is not practical;
      // the asset-name tests still cover Windows selection logic.
      return;
    }

    writeFileSync(binaryPath, '#!/bin/sh\necho fd 10.4.2\n');
    chmodSync(binaryPath, 0o755);

    expect(detectFdPath()).toBe(binaryPath);
  });
});
