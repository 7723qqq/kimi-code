import { describe, expect, test } from 'bun:test';

import { appendEvidence, promotedVerdict } from '../upstream-ledger.mjs';

describe('upstream ledger evidence', () => {
  test('appends a probe result without replacing the existing evidence', () => {
    expect(appendEvidence('Detailed evidence.', '1 pass')).toBe('Detailed evidence. Probe: 1 pass');
  });

  test('does not append the same probe twice', () => {
    const once = appendEvidence('Detailed evidence.', '1 pass');
    expect(appendEvidence(once, '1 pass')).toBe(once);
  });

  test('uses the probe result when no evidence exists', () => {
    expect(appendEvidence('-', '1 pass')).toBe('1 pass');
    expect(appendEvidence('', '1 pass')).toBe('1 pass');
  });

  test('promotes only pending and in-progress rows', () => {
    expect(promotedVerdict('pending')).toBe('ported');
    expect(promotedVerdict('in_progress')).toBe('ported');
    expect(promotedVerdict('equivalent')).toBe('equivalent');
    expect(promotedVerdict('ported')).toBe('ported');
    expect(promotedVerdict('not-applicable')).toBe('not-applicable');
  });
});
