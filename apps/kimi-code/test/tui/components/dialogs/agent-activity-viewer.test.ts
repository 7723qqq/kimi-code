import { describe, expect, it } from 'bun:test';

import { AgentActivityViewer } from '#/tui/components/dialogs/agent-activity-viewer';
import type { SubagentActivityRecord } from '#/tui/controllers/subagent-activity-store';

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function record(overrides: Partial<SubagentActivityRecord> = {}): SubagentActivityRecord {
  return {
    agentId: 'agent-1',
    agentName: 'explore',
    description: 'find things',
    parentToolCallId: 'tc-1',
    steps: [],
    totalSteps: 0,
    status: 'running',
    version: 1,
    ...overrides,
  };
}

function makeViewer(
  props: Partial<{
    record: SubagentActivityRecord | undefined;
    workspaceDir: string | undefined;
    expanded: boolean;
  }> = {},
): AgentActivityViewer {
  return new AgentActivityViewer({
    record: props.record,
    workspaceDir: props.workspaceDir,
    expanded: props.expanded ?? false,
  });
}

function renderPlain(viewer: AgentActivityViewer, width = 80, height = 20): string {
  return strip(viewer.renderLines(width, height).join('\n'));
}

describe('AgentActivityViewer — embedded rendering', () => {
  it('returns exactly the requested number of lines', () => {
    const viewer = makeViewer({ record: record() });
    expect(viewer.renderLines(80, 7).length).toBe(7);
    expect(viewer.renderLines(80, 20).length).toBe(20);
  });

  it('returns no lines for a zero height', () => {
    expect(makeViewer({ record: record() }).renderLines(80, 0)).toEqual([]);
  });

  it('shows the agent label and step range in the header', () => {
    const viewer = makeViewer({
      record: record({
        steps: [
          { step: 8, textTail: '', toolCalls: [] },
          { step: 9, textTail: '', toolCalls: [] },
        ],
        totalSteps: 12,
      }),
    });
    const text = renderPlain(viewer, 120);
    expect(text).toContain('explore › find things');
    expect(text).toContain('step 8–9');
  });

  it('renders steps with tool call headers and result renderer output', () => {
    const viewer = makeViewer({
      record: record({
        steps: [
          {
            step: 0,
            textTail: 'Looking for the event bus definition.',
            toolCalls: [
              {
                id: 't1',
                name: 'Grep',
                args: { pattern: 'IEventBus', output_mode: 'content' },
                status: 'done',
                startedAt: 0,
                result: {
                  tool_call_id: 't1',
                  output: 'src/a.ts:1:IEventBus\nsrc/b.ts:2:IEventBus',
                  is_error: false,
                },
              },
            ],
          },
        ],
        totalSteps: 1,
      }),
    });
    const text = renderPlain(viewer);
    expect(text).toContain('── step 0 ──');
    expect(text).toContain('Looking for the event bus definition.');
    expect(text).toContain('Used Grep (IEventBus) · 2 matches across 2 files');
    expect(text).toContain('src/a.ts:1, src/b.ts:2');
  });

  it('hides successful output by default and reveals it with the expanded flag', () => {
    const longOutput = Array.from({ length: 10 }, (_, i) => `line ${String(i + 1)}`).join('\n');
    const rec = record({
      steps: [
        {
          step: 0,
          textTail: '',
          toolCalls: [
            {
              id: 't1',
              name: 'Bash',
              args: { command: 'ls' },
              status: 'done',
              startedAt: 0,
              result: { tool_call_id: 't1', output: longOutput, is_error: false },
            },
          ],
        },
      ],
      totalSteps: 1,
    });

    const collapsed = makeViewer({ record: rec });
    const collapsedText = renderPlain(collapsed);
    expect(collapsedText).toContain('Bash');
    expect(collapsedText).toContain('line 10');
    expect(collapsedText).not.toContain('line 9');

    const expanded = makeViewer({ record: rec, expanded: true });
    expect(renderPlain(expanded)).toContain('line 9');
  });

  it('keeps the latest activity when the body is taller than the panel', () => {
    const steps = Array.from({ length: 8 }, (_, i) => ({
      step: i,
      textTail: `step ${String(i)} text`,
      toolCalls: [],
    }));
    const viewer = makeViewer({ record: record({ steps, totalSteps: 8 }) });
    const text = renderPlain(viewer, 80, 4);
    expect(text).toContain('step 7 text');
    expect(text).not.toContain('step 0 text');
  });

  it('renders the terminal result summary section', () => {
    const viewer = makeViewer({
      record: record({ status: 'completed', resultSummary: 'Found 3 call sites.' }),
    });
    const text = renderPlain(viewer);
    expect(text).toContain('Result');
    expect(text).toContain('Found 3 call sites.');
  });

  it('renders the failure section', () => {
    const viewer = makeViewer({
      record: record({ status: 'failed', error: 'boom' }),
    });
    const text = renderPlain(viewer);
    expect(text).toContain('Failed');
    expect(text).toContain('boom');
  });

  it('shows an empty header when no record exists', () => {
    const viewer = makeViewer({ record: undefined });
    expect(renderPlain(viewer)).toContain('—');
  });
});

describe('AgentActivityViewer — setProps', () => {
  it('rebuilds the body when the record version changes', () => {
    const rec = record({
      steps: [{ step: 0, textTail: 'first', toolCalls: [] }],
      totalSteps: 1,
    });
    const viewer = makeViewer({ record: rec });
    expect(renderPlain(viewer)).toContain('first');

    rec.steps.push({ step: 1, textTail: 'second', toolCalls: [] });
    rec.version += 1;
    viewer.setProps({ record: rec, expanded: false });
    expect(renderPlain(viewer)).toContain('second');
  });

  it('keeps the cached body when nothing relevant changed', () => {
    const rec = record({
      steps: [{ step: 0, textTail: 'first', toolCalls: [] }],
      totalSteps: 1,
    });
    const viewer = makeViewer({ record: rec });
    const before = renderPlain(viewer);
    viewer.setProps({ record: rec, expanded: false });
    expect(renderPlain(viewer)).toBe(before);
  });
});
