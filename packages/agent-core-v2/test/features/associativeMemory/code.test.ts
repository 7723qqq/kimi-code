import { describe, expect, it } from 'bun:test';

import {
  applyRecallRules,
  applyWriteRules,
  orderConflictGroups,
  parseCode,
  resolveConflict,
} from '#/features/associativeMemory/code';
import { DEFAULT_CODE, DEFAULT_HARD_RULES } from '#/features/associativeMemory/code/defaults';
import type { HardRule, RecallItem } from '#/features/associativeMemory/types';

function recallRule(pattern: string): HardRule {
  return { id: 'r', pattern, regex: false, action: 'block_recall', scope: 'recall', reason: 'test' };
}

function item(id: string, text: string, confidence = 1, validFrom = 0): RecallItem {
  return {
    id,
    kind: 'atom',
    text,
    score: 1,
    noteId: `n:${id}`,
    conceptId: undefined,
    confidence,
    validFrom,
    validUntil: undefined,
    conflictGroup: undefined,
  };
}

describe('associative memory code', () => {
  it('ships a credential rule that blocks writes', () => {
    const credential = DEFAULT_HARD_RULES.find((rule) => rule.id === 'credential');
    expect(credential?.action).toBe('block_write');
    const blocked = applyWriteRules('token sk-abcdefghijklmnopqrstuvwxyz123456', DEFAULT_CODE.rules);
    expect(blocked.allowed).toBe(false);
    expect(blocked.matches.length).toBeGreaterThan(0);
  });

  it('allows ordinary notes', () => {
    expect(applyWriteRules('the login module retries twice', DEFAULT_CODE.rules).allowed).toBe(true);
  });

  it('filters recall items matched by a block_recall rule', () => {
    const rules = [recallRule('internal-host')];
    const items = [item('a', 'see internal-host for details'), item('b', 'public docs')];
    expect(applyRecallRules(items, rules).map((entry) => entry.id)).toEqual(['b']);
  });

  it('resolves conflicts by keeping every side and sorting by confidence and recency', () => {
    const items = [item('old', 'x', 0.5, 1), item('new', 'x', 0.9, 5)];
    const resolved = resolveConflict(items, []);
    expect(resolved.map((entry) => entry.id)).toEqual(['new', 'old']);
  });

  it('orders conflict groups by confidence and recency', () => {
    const older = { ...item('a', 'x', 0.5, 1), conflictGroup: 'g1' };
    const newer = { ...item('b', 'x', 0.9, 5), conflictGroup: 'g1' };
    const ordered = orderConflictGroups([older, newer], []);
    expect(ordered.map((entry) => entry.id)).toEqual(['b', 'a']);
  });

  it('parses a user code file with frontmatter rules and guidance prose', () => {
    const content = [
      '---',
      'rules:',
      '  - id: "no-internal-hosts"',
      '    pattern: "internal.example.com"',
      '    action: "block_write"',
      '    scope: "note"',
      '    reason: "internal host"',
      '---',
      'Prefer the user\'s own words.',
    ].join('\n');
    const code = parseCode(content, DEFAULT_CODE);
    expect(code.rules.some((rule) => rule.id === 'no-internal-hosts')).toBe(true);
    expect(code.guidance).toBe("Prefer the user's own words.");
  });

  it('falls back to the defaults when the file has no frontmatter', () => {
    const code = parseCode('just guidance', DEFAULT_CODE);
    expect(code.rules).toEqual(DEFAULT_CODE.rules);
    expect(code.guidance).toBe('just guidance');
  });
});
