import { describe, expect, it } from 'vitest';

import { renderPromptTemplateResult, systemPromptVars } from '#/app/agentProfileCatalog/profile-shared';

const TEMPLATE = 'BODY\n${model_adaptation_section}END';

describe('model_adaptation_section in the prompt vars', () => {
  it('is empty when the context carries no adaptation', () => {
    expect(systemPromptVars({ cwd: '/tmp' }, { skillActive: false })['model_adaptation_section']).toBe('');
  });

  it('wraps a supplied adaptation with the reference-data prose', () => {
    const vars = systemPromptVars(
      { cwd: '/tmp', modelAdaptation: '# Model Adaptation: deepseek\n\nBody.' },
      { skillActive: false },
    );
    const section = vars['model_adaptation_section'] ?? '';
    expect(section).toContain('# Model Adaptation: deepseek');
    expect(section).toContain('Body.');
    // The framing must describe hand-authored family guidance. It used to credit
    // a probe that no longer produces anything this section can carry.
    expect(section).toMatch(/standing guidance for the model family/);
    expect(section).not.toMatch(/produced by `scripts\/prompt-optimizer probe`/);
    expect(section).toMatch(/instructions above win/);
  });

  it('a supplied adaptation renders into the placeholder', () => {
    const text = renderPromptTemplateResult(
      TEMPLATE,
      { cwd: '/tmp', modelAdaptation: 'Body.' },
      { skillActive: false },
    ).text;
    expect(text).toContain('Body.');
    expect(text).not.toContain('${');
  });

  it('an absent adaptation leaves the placeholder empty', () => {
    const text = renderPromptTemplateResult(TEMPLATE, { cwd: '/tmp' }, { skillActive: false }).text;
    expect(text).not.toContain('# Model Adaptation');
    expect(text).not.toContain('${');
  });
});
