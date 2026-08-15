import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HostFileSystem } from '#/os/backends/node-local/hostFsService';

let dir: string;
let fs: HostFileSystem;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kimi-hostfs-'));
  fs = new HostFileSystem();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('HostFileSystem stat / lstat', () => {
  it('stat follows a symlink to a regular file while lstat stats the link', async () => {
    const target = join(dir, 'target.txt');
    await writeFile(target, 'hello', 'utf-8');
    const link = join(dir, 'link.txt');
    await symlink(target, link);

    const st = await fs.stat(link);
    expect(st.isFile).toBe(true);
    expect(st.isSymbolicLink).not.toBe(true);

    const lst = await fs.lstat(link);
    expect(lst.isSymbolicLink).toBe(true);
    expect(lst.isFile).toBe(false);
  });

  it('stat follows a symlink to a directory', async () => {
    const target = join(dir, 'subdir');
    await mkdir(target);
    const link = join(dir, 'dirlink');
    await symlink(target, link);

    expect((await fs.stat(link)).isDirectory).toBe(true);
    expect((await fs.lstat(link)).isDirectory).toBe(false);
  });

  it('stat rejects a dangling symlink while lstat still stats the link', async () => {
    const link = join(dir, 'dangling');
    await symlink(join(dir, 'missing'), link);

    await expect(fs.stat(link)).rejects.toThrow();
    expect((await fs.lstat(link)).isSymbolicLink).toBe(true);
  });

  describe('HostFileSystem writeText atomic', () => {
    it('writes text and leaves no temp files behind', async () => {
      const file = join(dir, 'a.txt');
      await fs.writeText(file, 'hello');
      expect(await readFile(file, 'utf8')).toBe('hello');

      const entries = await readdir(dir);
      expect(entries.filter((entry) => entry.includes('.tmp'))).toEqual([]);
    });

    it('writes through symlinks without replacing the link', async () => {
      const target = join(dir, 'target.txt');
      await writeFile(target, 'old', 'utf8');
      const link = join(dir, 'link.txt');
      await symlink(target, link);

      await fs.writeText(link, 'new');

      expect(await readFile(target, 'utf8')).toBe('new');
      expect((await fs.lstat(link)).isSymbolicLink).toBe(true);
    });
  });

});
