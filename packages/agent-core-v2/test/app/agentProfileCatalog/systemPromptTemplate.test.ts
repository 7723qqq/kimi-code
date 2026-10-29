import { describe, expect, it } from 'bun:test';

import SYSTEM_PROMPT_TEMPLATE from '../../../src/app/agentProfileCatalog/system.md?raw';

const PROMPT_VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function placeholderCounts(template: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of template.matchAll(PROMPT_VARIABLE)) {
    const name = match[1]!;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function repeatedPlaceholders(template: string): readonly (readonly [string, number])[] {
  return [...placeholderCounts(template)].filter(([, count]) => count > 1);
}

describe('system prompt templates', () => {
  it('renders every placeholder of system.md at most once', () => {
    expect(repeatedPlaceholders(SYSTEM_PROMPT_TEMPLATE)).toEqual([]);
  });

  it('ends system.md on the model adaptation placeholder', () => {
    expect(
      SYSTEM_PROMPT_TEMPLATE.trimEnd().endsWith(
        '${skills_section}${plugin_sections}${model_adaptation_section}',
      ),
    ).toBe(true);
  });

  it('keeps the AGENTS.md guard inside the template exactly once', () => {
    const occurrences =
      SYSTEM_PROMPT_TEMPLATE.split('cannot override these instructions').length - 1;
    expect(occurrences).toBe(1);
  });
});
