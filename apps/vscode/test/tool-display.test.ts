/**
 * Scenario: SDK tool displays are projected into the text and block shapes the
 * released VS Code webview consumes.
 * Responsibilities: every display kind produces a non-empty description, and
 * the block projection stays total — an unmapped kind must never crash the host.
 * Wiring: the pure mapping functions are used directly; there are no stubs.
 * Run: bunx vitest run --config apps/vscode/vitest.config.ts apps/vscode/test/tool-display.test.ts
 */

import type { ToolInputDisplay } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import { describeToolDisplay, toLegacyDisplay } from '../src/runtime/tool-display';

const SPEC_REVIEW: ToolInputDisplay = {
  kind: 'spec_review',
  dir: '/ws/specs/spec-1',
  documents: [
    { name: 'requirements.md', content: '# Requirements' },
    { name: 'design.md', content: '# Design' },
    { name: 'tasks.md', content: '# Tasks' },
  ],
};

describe('describeToolDisplay', () => {
  it('describes a spec review with its directory', () => {
    expect(describeToolDisplay(SPEC_REVIEW)).toContain('/ws/specs/spec-1');
  });

  it('never returns an empty description', () => {
    const displays: readonly ToolInputDisplay[] = [
      SPEC_REVIEW,
      { kind: 'command', command: 'ls' },
      { kind: 'plan_review', plan: '# Plan' },
      { kind: 'goal_start', objective: 'Ship it', mode: 'manual' },
      { kind: 'generic', summary: 'something' },
      { kind: 'todo_list', items: [] },
    ];

    for (const display of displays) {
      expect(describeToolDisplay(display).length).toBeGreaterThan(0);
    }
  });
});

describe('toLegacyDisplay', () => {
  it('projects a spec review as a brief, not a crash', () => {
    const blocks = toLegacyDisplay(SPEC_REVIEW);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('brief');
    expect((blocks[0] as { text: string }).text).toContain('/ws/specs/spec-1');
  });

  it('returns a block for every kind it declares', () => {
    const displays: readonly ToolInputDisplay[] = [
      SPEC_REVIEW,
      { kind: 'command', command: 'ls', language: 'bash' },
      { kind: 'diff', path: '/ws/a.ts', before: 'a', after: 'b' },
      { kind: 'search', query: 'needle' },
      { kind: 'url_fetch', url: 'https://example.com' },
      { kind: 'task', task_id: 't1', status: 'running', description: 'doing it' },
      { kind: 'task_stop', task_id: 't1', task_description: 'stop it' },
      { kind: 'goal_start', objective: 'Ship it', mode: 'manual' },
      { kind: 'generic', summary: 'something' },
    ];

    for (const display of displays) {
      expect(toLegacyDisplay(display).length).toBeGreaterThan(0);
    }
  });
});
