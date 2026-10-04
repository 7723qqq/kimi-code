import { describe, expect, it } from 'vitest';

import { buildApprovalBlock, buildDiffLines, toUiQuestion } from '../src/lib/approvalView';
import type { AppApprovalRequest, AppQuestionRequest } from '../src/api/types';

function approval(display: unknown): AppApprovalRequest {
  return {
    approvalId: 'ap-1',
    sessionId: 'ses-1',
    toolCallId: 'tc-1',
    toolName: 'Bash',
    action: 'run something',
    display,
    expiresAt: '2026-01-01T00:00:00Z',
  };
}

describe('buildDiffLines', () => {
  it('prefixes removed and added lines with gutter numbers', () => {
    expect(buildDiffLines('a\nb', 'a\nc')).toEqual([
      { kind: 'rem', gutter: '1', text: '- a' },
      { kind: 'rem', gutter: '2', text: '- b' },
      { kind: 'add', gutter: '1', text: '+ a' },
      { kind: 'add', gutter: '2', text: '+ c' },
    ]);
  });
});

describe('buildApprovalBlock', () => {
  it('passes a pre-built diff array through', () => {
    const diff = [{ kind: 'rem', gutter: '1', text: '- x' }];
    expect(buildApprovalBlock(approval({ kind: 'diff', path: 'f.ts', diff }))).toEqual({
      kind: 'diff',
      path: 'f.ts',
      diff,
    });
  });

  it('builds diff lines from old_text/new_text', () => {
    const block = buildApprovalBlock(
      approval({ kind: 'diff', path: 'f.ts', old_text: 'a', new_text: 'b' }),
    );
    expect(block).toEqual({
      kind: 'diff',
      path: 'f.ts',
      diff: [
        { kind: 'rem', gutter: '1', text: '- a' },
        { kind: 'add', gutter: '1', text: '+ b' },
      ],
    });
  });

  it('falls back to an empty diff when the payload is unusable', () => {
    expect(buildApprovalBlock(approval({ kind: 'diff', path: 'f.ts', diff: 'nope' }))).toEqual({
      kind: 'diff',
      path: 'f.ts',
      diff: [],
    });
  });

  it('maps shell and command kinds to a shell block', () => {
    expect(buildApprovalBlock(approval({ kind: 'shell', command: 'ls', cwd: '/tmp' }))).toEqual({
      kind: 'shell',
      command: 'ls',
      cwd: '/tmp',
      danger: undefined,
    });
    expect(buildApprovalBlock(approval({ kind: 'command' }))).toEqual({
      kind: 'shell',
      command: 'run something',
      cwd: undefined,
      danger: undefined,
    });
  });

  it('maps file_content and file kinds to a file block', () => {
    expect(
      buildApprovalBlock(approval({ kind: 'file_content', path: 'a.ts', content: 'x', language: 'ts' })),
    ).toEqual({ kind: 'file', path: 'a.ts', content: 'x', language: 'ts' });
  });

  it('accepts both file_op and fileop spellings', () => {
    expect(buildApprovalBlock(approval({ kind: 'fileop', op: 'delete', path: 'a' }))).toEqual({
      kind: 'fileop',
      op: 'delete',
      path: 'a',
      detail: undefined,
    });
    expect(buildApprovalBlock(approval({ kind: 'file_op', operation: 'move', path: 'a' })).op).toBe(
      'move',
    );
  });

  it('maps url_fetch and search blocks with action fallbacks', () => {
    expect(buildApprovalBlock(approval({ kind: 'url', method: 'GET' }))).toEqual({
      kind: 'url',
      method: 'GET',
      url: 'run something',
    });
    expect(buildApprovalBlock(approval({ kind: 'search', query: 'q', scope: 'src' }))).toEqual({
      kind: 'search',
      query: 'q',
      scope: 'src',
    });
  });

  it('maps invocation aliases and keeps the tool name fallback', () => {
    expect(buildApprovalBlock(approval({ kind: 'agent_call', name: 'swarm' }))).toEqual({
      kind: 'invocation',
      kind2: 'agent_call',
      name: 'swarm',
      description: undefined,
    });
    expect(buildApprovalBlock(approval({ kind: 'skill_call' })).name).toBe('Bash');
  });

  it('keeps only true-valued todo items with a pending default status', () => {
    const block = buildApprovalBlock(
      approval({ kind: 'todo', items: [{ title: 'a', status: 'done' }, { title: 42 }] }),
    );
    expect(block).toEqual({
      kind: 'todo',
      items: [
        { title: 'a', status: 'done' },
        { title: '', status: 'pending' },
      ],
    });
  });

  it('drops plan_review options without a label', () => {
    const block = buildApprovalBlock(
      approval({
        kind: 'plan_review',
        plan: '# Plan',
        options: [{ label: 'A', description: 'd' }, { description: 'no label' }],
      }),
    );
    expect(block).toEqual({
      kind: 'plan_review',
      plan: '# Plan',
      path: undefined,
      options: [{ label: 'A', description: 'd' }],
    });
  });

  it('falls back to a generic block for unknown kinds and missing display', () => {
    expect(buildApprovalBlock(approval({ kind: 'mystery' }))).toEqual({
      kind: 'generic',
      summary: 'run something',
    });
    expect(buildApprovalBlock(approval(undefined))).toEqual({
      kind: 'generic',
      summary: 'run something',
    });
  });
});

describe('toUiQuestion', () => {
  it('maps the request into the UI shape', () => {
    const q: AppQuestionRequest = {
      questionId: 'q-1',
      sessionId: 'ses-1',
      questions: [
        {
          id: 'qi-1',
          question: 'Proceed?',
          header: 'Confirm',
          body: 'Details',
          options: [{ id: 'o1', label: 'Yes', description: 'go', recommended: true }],
          multiSelect: false,
          allowOther: true,
          otherLabel: 'Other…',
        },
      ],
      createdAt: '2026-01-01T00:00:00Z',
    };
    expect(toUiQuestion(q)).toEqual({
      questionId: 'q-1',
      sessionId: 'ses-1',
      questions: [
        {
          id: 'qi-1',
          question: 'Proceed?',
          header: 'Confirm',
          body: 'Details',
          options: [{ id: 'o1', label: 'Yes', description: 'go', recommended: true }],
          multiSelect: false,
          allowOther: true,
          otherLabel: 'Other…',
        },
      ],
    });
  });
});