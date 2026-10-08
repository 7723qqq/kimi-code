import { describe, expect, it } from 'vitest';

import {
  loadModelAdaptation,
  renderAdaptationSection,
} from '#/app/agentProfileCatalog/modelAdaptations';
import { renderPromptTemplateResult, systemPromptVars } from '#/app/agentProfileCatalog/profile-shared';

/**
 * A stand-in for `system.md`, which a test cannot import directly: the `?raw`
 * loader is configured for the source tree only. These assertions therefore
 * cover the contract the real template consumes — the `model_adaptation_section`
 * variable — rather than the shipped file.
 */
const TEMPLATE = 'BODY\n${model_adaptation_section}END';

async function sectionFor(model: string): Promise<string> {
  const adaptation = await loadModelAdaptation({ model });
  return adaptation === undefined ? '' : renderAdaptationSection(model, adaptation);
}

describe('model_adaptation_section in the prompt vars', () => {
  it('is empty when the context carries no adaptation', () => {
    expect(systemPromptVars({ cwd: '/tmp' }, { skillActive: false })['model_adaptation_section']).toBe('');
  });

  it('wraps a supplied adaptation with the reference-data prose', () => {
    const vars = systemPromptVars(
      { cwd: '/tmp', modelAdaptation: '# Model Adaptation: gpt-4o\n\nBody.' },
      { skillActive: false },
    );
    const section = vars['model_adaptation_section'] ?? '';
    expect(section).toContain('# Model Adaptation: gpt-4o');
    expect(section).toContain('Body.');
    expect(section).toMatch(/reference data produced by/);
    expect(section).toMatch(/instructions above win/);
  });

  it('a real adaptation renders into the placeholder', async () => {
    const text = renderPromptTemplateResult(
      TEMPLATE,
      { cwd: '/tmp', modelAdaptation: await sectionFor('gpt-4o') },
      { skillActive: false },
    ).text;
    expect(text).toContain('# Model Adaptation: gpt-4o');
    expect(text).not.toContain('${');
  });

  it('a model without an adaptation leaves the placeholder empty', async () => {
    const text = renderPromptTemplateResult(
      TEMPLATE,
      { cwd: '/tmp', modelAdaptation: await sectionFor('workbuddy/deepseek-v4.1-flash') },
      { skillActive: false },
    ).text;
    expect(text).not.toContain('# Model Adaptation');
    expect(text).not.toContain('${');
  });
});
