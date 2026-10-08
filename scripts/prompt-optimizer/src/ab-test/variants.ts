/**
 * Prompt Optimizer — A/B variant construction.
 *
 * Variants are derived from the current prompt sections rather than from a
 * hardcoded edit: the previous implementation cut its "trimmed" variant out of
 * the prompt text with a regex, and when that text was edited out of
 * `system.md` the regex stopped matching, silently making both variants
 * byte-identical and every comparison vacuous.
 */

import { generateBaselineVariant, generatePruneVariant } from '../prompt-parser';
import type { PromptSection, PromptVariant } from '../types';

export class VariantSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VariantSpecError';
  }
}

export const BASELINE_SPEC = 'base';
export const PRUNE_PREFIX = 'prune:';

/**
 * Build one variant from a spec.
 *
 * `base` keeps the prompt as-is; `prune:<heading>` removes that section. The
 * heading must exist, or the variant would silently equal the baseline.
 */
export function buildVariant(sections: readonly PromptSection[], spec: string): PromptVariant {
  if (spec === BASELINE_SPEC) return generateBaselineVariant([...sections]);

  if (spec.startsWith(PRUNE_PREFIX)) {
    const heading = spec.slice(PRUNE_PREFIX.length);
    if (heading.length === 0) {
      throw new VariantSpecError(`"${spec}" names no section.`);
    }
    const exists = sections.some((s) => s.heading === heading);
    if (!exists) {
      throw new VariantSpecError(
        `No section named "${heading}". Available sections:\n` +
          sections.map((s) => `  ${s.heading}`).join('\n'),
      );
    }
    return generatePruneVariant([...sections], heading);
  }

  throw new VariantSpecError(
    `Unknown variant "${spec}". Use "${BASELINE_SPEC}" or "${PRUNE_PREFIX}<section>".`,
  );
}

/**
 * Build every variant, then refuse a set that cannot distinguish anything.
 *
 * Two identical variants produce a comparison that always ties, which reads as
 * "no difference between the variants" when in fact no comparison happened.
 */
export function buildVariants(
  sections: readonly PromptSection[],
  specs: readonly string[],
): PromptVariant[] {
  if (specs.length < 2) {
    throw new VariantSpecError(
      `An A/B test needs at least two variants; got ${specs.length}. ` +
        `Pass --variant twice, e.g. --variant base --variant ${PRUNE_PREFIX}<section>.`,
    );
  }

  const variants = specs.map((spec) => buildVariant(sections, spec));

  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      if (variants[i]!.content === variants[j]!.content) {
        throw new VariantSpecError(
          `Variants "${variants[i]!.name}" and "${variants[j]!.name}" have identical content; ` +
            `the comparison would be vacuous.`,
        );
      }
    }
  }

  return variants;
}
