import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';

import { resolveCommandPath } from '#/utils/process/resolve-command';

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

it('resolves a PATH executable from the filesystem root', () => {
  const bin = makeTempDir('kimi-resolve-bin-');
  const tool = join(bin, 'mytool.EXE');
  writeFileSync(tool, '');

  expect(
    resolveCommandPath('mytool.EXE', parse(bin).root, {
      platform: 'win32',
      env: { PATH: bin, PATHEXT: '.EXE' },
    }),
  ).toBe(tool);
});

describe('resolveCommandPath (posix)', () => {
  // Executable-bit checks only work on a posix host.
  it.skipIf(process.platform === 'win32')(
    'resolves an executable from PATH to an absolute path',
    () => {
      const bin = makeTempDir('kimi-resolve-bin-');
      const cwd = makeTempDir('kimi-resolve-cwd-');
      const tool = join(bin, 'mytool');
      writeFileSync(tool, '#!/bin/sh\nexit 0\n');
      chmodSync(tool, 0o755);

      expect(resolveCommandPath('mytool', cwd, { platform: 'linux', env: { PATH: bin } })).toBe(
        tool,
      );
    },
  );

  it.skipIf(process.platform === 'win32')('ignores PATH files without the executable bit', () => {
    const bin = makeTempDir('kimi-resolve-bin-');
    const cwd = makeTempDir('kimi-resolve-cwd-');
    const tool = join(bin, 'mytool');
    writeFileSync(tool, '#!/bin/sh\nexit 0\n');
    chmodSync(tool, 0o644);

    expect(
      resolveCommandPath('mytool', cwd, { platform: 'linux', env: { PATH: bin } }),
    ).toBeUndefined();
  });

  it('refuses a hit inside the current working directory', () => {
    const cwd = makeTempDir('kimi-resolve-cwd-');
    const tool = join(cwd, 'mytool');
    writeFileSync(tool, '#!/bin/sh\nexit 0\n');
    chmodSync(tool, 0o755);
    // The cwd itself sits on PATH (e.g. a `.` entry) — the planted binary
    // must be rejected, not executed.
    expect(
      resolveCommandPath('mytool', cwd, { platform: 'linux', env: { PATH: cwd } }),
    ).toBeUndefined();
  });

  it('refuses a hit from a relative PATH entry landing in the cwd', () => {
    const cwd = makeTempDir('kimi-resolve-cwd-');
    const tool = join(cwd, 'mytool');
    writeFileSync(tool, '#!/bin/sh\nexit 0\n');
    chmodSync(tool, 0o755);

    expect(
      resolveCommandPath('mytool', cwd, { platform: 'linux', env: { PATH: '.' } }),
    ).toBeUndefined();
  });

  it('refuses a hit in a subdirectory of the cwd', () => {
    const cwd = makeTempDir('kimi-resolve-cwd-');
    const nested = join(cwd, 'bin');
    mkdirSync(nested);
    const tool = join(nested, 'mytool');
    writeFileSync(tool, '#!/bin/sh\nexit 0\n');
    chmodSync(tool, 0o755);

    expect(
      resolveCommandPath('mytool', cwd, { platform: 'linux', env: { PATH: nested } }),
    ).toBeUndefined();
  });

  // A ':'-separated PATH cannot be built from absolute Windows paths (the
  // drive letter is a colon), so the multi-entry case is pinned to a posix host.
  it.skipIf(process.platform === 'win32')(
    'continues to a safe PATH hit after a workspace executable',
    () => {
      const cwd = makeTempDir('kimi-resolve-cwd-');
      const bin = makeTempDir('kimi-resolve-bin-');
      for (const dir of [cwd, bin]) {
        writeFileSync(join(dir, 'mytool'), '#!/bin/sh\nexit 0\n');
        chmodSync(join(dir, 'mytool'), 0o755);
      }

      expect(
        resolveCommandPath('mytool', cwd, { platform: 'linux', env: { PATH: `${cwd}:${bin}` } }),
      ).toBe(join(bin, 'mytool'));
    },
  );
});

describe('resolveCommandPath (missing command)', () => {
  it('returns undefined when the command is not on PATH', () => {
    const bin = makeTempDir('kimi-resolve-bin-');
    const cwd = makeTempDir('kimi-resolve-cwd-');

    expect(
      resolveCommandPath('definitely-not-a-real-command', cwd, {
        platform: 'linux',
        env: { PATH: bin },
      }),
    ).toBeUndefined();
  });

  it('returns undefined when the injected env has no PATH', () => {
    const cwd = makeTempDir('kimi-resolve-cwd-');

    expect(
      resolveCommandPath('definitely-not-a-real-command', cwd, { platform: 'linux', env: {} }),
    ).toBeUndefined();
  });
});

describe('resolveCommandPath (win32)', () => {
  const win32Env = (path: string, pathext = '.COM;.EXE;.BAT;.CMD') => ({
    platform: 'win32' as const,
    env: { PATH: path, PATHEXT: pathext },
  });

  it('resolves a bare name through PATHEXT', () => {
    const bin = makeTempDir('kimi-resolve-bin-');
    const cwd = makeTempDir('kimi-resolve-cwd-');
    // Windows is case-insensitive, so the resolved name carries the PATHEXT
    // casing; match it here so the test also passes on case-insensitive
    // posix filesystems.
    const shim = join(bin, 'npm.CMD');
    writeFileSync(shim, '@echo off\r\n');

    expect(resolveCommandPath('npm', cwd, win32Env(bin))).toBe(shim);
  });

  it('tries an explicitly suffixed name as-is', () => {
    const bin = makeTempDir('kimi-resolve-bin-');
    const cwd = makeTempDir('kimi-resolve-cwd-');
    const shim = join(bin, 'npm.cmd');
    writeFileSync(shim, '@echo off\r\n');

    expect(resolveCommandPath('npm.cmd', cwd, win32Env(bin))).toBe(shim);
  });

  it('falls back to the default PATHEXT when the variable is unset', () => {
    const bin = makeTempDir('kimi-resolve-bin-');
    const cwd = makeTempDir('kimi-resolve-cwd-');
    const shim = join(bin, 'bun.EXE');
    writeFileSync(shim, 'MZ');

    expect(resolveCommandPath('bun', cwd, { platform: 'win32', env: { PATH: bin } })).toBe(shim);
  });

  it('refuses a hit inside the current working directory', () => {
    const cwd = makeTempDir('kimi-resolve-cwd-');
    writeFileSync(join(cwd, 'npm.cmd'), '@echo off\r\n');

    expect(resolveCommandPath('npm', cwd, win32Env(cwd))).toBeUndefined();
  });

  it('skips empty PATH entries', () => {
    const bin = makeTempDir('kimi-resolve-bin-');
    const cwd = makeTempDir('kimi-resolve-cwd-');
    const shim = join(bin, 'mytool.EXE');
    writeFileSync(shim, 'MZ');

    expect(resolveCommandPath('mytool.EXE', cwd, win32Env(`;${bin}`))).toBe(shim);
  });

  it('keeps searching PATH after a hit inside the cwd', () => {
    const bin = makeTempDir('kimi-resolve-bin-');
    const cwd = makeTempDir('kimi-resolve-cwd-');
    const planted = join(cwd, 'npm.CMD');
    const real = join(bin, 'npm.CMD');
    writeFileSync(planted, '@echo off\r\n');
    writeFileSync(real, '@echo off\r\n');
    // The cwd entry resolves first (like cmd.exe's cwd-first lookup); the
    // planted binary must be skipped in favour of the later PATH entry.
    expect(resolveCommandPath('npm', cwd, win32Env(`${cwd};${bin}`, '.CMD'))).toBe(real);
  });
});
