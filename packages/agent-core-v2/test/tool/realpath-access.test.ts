import { describe, expect, it } from 'bun:test';

import type { HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { WorkspaceConfig } from '#/tool/path-access';
import { assertRealPathWithinWorkspace, assertRealPathWriteTarget } from '#/tool/realpath-access';

const WS = '/repo';
const OUTSIDE = '/outside';
const FAKE_HOME = '/tmp/fake-home';

interface FakeFsOptions {
  readonly existing?: readonly string[];
  readonly links?: Readonly<Record<string, string>>;
  readonly realpaths?: Readonly<Record<string, string>>;
}

function enoent(path: string): Error {
  const error = new Error(`ENOENT: no such file or directory, ${path}`) as Error & { code: string };
  error.code = 'ENOENT';
  return error;
}

function fakeStat(isSymbolicLink: boolean): HostFileStat {
  return { isFile: true, isDirectory: false, isSymbolicLink, size: 0 };
}

function createFakeFs(options: FakeFsOptions = {}): IHostFileSystem {
  const existing = new Set(options.existing ?? []);
  const links = options.links ?? {};
  const realpaths = options.realpaths ?? {};

  const realpath = (path: string): Promise<string> => {
    const override = realpaths[path];
    if (override !== undefined) return Promise.resolve(override);
    const target = links[path];
    if (target !== undefined) {
      return existing.has(target) ? Promise.resolve(target) : Promise.reject(enoent(target));
    }
    return existing.has(path) ? Promise.resolve(path) : Promise.reject(enoent(path));
  };

  const lstat = (path: string): Promise<HostFileStat> => {
    const isLink = links[path] !== undefined;
    if (!isLink && !existing.has(path)) return Promise.reject(enoent(path));
    return Promise.resolve(fakeStat(isLink));
  };

  return { realpath, lstat } as unknown as IHostFileSystem;
}

const workspace: WorkspaceConfig = { workspaceDir: WS, additionalDirs: [] };

describe('realpath access guard', () => {
  it('allows a symlink that stays inside the workspace', async () => {
    const fs = createFakeFs({
      existing: [WS, `${WS}/real.txt`],
      links: { [`${WS}/alias.txt`]: `${WS}/real.txt` },
    });

    await expect(assertRealPathWriteTarget(fs, `${WS}/alias.txt`, workspace, 'posix')).resolves.toBe(
      `${WS}/real.txt`,
    );
  });

  it('rejects a symlink that points outside the workspace', async () => {
    const fs = createFakeFs({
      existing: [WS, OUTSIDE, `${OUTSIDE}/target.txt`],
      links: { [`${WS}/link.txt`]: `${OUTSIDE}/target.txt` },
    });

    await expect(
      assertRealPathWriteTarget(fs, `${WS}/link.txt`, workspace, 'posix'),
    ).rejects.toThrow(/symbolic link/);
  });

  it('rejects a path whose symlinked parent directory points outside the workspace', async () => {
    const fs = createFakeFs({
      existing: [WS, FAKE_HOME, `${FAKE_HOME}/.bashrc`],
      links: { [`${WS}/home`]: FAKE_HOME },
    });

    await expect(
      assertRealPathWriteTarget(fs, `${WS}/home/.bashrc`, workspace, 'posix'),
    ).rejects.toThrow(/symbolic link/);
  });

  it('rejects a path that is too deep to verify', async () => {
    const fs = createFakeFs({
      existing: [WS, OUTSIDE, `${OUTSIDE}/target.txt`],
      links: { [`${WS}/link`]: OUTSIDE },
    });
    const deep = `${WS}/link/${'a/'.repeat(300)}file.txt`;

    await expect(assertRealPathWriteTarget(fs, deep, workspace, 'posix')).rejects.toThrow(
      /too deep/,
    );
  });

  it('blocks a target that resolves to a sensitive file', async () => {
    const fs = createFakeFs({
      existing: [WS, OUTSIDE, `${OUTSIDE}/id_rsa`],
      links: { [`${WS}/notes.md`]: `${OUTSIDE}/id_rsa` },
    });

    await expect(
      assertRealPathWriteTarget(fs, `${WS}/notes.md`, workspace, 'posix'),
    ).rejects.toThrow(/sensitive-file pattern/);
  });

  it('rejects a dangling symlink whose target does not exist', async () => {
    const fs = createFakeFs({
      existing: [WS, OUTSIDE],
      links: { [`${WS}/dangling.txt`]: `${OUTSIDE}/missing.txt` },
    });

    await expect(
      assertRealPathWriteTarget(fs, `${WS}/dangling.txt`, workspace, 'posix'),
    ).rejects.toThrow(/symbolic link/);
  });

  it('rejects the project config through a symlink alias', async () => {
    const configDir = `${WS}/.kimi-code`;
    const fs = createFakeFs({
      existing: [WS, configDir, `${configDir}/local.toml`],
      links: { [`${WS}/config-link`]: configDir },
    });

    await expect(
      assertRealPathWriteTarget(fs, `${WS}/config-link/local.toml`, workspace, 'posix'),
    ).rejects.toThrow(/project-local config/);
  });

  it('allows the project config through its real path', async () => {
    const configDir = `${WS}/.kimi-code`;
    const fs = createFakeFs({
      existing: [WS, configDir, `${configDir}/local.toml`],
    });

    await expect(
      assertRealPathWriteTarget(fs, `${configDir}/local.toml`, workspace, 'posix'),
    ).resolves.toBe(`${configDir}/local.toml`);
  });

  it('allows a symlink that points into an additional dir', async () => {
    const fs = createFakeFs({
      existing: [WS, OUTSIDE, `${OUTSIDE}/shared.txt`],
      links: { [`${WS}/shared.txt`]: `${OUTSIDE}/shared.txt` },
    });
    const withAdditional: WorkspaceConfig = { workspaceDir: WS, additionalDirs: [OUTSIDE] };

    await expect(
      assertRealPathWriteTarget(fs, `${WS}/shared.txt`, withAdditional, 'posix'),
    ).resolves.toBe(`${OUTSIDE}/shared.txt`);
  });

  it('blocks an absolute outside symlink that resolves to a sensitive file', async () => {
    const fs = createFakeFs({
      existing: [OUTSIDE, `${OUTSIDE}/id_rsa`],
      links: { '/tmp/notes.md': `${OUTSIDE}/id_rsa` },
    });

    await expect(
      assertRealPathWithinWorkspace(fs, '/tmp/notes.md', workspace, 'posix'),
    ).rejects.toThrow(/sensitive-file pattern/);
  });

  it('allows an absolute outside path that is not sensitive', async () => {
    const fs = createFakeFs({ existing: [OUTSIDE, `${OUTSIDE}/plain.txt`] });

    await expect(
      assertRealPathWithinWorkspace(fs, `${OUTSIDE}/plain.txt`, workspace, 'posix'),
    ).resolves.toBe(`${OUTSIDE}/plain.txt`);
  });

  it('compares resolved config paths with Windows semantics', async () => {
    const realpath = (path: string): Promise<string> =>
      Promise.resolve(
        path === 'C:/ws/alias/local.toml' ? 'C:\\ws\\.kimi-code\\local.toml' : path.replaceAll('/', '\\'),
      );
    const winFs = { realpath } as unknown as IHostFileSystem;
    const winWorkspace: WorkspaceConfig = { workspaceDir: 'C:/ws', additionalDirs: [] };

    await expect(
      assertRealPathWriteTarget(winFs, 'C:/ws/.kimi-code/local.toml', winWorkspace, 'win32'),
    ).resolves.toBe('C:\\ws\\.kimi-code\\local.toml');
    await expect(
      assertRealPathWriteTarget(winFs, 'C:/ws/alias/local.toml', winWorkspace, 'win32'),
    ).rejects.toThrow(/project-local config/);
  });
});
