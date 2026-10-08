import { describe, expect, test } from 'bun:test';

import { VariantSpecError, buildVariant, buildVariants } from '../src/ab-test/variants';
import type { PromptSection } from '../src/types';

function section(heading: string, body = ''): PromptSection {
  const content = `# ${heading}\n\n${body || `Body of ${heading}.`}`;
  return { heading, content, tokens: 10, startLine: 1, endLine: 3 };
}

const SECTIONS: PromptSection[] = [
  section('(preamble)', 'You are a coding agent.'),
  section('Coding', 'Write code that fits its surroundings.'),
  section('Environment', 'Report the current date.'),
];

describe('buildVariant', () => {
  test('base is the prompt unchanged', () => {
    const variant = buildVariant(SECTIONS, 'base');
    expect(variant.name).toBe('baseline');
    for (const s of SECTIONS) expect(variant.content).toContain(s.content);
  });

  test('prune:<heading> removes exactly that section', () => {
    const variant = buildVariant(SECTIONS, 'prune:Coding');
    expect(variant.content).not.toContain('Write code that fits its surroundings.');
    expect(variant.content).toContain('Report the current date.');
    expect(variant.modifiedSections).toEqual(['Coding']);
  });

  // Regression guard: the old implementation cut a variant out of the prompt
  // text with a regex, so when that text changed both variants became identical
  // and every comparison silently tied.
  test('a pruned variant differs from the baseline', () => {
    const baseline = buildVariant(SECTIONS, 'base');
    const pruned = buildVariant(SECTIONS, 'prune:Coding');
    expect(pruned.content).not.toBe(baseline.content);
  });

  test('an unknown section is refused, not silently ignored', () => {
    expect(() => buildVariant(SECTIONS, 'prune:NoSuchSection')).toThrow(VariantSpecError);
    expect(() => buildVariant(SECTIONS, 'prune:NoSuchSection')).toThrow(/NoSuchSection/);
  });

  test('the error lists the sections that do exist', () => {
    expect(() => buildVariant(SECTIONS, 'prune:Nope')).toThrow(/Coding/);
  });

  test('an unknown spec form is refused', () => {
    expect(() => buildVariant(SECTIONS, 'trimmed')).toThrow(/Unknown variant/);
    expect(() => buildVariant(SECTIONS, 'prune:')).toThrow(/names no section/);
  });
});

describe('buildVariants', () => {
  test('builds each spec in order', () => {
    const variants = buildVariants(SECTIONS, ['base', 'prune:Coding']);
    expect(variants.map((v) => v.name)).toEqual(['baseline', 'prune:Coding']);
  });

  test('refuses fewer than two variants', () => {
    expect(() => buildVariants(SECTIONS, [])).toThrow(/at least two/);
    expect(() => buildVariants(SECTIONS, ['base'])).toThrow(/at least two/);
  });

  test('refuses two variants with identical content', () => {
    // This is the guard the reported defect would have tripped.
    expect(() => buildVariants(SECTIONS, ['base', 'base'])).toThrow(/identical content/);
    expect(() => buildVariants(SECTIONS, ['base', 'base'])).toThrow(/vacuous/);
  });

  test('accepts two distinct prunes', () => {
    const variants = buildVariants(SECTIONS, ['prune:Coding', 'prune:Environment']);
    expect(variants).toHaveLength(2);
    expect(variants[0]!.content).not.toBe(variants[1]!.content);
  });
});
