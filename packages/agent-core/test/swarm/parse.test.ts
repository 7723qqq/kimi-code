import { describe, expect, it } from 'vitest';

import { extractJsonObject, parsePlan } from '../../src/agent/swarm/parse';

describe('extractJsonObject', () => {
  it('extracts a fenced json block', () => {
    expect(extractJsonObject('blah\n```json\n{"a":1}\n```\ntail')).toBe('{"a":1}');
  });
  it('extracts a bare object from surrounding prose', () => {
    expect(extractJsonObject('here you go: {"a":1} done')).toBe('{"a":1}');
  });
  it('returns null when no object is present', () => {
    expect(extractJsonObject('no json here')).toBeNull();
  });
});

describe('parsePlan', () => {
  const good = JSON.stringify({
    subtasks: [
      { role: 'Researcher', systemPrompt: 'be a researcher', prompt: 'research X' },
      { id: 'b', role: 'Writer', systemPrompt: 'be a writer', prompt: 'write Y', toolAllowlist: ['Read'] },
    ],
  });

  it('parses a valid plan and fills default ids', () => {
    const plan = parsePlan('root', '```json\n' + good + '\n```');
    expect(plan).not.toBeNull();
    expect(plan?.rootTask).toBe('root');
    expect(plan?.subtasks).toHaveLength(2);
    expect(plan?.subtasks[0]?.id).toBe('task-1');
    expect(plan?.subtasks[0]?.status).toBe('pending');
    expect(plan?.subtasks[1]?.id).toBe('b');
    expect(plan?.subtasks[1]?.toolAllowlist).toEqual(['Read']);
  });

  it('returns null for empty subtasks', () => {
    expect(parsePlan('root', '{"subtasks":[]}')).toBeNull();
  });

  it('returns null when a subtask misses required fields', () => {
    expect(parsePlan('root', '{"subtasks":[{"role":"R"}]}')).toBeNull();
  });

  it('returns null for non-json garbage', () => {
    expect(parsePlan('root', 'totally not json')).toBeNull();
  });
});
