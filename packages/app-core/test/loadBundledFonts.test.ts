import { stubGlobals } from '../../vite-preset/test/globals';
import { describe, expect, it, mock } from 'bun:test';
import { loadBundledFont } from '../src/composables/loadBundledFonts';


const stubGlobal = stubGlobals();

describe('loadBundledFont', () => {
  it('fetches the bundled face once its stylesheet is registered', async () => {
    const load = mock(() => Promise.resolve([]));
    stubGlobal('document', { fonts: { load } });
    await loadBundledFont('JetBrains Mono Variable');
    await loadBundledFont('JetBrains Mono Variable');
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('1em "JetBrains Mono Variable"');
  });

  it('resolves when the face fails to load', async () => {
    stubGlobal('document', { fonts: { load: () => Promise.reject(new Error('offline')) } });
    expect(await loadBundledFont('Schibsted Grotesk Variable')).toBeUndefined();
  });
});
