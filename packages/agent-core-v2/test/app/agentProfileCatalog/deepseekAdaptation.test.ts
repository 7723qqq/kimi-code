import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe } from 'bun:test';

import { loadCuratedAdaptation } from '#/app/agentProfileCatalog/modelAdaptations';

const MAX_ADAPTATION_BYTES = 32 * 1024;

const minimalPrompt = readFileSync(
  join(import.meta.dirname, '../../../src/app/agentProfileCatalog/system.minimal.md'),
  'utf8',
);

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

  it('says the same three things in the minimal system prompt', () => {
    expect(minimalPrompt).toContain('Replay earlier reasoning in full');
    expect(minimalPrompt).toContain('exactly as given');
    expect(minimalPrompt).toContain('restate the objective and the hard constraints');
  });

  it('keeps the minimal prompt free of the variables the shape drops', () => {
    expect(minimalPrompt).not.toContain('${agents_md}');
    expect(minimalPrompt).not.toContain('${skills_section}');
    expect(minimalPrompt).not.toContain('${model_adaptation_section}');
    expect(minimalPrompt).toContain('${product_name}');
    expect(minimalPrompt).toContain('${cwd}');
  });
});
