import { expect, it } from 'bun:test';
import { describe } from 'bun:test';

import { loadCuratedAdaptation } from '#/app/agentProfileCatalog/modelAdaptations';

const MAX_ADAPTATION_BYTES = 32 * 1024;

describe('deepseek curated adaptation', () => {
  it('carries the three v4.1 sections', async () => {
    const text = (await loadCuratedAdaptation('deepseek-v4.1-flash')) ?? '';
    expect(text).toContain('## Reasoning history');
    expect(text).toContain('## Tool arguments');
    expect(text).toContain('## Long context');
  });

  it('stays below the truncation limit and keeps its last section', async () => {
    const text = (await loadCuratedAdaptation('deepseek-v4.1-flash')) ?? '';
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThan(MAX_ADAPTATION_BYTES);
    expect(text).toContain('bounded suffix');
  });

  it('renders nothing for a model outside the family', async () => {
    expect(await loadCuratedAdaptation('gpt-4o')).toBeUndefined();
  });

  it('states that the token budget is unlimited', async () => {
    const adaptation = (await loadCuratedAdaptation('deepseek-v4.1-flash')) ?? '';
    expect(adaptation).toContain('## Token budget');
    expect(adaptation).toContain('unlimited');
  });

  it('carries the operating notes as standing guidance', async () => {
    const adaptation = (await loadCuratedAdaptation('deepseek-v4.1-flash')) ?? '';
    expect(adaptation).toContain('## Reasoning history');
    expect(adaptation).toContain('## Tool arguments');
    expect(adaptation).toContain('## Long context');
    expect(adaptation).not.toContain('## Working rules delegated by the minimal prompt');
  });
});
