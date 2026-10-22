import { describe, expect, it } from 'bun:test';

import { modelsToToml } from '#/app/kosongConfig/configSection';

function tomlModels(value: unknown, rawSnake: unknown): Record<string, Record<string, unknown>> {
  return modelsToToml(value, rawSnake) as Record<string, Record<string, unknown>>;
}

describe('modelsToToml capabilities', () => {
  it('replaces the capabilities instead of unioning them with the values already on disk', () => {
    const out = tomlModels(
      { m: { capabilities: ['thinking'] } },
      { m: { capabilities: ['image_in', 'thinking'] } },
    );

    expect(out['m']?.['capabilities']).toEqual(['thinking']);
  });

  it('keeps the existing trim / dedupe / empty-drop normalization on the submitted list', () => {
    const out = tomlModels(
      { m: { capabilities: [' thinking ', 'thinking', '  ', 'image_in'] } },
      { m: { capabilities: ['image_in', 'thinking'] } },
    );

    expect(out['m']?.['capabilities']).toEqual(['thinking', 'image_in']);
  });

  it('drops every capability from the file when the submitted list is empty', () => {
    const out = tomlModels({ m: { capabilities: [] } }, { m: { capabilities: ['thinking'] } });

    expect(out['m']?.['capabilities']).toEqual([]);
  });

  it('leaves the on-disk capabilities alone when the record does not submit the field', () => {
    const out = tomlModels(
      { m: { maxContextSize: 1000 } },
      { m: { capabilities: ['thinking'], max_context_size: 1000 } },
    );

    expect(out['m']?.['capabilities']).toEqual(['thinking']);
  });

  it('leaves a non-array capabilities value untouched', () => {
    const out = tomlModels({ m: { capabilities: 'thinking' } }, { m: {} });

    expect(out['m']?.['capabilities']).toBe('thinking');
  });

  it('keeps the replacement semantics of the overrides.capabilities branch', () => {
    const out = tomlModels(
      { m: { overrides: { capabilities: ['thinking'] } } },
      { m: { overrides: { capabilities: ['image_in', 'thinking'] } } },
    );

    expect(out['m']?.['overrides']).toEqual({ capabilities: ['thinking'] });
  });
});
