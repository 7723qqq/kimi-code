import { describe, expect, it } from 'vitest';

import {
  familyAdaptationPrefixes,
  imagePricingForModel,
  normalizeModelName,
  promptShapeForModel,
  reasoningEffortForModel,
  resolveModelFamily,
} from '#/llm/modelFamily';

describe('resolveModelFamily', () => {
  it('resolves the deepseek family from a bare model id', () => {
    expect(resolveModelFamily('deepseek-flash')?.id).toBe('deepseek');
    expect(resolveModelFamily('DeepSeek-V4.1-Flash')?.id).toBe('deepseek');
  });

  it('resolves the current official name and the retired one alike', () => {
    expect(resolveModelFamily('deepseek-flash')?.id).toBe('deepseek');
    expect(resolveModelFamily('deepseek-v4-pro')?.id).toBe('deepseek');
  });

  it('resolves through a provider-qualified model id', () => {
    expect(resolveModelFamily('workbuddy/deepseek-v4.1-flash')?.id).toBe('deepseek');
  });

  it('resolves the astron-hosted deepseek ids', () => {
    expect(resolveModelFamily('xopdeepseekv4pro')?.id).toBe('deepseek');
    expect(resolveModelFamily('xopdeepseekv4flash')?.id).toBe('deepseek');
    expect(resolveModelFamily('xopdeepseekv32')?.id).toBe('deepseek');
  });

  it('is case-insensitive and returns the same profile object', () => {
    const lower = resolveModelFamily('deepseek-flash');
    const upper = resolveModelFamily('DEEPSEEK-FLASH');
    expect(upper).toBe(lower);
    expect(normalizeModelName('DeepSeek-Flash')).toBe('deepseek-flash');
  });

  it('does not match unrelated, embedded, or empty names', () => {
    expect(resolveModelFamily('gpt-4o')).toBeUndefined();
    expect(resolveModelFamily('claude-3.5-sonnet')).toBeUndefined();
    expect(resolveModelFamily('')).toBeUndefined();
    expect(resolveModelFamily('my-deepseek-clone')).toBeUndefined();
  });
});

describe('familyAdaptationPrefixes', () => {
  it('exposes the deepseek prefixes for a matching model', () => {
    expect(familyAdaptationPrefixes('deepseek-flash')).toEqual(['deepseek']);
  });

  it('returns an empty list for an unmatched model', () => {
    expect(familyAdaptationPrefixes('gpt-4o')).toEqual([]);
  });
});

describe('imagePricingForModel', () => {
  it('provides the deepseek vision accounting for family members', () => {
    const pricing = imagePricingForModel('deepseek-flash');
    expect(pricing?.patchPx).toBe(14);
    expect(pricing?.downsampleRatio).toBe(3);
    expect(pricing?.scaleUpFloorPx).toBe(544);
    expect(pricing?.tokenCap).toBe(1024);
    expect(pricing?.fallbackTokens).toBe(1024);
  });

  it('provides no pricing for models outside any family', () => {
    expect(imagePricingForModel('gpt-4o')).toBeUndefined();
  });

  it('accepts an undefined model name', () => {
    expect(imagePricingForModel(undefined)).toBeUndefined();
  });
});

describe('reasoningEffortForModel', () => {
  it('declares the deepseek history default', () => {
    expect(reasoningEffortForModel('deepseek-flash')?.historyDefault).toBe('high');
  });

  it('declares nothing for models outside any family', () => {
    expect(reasoningEffortForModel('gpt-4o')).toBeUndefined();
    expect(reasoningEffortForModel(undefined)).toBeUndefined();
  });
});

describe('promptShapeForModel', () => {
  it('declares the minimal shape for the deepseek family', () => {
    expect(promptShapeForModel('deepseek-v4.1-flash')).toBe('minimal');
    expect(promptShapeForModel('deepseek-v4-pro')).toBe('minimal');
    expect(promptShapeForModel('workbuddy/deepseek-v4-flash')).toBe('minimal');
  });

  it('declares nothing for models outside any family', () => {
    expect(promptShapeForModel('gpt-4o')).toBeUndefined();
    expect(promptShapeForModel('my-deepseek-clone')).toBeUndefined();
    expect(promptShapeForModel(undefined)).toBeUndefined();
  });
});
