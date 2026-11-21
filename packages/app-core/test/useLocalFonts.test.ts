import { stubGlobals } from '../../vite-preset/test/globals';
import { describe, expect, it, mock } from 'bun:test';
import { until } from '@moonshot-ai/testkit/fixtures';
import { filterFontFamilies } from '../src/composables/useLocalFonts';

const stubGlobal = stubGlobals();

let generation = 0;

function freshModule(): Promise<typeof import('../src/composables/useLocalFonts')> {
  return import(`../src/composables/useLocalFonts.ts?test=${generation++}`);
}

async function waitForState(read: () => string, state: string): Promise<void> {
  await until(`local fonts ${state}`, () => read() === state);
}

describe('useLocalFonts', () => {
  it('reports unavailable when the API is missing', async () => {
    stubGlobal('window', {});
    const { useLocalFonts } = await freshModule();
    const { localFontsState, localFontFamilies, ensureLocalFonts } = useLocalFonts();
    ensureLocalFonts();
    await Promise.resolve();
    expect(localFontsState.value).toBe('unavailable');
    expect(localFontFamilies.value).toEqual([]);
  });

  it('dedupes and sorts families from queryLocalFonts', async () => {
    const queryLocalFonts = mock().mockResolvedValue([
      { family: 'Sarasa Mono SC' },
      { family: 'Menlo', style: 'Bold', postscriptName: 'Menlo-Bold' },
      { family: 'Menlo', style: 'Regular', postscriptName: 'Menlo-Regular' },
      { family: 'Sarasa Mono SC', style: 'Bold' },
      { family: '' },
      { style: 'Regular' },
      { family: 'Inter' },
    ]);
    stubGlobal('window', { queryLocalFonts });
    const { useLocalFonts, getLocalFontFace } = await freshModule();
    const { localFontsState, localFontFamilies, ensureLocalFonts } = useLocalFonts();
    ensureLocalFonts();
    await waitForState(() => localFontsState.value, 'ready');
    expect(localFontFamilies.value).toEqual(['Inter', 'Menlo', 'Sarasa Mono SC']);
    expect(getLocalFontFace('Menlo')?.postscriptName).toBe('Menlo-Regular');
  });

  it('keeps each family\'s full names for search', async () => {
    const queryLocalFonts = mock().mockResolvedValue([
      { family: 'PingFang SC', style: 'Regular', fullName: '苹方-简 常规体' },
      { family: 'PingFang SC', style: 'Semibold', fullName: '苹方-简 中粗体' },
      { family: 'Menlo', style: 'Regular' },
    ]);
    stubGlobal('window', { queryLocalFonts });
    const { useLocalFonts, localFontSearchNames } = await freshModule();
    const { localFontsState, ensureLocalFonts } = useLocalFonts();
    ensureLocalFonts();
    await waitForState(() => localFontsState.value, 'ready');
    expect([...localFontSearchNames('PingFang SC')]).toEqual(['苹方-简 常规体', '苹方-简 中粗体']);
    expect(localFontSearchNames('Menlo').size).toBe(0);
    expect(localFontSearchNames('Unknown').size).toBe(0);
  });

  it('queries at most once and turns unavailable on rejection', async () => {
    const queryLocalFonts = mock().mockRejectedValue(new Error('denied'));
    stubGlobal('window', { queryLocalFonts });
    const { useLocalFonts } = await freshModule();
    const { localFontsState, ensureLocalFonts } = useLocalFonts();
    ensureLocalFonts();
    await waitForState(() => localFontsState.value, 'unavailable');
    ensureLocalFonts();
    await Promise.resolve();
    expect(queryLocalFonts).toHaveBeenCalledTimes(1);
  });
});

describe('ensureLocalFontsIfPermitted', () => {
  it('enumerates fonts once when several callers race the permission check', async () => {
    const queryLocalFonts = mock().mockResolvedValue([{ family: 'Inter' }]);
    stubGlobal('window', { queryLocalFonts });
    stubGlobal('navigator', { permissions: { query: () => Promise.resolve({ state: 'granted' }) } });
    try {
      const { ensureLocalFontsIfPermitted, useLocalFonts } = await freshModule();
      await Promise.all([ensureLocalFontsIfPermitted(), ensureLocalFontsIfPermitted(), ensureLocalFontsIfPermitted()]);
      await waitForState(() => useLocalFonts().localFontsState.value, 'ready');
      expect(queryLocalFonts).toHaveBeenCalledTimes(1);
    } finally {
      stubGlobal.restore();
    }
  });
});

describe('filterFontFamilies', () => {
  const families = ['Inter', 'Menlo', 'Sarasa Mono SC', 'SF Mono', 'PingFang SC'];

  it('returns the complete list for an empty query', () => {
    expect(filterFontFamilies(families, '')).toEqual(families);
    expect(filterFontFamilies(families, '  ')).toEqual(families);
  });

  it('matches case-insensitive substrings anywhere in the name', () => {
    expect(filterFontFamilies(families, 'mono')).toEqual(['Sarasa Mono SC', 'SF Mono']);
    expect(filterFontFamilies(families, 'SC')).toEqual(['Sarasa Mono SC', 'PingFang SC']);
    expect(filterFontFamilies(families, 'nope')).toEqual([]);
  });

  it('keeps every match beyond the first menu page', () => {
    const many = Array.from({ length: 350 }, (_, i) => `Font ${i}`);
    expect(filterFontFamilies(many, '')).toEqual(many);
    expect(filterFontFamilies(many, 'font')).toEqual(many);
    expect(filterFontFamilies(many, '349')).toEqual(['Font 349']);
  });
});
