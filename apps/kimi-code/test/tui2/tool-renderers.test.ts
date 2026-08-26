/**
 * TUI2 tool-card wiring tests.
 *
 * Pins the two registry dispatches added for parity with v1
 * (`WaitFor` -> waitForSummary, `Read` -> media-aware summary) and the
 * MainShell pass-through of the store's live tool fields
 * (`progressLines` / `liveOutput` / `detachHint`) into `ToolCallView`.
 *
 * Note on strategy: mounting tui2 components under vitest is currently
 * impossible without config changes — `@opentui/solid` resolves to two
 * different module instances (vite picks `index.js` for source imports,
 * the bun runtime picks `index.bun.js` for the jsx-runtime's internal
 * self-import), so the RendererContext never reaches the reconciler
 * ("No renderer found"). Until the vitest config dedupes those paths,
 * these tests stay at the pure layer plus a source guard, mirroring the
 * house style of `test/tui/printable-key-guard.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  isGenericToolResult,
  pickResultRenderer,
} from '@/tui2/components/messages/tool-renderers/registry';
import { readSummary } from '@/tui2/components/messages/tool-renderers/summary';
import {
  buildVisualTruncatedRows,
  renderTruncated,
} from '@/tui2/components/messages/tool-renderers/truncated';
import { parseReadMediaOutput } from '@/tui2/components/messages/tool-renderers/media';
import { parseWaitForOutput } from '@/tui2/components/messages/tool-renderers/wait-for';

const MAIN_SHELL_SOURCE = join(__dirname, '..', '..', 'src', 'tui2', 'components', 'main-shell.tsx');

// ── Registry dispatches ─────────────────────────────────────────────────

describe('tui2 tool renderer registry dispatches', () => {
  const completedOutput = [
    'wait_status: completed',
    'task_id: question-80w0h7nw',
    'waited_ms: 9607',
    'timeout_ms: 300000',
    '',
    '[finished]',
    'task_id: question-80w0h7nw',
    'description: Pick one so I can demonstrate WaitFor with background questions?',
    'status: completed',
    'kind: question',
  ].join('\n');

  it('routes WaitFor away from the generic truncated fallback', () => {
    expect(isGenericToolResult('WaitFor')).toBe(false);
    expect(pickResultRenderer('WaitFor')).not.toBe(renderTruncated);
  });

  it('parses the WaitFor timeline into the finished-task view', () => {
    const view = parseWaitForOutput(completedOutput);
    expect(view).toMatchObject({
      status: 'completed',
      waitedMs: 9607,
      finishedTaskId: 'question-80w0h7nw',
      finishedStatus: 'completed',
      finishedDescription:
        'Pick one so I can demonstrate WaitFor with background questions?',
      extraCount: 0,
      runningCount: 0,
    });
  });

  it('parses still-running sections into counts and description samples', () => {
    const output = [
      'wait_status: timed_out',
      'task_id: bash-a1',
      'waited_ms: 30000',
      'timeout_ms: 30000',
      '',
      '[still_running]',
      'active_background_tasks: 2',
      'task_id: bash-a1',
      'description: bg sleep',
      'status: running',
      '---',
      'task_id: agent-b2',
      'description: investigate flaky test',
      'status: running',
    ].join('\n');
    expect(parseWaitForOutput(output)).toMatchObject({
      status: 'timed_out',
      waitedMs: 30000,
      runningCount: 2,
      runningSamples: ['bg sleep', 'investigate flaky test'],
    });
  });

  it('rejects non-timeline output so errors fall back to truncated', () => {
    expect(parseWaitForOutput('Task not found: bash-x')).toBeUndefined();
    expect(parseWaitForOutput('')).toBeUndefined();
  });

  it('detects media envelopes in Read output for the media summary dispatch', () => {
    // Dispatch shape: `Read` no longer maps straight to readSummary — the
    // wrapper checks the envelope first (identity check below pins that).
    expect(pickResultRenderer('Read')).not.toBe(readSummary);
    const envelope = JSON.stringify([
      { type: 'text', text: '<image path="/tmp/pic.png">' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
    ]);
    expect(parseReadMediaOutput(envelope)).toMatchObject({
      kind: 'image',
      path: '/tmp/pic.png',
      mimeType: 'image/png',
    });
    expect(parseReadMediaOutput('plain text file body')).toBeNull();
    expect(parseReadMediaOutput('[]')).toBeNull();
  });
});

// ── MainShell live tool-field wiring ────────────────────────────────────

describe('main-shell ToolCallView live-field wiring', () => {
  it('passes progressLines/liveOutput/detachHint from the entry into ToolCallView', () => {
    const source = readFileSync(MAIN_SHELL_SOURCE, 'utf8');
    const toolCallViewBlock = source.slice(
      source.indexOf('<ToolCallView'),
      source.indexOf('/>', source.indexOf('<ToolCallView')),
    );
    expect(toolCallViewBlock).toContain('toolCall={entry.toolCallData}');
    expect(toolCallViewBlock).toContain('progressLines={entry.toolCallData.progressLines}');
    expect(toolCallViewBlock).toContain('liveOutput={entry.toolCallData.liveOutput}');
    expect(toolCallViewBlock).toContain('detachHint={entry.toolCallData.detachHint}');
  });
});

// ── Visual-row truncation (TruncatedOutputView collapsed cap) ───────────

describe('buildVisualTruncatedRows folds and caps by visual rows', () => {
  it('caps a long single-line JSON blob instead of emitting one logical line', () => {
    const blob = 'aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd';
    const result = buildVisualTruncatedRows(blob, { maxLines: 3, width: 20, tail: false });
    expect(result.rows).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc']);
    expect(result.hidden).toBe(1);
  });

  it('folds CJK content two cells per char before capping', () => {
    const cjkBlob = '中'.repeat(24);
    const result = buildVisualTruncatedRows(cjkBlob, { maxLines: 3, width: 10, tail: false });
    expect(result.rows).toEqual(['中'.repeat(5), '中'.repeat(5), '中'.repeat(5)]);
    expect(result.hidden).toBe(2);
  });

  it('counts emoji as two cells when folding', () => {
    const result = buildVisualTruncatedRows('👍👍👍👍👍', { maxLines: 2, width: 4, tail: false });
    expect(result.rows).toEqual(['👍👍', '👍👍']);
    expect(result.hidden).toBe(1);
  });

  it('keeps the latest rows in tail mode', () => {
    const blob = 'aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd';
    const result = buildVisualTruncatedRows(blob, { maxLines: 2, width: 20, tail: true });
    expect(result.rows).toEqual(['cccccccccc', 'dddddddddd']);
    expect(result.hidden).toBe(2);
  });

  it('leaves output under the cap untouched across multiple lines', () => {
    const output = ['short', 'x'.repeat(15)].join('\n');
    const result = buildVisualTruncatedRows(output, { maxLines: 10, width: 10, tail: false });
    expect(result.rows).toEqual(['short', 'x'.repeat(10), 'x'.repeat(5)]);
    expect(result.hidden).toBe(0);
  });

  it('trims trailing empty logical lines before folding', () => {
    const result = buildVisualTruncatedRows('a\n\n\n', { maxLines: 3, width: 10, tail: false });
    expect(result.rows).toEqual(['a']);
    expect(result.hidden).toBe(0);
  });
});
