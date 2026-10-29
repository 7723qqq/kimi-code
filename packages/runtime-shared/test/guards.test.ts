import { describe, expect, it } from 'bun:test';

import { isRecord } from '#/guards';

describe('isRecord', () => {
  it('accepts a plain object', () => {
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('accepts an object with no keys', () => {
    expect(isRecord({})).toBe(true);
  });

  it('rejects an array', () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([{ a: 1 }])).toBe(false);
  });

  it('rejects null and undefined', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });

  it('rejects primitives and functions', () => {
    expect(isRecord('text')).toBe(false);
    expect(isRecord(0)).toBe(false);
    expect(isRecord(true)).toBe(false);
    expect(isRecord(() => undefined)).toBe(false);
  });

  it('narrows the value to a string-keyed record', () => {
    const value: unknown = { answer: 42 };
    if (!isRecord(value)) throw new Error('expected a record');
    expect(value['answer']).toBe(42);
  });
});
