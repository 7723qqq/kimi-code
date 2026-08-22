import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tryNativeEscapeXml, tryNativeListDirectory, tryNativeRead } from '#/_base/native-tools';

const { mockRequire } = vi.hoisted(() => ({
  mockRequire: vi.fn<(id: string) => unknown>(),
}));

vi.mock('node:module', () => ({ createRequire: () => mockRequire }));

const nativeModule = {
  nativeRead: vi.fn(),
  nativeEscapeXml: vi.fn(),
  nativeListDirectory: vi.fn(),
};

describe('native-tools failure classes', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockRequire.mockReset();
    mockRequire.mockReturnValue(nativeModule);
    for (const fn of Object.values(nativeModule)) {
      fn.mockReset();
    }
    nativeModule.nativeEscapeXml.mockImplementation((s: string) => `esc:${s}`);
    nativeModule.nativeListDirectory.mockReturnValue({ output: 'dir', error: undefined });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('returns the native result on success', async () => {
    nativeModule.nativeRead.mockResolvedValue({ content: 'x', lineCount: 1 });
    await expect(tryNativeRead('/f')).resolves.toEqual({ content: 'x', lineCount: 1 });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('turns a thrown async native call into a final error verdict', async () => {
    nativeModule.nativeRead.mockRejectedValue(new Error('boom'));
    const result = await tryNativeRead('/f');
    expect(result?.error).toContain('native read failed');
    expect(result?.error).toContain('boom');
    expect(result?.errorKind).toBe('native_error');
    expect(result?.content).toBe('');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[native-tools]'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('nativeRead'));
  });

  it('turns a thrown sync native call into a final error verdict', () => {
    nativeModule.nativeListDirectory.mockImplementation(() => {
      throw new Error('sync boom');
    });
    const result = tryNativeListDirectory({});
    expect(result?.error).toContain('native list-directory failed');
    expect(result?.error).toContain('sync boom');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('nativeListDirectory'));
  });

  it('returns undefined for scalar helpers when the call throws (fallback allowed, still logged)', () => {
    nativeModule.nativeEscapeXml.mockImplementation(() => {
      throw new Error('escape boom');
    });
    expect(tryNativeEscapeXml('<')).toBeUndefined();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('nativeEscapeXml'));
  });

  it('returns undefined when the module cannot be loaded (designed fallback)', async () => {
    vi.resetModules();
    const { tryNativeEscapeXml: freshEscape, tryNativeRead: freshRead } =
      await import('#/_base/native-tools');
    mockRequire.mockImplementation(() => {
      throw new Error('MODULE_NOT_FOUND');
    });
    await expect(freshRead('/f')).resolves.toBeUndefined();
    expect(freshEscape('<')).toBeUndefined();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('returns undefined when the function is missing (version skew fallback)', async () => {
    mockRequire.mockReturnValue({ nativeRead: undefined });
    await expect(tryNativeRead('/f')).resolves.toBeUndefined();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('KIMI_NATIVE_TOOLS_FORCE_JS forces the TS path even when the addon loads', async () => {
    process.env['KIMI_NATIVE_TOOLS_FORCE_JS'] = '1';
    try {
      nativeModule.nativeRead.mockResolvedValue({ content: 'native', lineCount: 1 });
      await expect(tryNativeRead('/f')).resolves.toBeUndefined();
      expect(tryNativeEscapeXml('<')).toBeUndefined();
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      delete process.env['KIMI_NATIVE_TOOLS_FORCE_JS'];
    }
    await expect(tryNativeRead('/f')).resolves.toEqual({ content: 'native', lineCount: 1 });
  });
});
