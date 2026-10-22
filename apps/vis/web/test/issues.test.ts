import { describe, expect, it } from 'bun:test';

import { computeIssues } from '../src/lib/issues';
import type { WireEntry } from '../src/types';

let line = 0;
function loop(event: Record<string, unknown>): WireEntry {
  line += 1;
  return { lineNo: line, data: { type: 'context.append_loop_event', event }, raw: {} } as unknown as WireEntry;
}

describe('computeIssues — runtime error categories', () => {
  it('flags tool errors, truncation, filtered + max_tokens steps', () => {
    line = 0;
    const entries: WireEntry[] = [
      loop({ type: 'step.begin', uuid: 's1', turnId: 'T', step: 0 }),
      loop({ type: 'tool.call', uuid: 'a', turnId: 'T', step: 0, stepUuid: 's1', toolCallId: 'c1', name: 'Bash' }),
      loop({ type: 'tool.result', parentUuid: 'a', toolCallId: 'c1', result: { output: 'boom', isError: true, message: 'exit 1' } }),
      loop({ type: 'tool.call', uuid: 'b', turnId: 'T', step: 0, stepUuid: 's1', toolCallId: 'c2', name: 'Read' }),
      loop({ type: 'tool.result', parentUuid: 'b', toolCallId: 'c2', result: { output: 'partial', truncated: true } }),
      loop({ type: 'step.end', uuid: 's1', turnId: 'T', step: 0, finishReason: 'filtered', rawFinishReason: 'content_filter' }),
      loop({ type: 'step.begin', uuid: 's2', turnId: 'T', step: 1 }),
      loop({ type: 'step.end', uuid: 's2', turnId: 'T', step: 1, finishReason: 'max_tokens' }),
    ];

    const issues = computeIssues(entries, []);
    const byKind = new Map(issues.map((i) => [i.kind, i]));

    expect(byKind.get('tool_error')).toMatchObject({ severity: 'error', detail: 'exit 1' });
    expect(byKind.get('tool_truncated')).toMatchObject({ severity: 'info' });
    expect(byKind.get('model_filtered')).toMatchObject({ severity: 'error', detail: 'content_filter' });
    expect(byKind.get('model_max_tokens')).toMatchObject({ severity: 'warning' });

    // The tool.result rows are properly paired, so no orphan noise.
    expect(issues.some((i) => i.kind === 'orphan_tool_call' || i.kind === 'missing_tool_result')).toBe(false);
  });
});

// Audit a37/F2 — `permission.record_approval_result.result` is a compile-time
// assertion only (`z.custom<…>()`), so a malformed imported / hand-edited
// record reached `r.result.decision` and threw during render, unmounting the
// React root (blank app). The drawer must stay alive and simply report nothing.
describe('computeIssues — malformed approval records (a37/F2)', () => {
  it('does not throw on a record without a result, or with result: null', () => {
    line = 0;
    const entries = [
      { lineNo: 1, data: { type: 'permission.record_approval_result', toolName: 'Bash', toolCallId: 'c1' }, raw: {} },
      { lineNo: 2, data: { type: 'permission.record_approval_result', toolName: 'Bash', toolCallId: 'c2', result: null }, raw: {} },
    ] as unknown as WireEntry[];

    let issues: ReturnType<typeof computeIssues> | undefined;
    expect(() => {
      issues = computeIssues(entries, []);
    }).not.toThrow();
    expect(issues).toEqual([]);
  });

  it('still reports a well-formed rejection', () => {
    line = 0;
    const entries = [
      {
        lineNo: 1,
        data: {
          type: 'permission.record_approval_result',
          toolName: 'Bash',
          toolCallId: 'call-12345678',
          result: { decision: 'rejected', feedback: 'nope' },
        },
        raw: {},
      },
    ] as unknown as WireEntry[];

    const issues = computeIssues(entries, []);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      severity: 'info',
      kind: 'rejected_approval',
      lineNo: 1,
      detail: 'nope',
    });
  });

  it('ignores an approval whose decision is a non-string value', () => {
    line = 0;
    const entries = [
      {
        lineNo: 1,
        data: {
          type: 'permission.record_approval_result',
          toolName: 'Bash',
          toolCallId: 'c1',
          result: { decision: { unexpected: true } },
        },
        raw: {},
      },
    ] as unknown as WireEntry[];

    expect(computeIssues(entries, [])).toEqual([]);
  });
});
