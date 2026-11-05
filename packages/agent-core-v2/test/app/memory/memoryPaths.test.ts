import { describe, expect, it } from 'bun:test';

import { projectIdFromCwd } from '#/app/memory/memoryPaths';

describe('projectIdFromCwd', () => {
  it('is stable across windows separators, case and a trailing slash', () => {
    const expected = projectIdFromCwd('D:\\kimi\\kimi-code');
    expect(projectIdFromCwd('D:/kimi/kimi-code')).toBe(expected);
    expect(projectIdFromCwd('D:\\Kimi\\Kimi-Code')).toBe(expected);
    expect(projectIdFromCwd('d:/kimi/kimi-code/')).toBe(expected);
  });

  it('is stable across unc separators', () => {
    expect(projectIdFromCwd('\\\\server\\share\\proj')).toBe(
      projectIdFromCwd('//server/share/proj'),
    );
  });

  it('keeps posix paths case sensitive', () => {
    expect(projectIdFromCwd('/home/alice/Proj')).not.toBe(projectIdFromCwd('/home/alice/proj'));
  });

  it('is stable across a trailing separator on posix paths', () => {
    expect(projectIdFromCwd('/home/alice/proj/')).toBe(projectIdFromCwd('/home/alice/proj'));
  });

  it('returns a deterministic 12 character hex id', () => {
    const id = projectIdFromCwd('D:\\kimi\\kimi-code');
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(projectIdFromCwd('D:\\kimi\\kimi-code')).toBe(id);
  });
});
