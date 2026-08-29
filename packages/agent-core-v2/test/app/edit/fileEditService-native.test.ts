import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileEditService } from '#/app/edit/fileEditService';
import { HostFileSystem } from '#/os/backends/host/hostFsService';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

const mocks = vi.hoisted(() => ({
  tryNativeEdit: vi.fn(),
}));

vi.mock('#/_base/native-tools', () => mocks);

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

async function makeTempFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-edit-native-'));
  tempDirs.push(dir);
  const file = join(dir, 'a.txt');
  await writeFile(file, content, 'utf8');
  return file;
}

describe('FileEditService native fast path', () => {
  beforeEach(() => {
    // Default: native module unavailable → TS fallback. Individual tests
    // override with a resolved native result.
    mocks.tryNativeEdit.mockResolvedValue(undefined);
  });

  it('routes a unique replacement through the native engine', async () => {
    mocks.tryNativeEdit.mockResolvedValue({ success: true, replacements: 1 });
    const file = await makeTempFile('alpha beta\n');
    const service = new FileEditService(new HostFileSystem());

    const result = await service.edit({
      path: file,
      displayPath: file,
      old_string: 'beta',
      new_string: 'gamma',
      replace_all: false,
    });

    expect(result).toEqual({ ok: true, count: 1 });
    expect(mocks.tryNativeEdit).toHaveBeenCalledWith(file, 'beta', 'gamma', false);
    // The native engine owns the write; the TS path must not touch the file.
    expect(await readFile(file, 'utf8')).toBe('alpha beta\n');
  });

  it('routes replace_all through the native engine and reports the count', async () => {
    mocks.tryNativeEdit.mockResolvedValue({ success: true, replacements: 3 });
    const file = await makeTempFile('a a a\n');
    const service = new FileEditService(new HostFileSystem());

    const result = await service.edit({
      path: file,
      displayPath: file,
      old_string: 'a',
      new_string: 'b',
      replace_all: true,
    });

    expect(result).toEqual({ ok: true, count: 3 });
    expect(mocks.tryNativeEdit).toHaveBeenCalledWith(file, 'a', 'b', true);
  });

  it('returns the native error with the display path substituted', async () => {
    const file = await makeTempFile('hello\n');
    mocks.tryNativeEdit.mockResolvedValue({
      success: false,
      replacements: 0,
      error:
        `old_string not found in ${file}, the file contents may be out of date. Please use the Read Tool to reload the content.\n`,
    });
    const service = new FileEditService(new HostFileSystem());

    const result = await service.edit({
      path: file,
      displayPath: './rel/a.txt',
      old_string: 'nope',
      new_string: 'x',
      replace_all: false,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('old_string not found in ./rel/a.txt');
      expect(result.error).not.toContain(file);
    }
  });

  it('passes the native error through unchanged when display path equals the disk path', async () => {
    const file = await makeTempFile('a a\n');
    mocks.tryNativeEdit.mockResolvedValue({
      success: false,
      replacements: 0,
      error: `old_string is not unique in ${file} (found 2 occurrences). To replace every occurrence, set replace_all=true. To replace only one occurrence, include more surrounding context in old_string.`,
    });
    const service = new FileEditService(new HostFileSystem());

    const result = await service.edit({
      path: file,
      displayPath: file,
      old_string: 'a',
      new_string: 'b',
      replace_all: false,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('old_string is not unique');
      expect(result.error).toContain(file);
    }
  });

  it('keeps the TS path when a non-host filesystem is injected', async () => {
    const readText = vi.fn().mockResolvedValue('alpha beta');
    const writeText = vi.fn().mockResolvedValue(undefined);
    const fakeFs = { readText, writeText } as unknown as IHostFileSystem;
    const service = new FileEditService(fakeFs);

    const result = await service.edit(
      {
        path: '/tmp/a.txt',
        displayPath: '/tmp/a.txt',
        old_string: 'beta',
        new_string: 'gamma',
        replace_all: false,
      },
      fakeFs,
    );

    expect(result).toEqual({ ok: true, count: 1 });
    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', 'alpha gamma');
    expect(mocks.tryNativeEdit).not.toHaveBeenCalled();
  });

  it('falls back to the TS path when the native module is unavailable', async () => {
    const file = await makeTempFile('alpha beta\n');
    const service = new FileEditService(new HostFileSystem());

    const result = await service.edit({
      path: file,
      displayPath: file,
      old_string: 'beta',
      new_string: 'gamma',
      replace_all: false,
    });

    expect(result).toEqual({ ok: true, count: 1 });
    expect(await readFile(file, 'utf8')).toBe('alpha gamma\n');
  });

  it('falls back to the TS path when the native module is unavailable and the file is non-UTF-8', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-edit-native-fb-'));
    tempDirs.push(dir);
    const file = join(dir, 'sample.txt');
    const original = Buffer.from([0x68, 0x69, 0x20, 0xff, 0x0a, 0x66, 0x6f, 0x6f]);
    await writeFile(file, original);
    const service = new FileEditService(new HostFileSystem());

    const result = await service.edit({
      path: file,
      displayPath: file,
      old_string: 'foo',
      new_string: 'bar',
      replace_all: false,
    });

    expect(result.ok).toBe(false);
    const after = await readFile(file);
    expect(Buffer.compare(after, original)).toBe(0);
  });
});
