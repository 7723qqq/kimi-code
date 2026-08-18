import type { Terminal } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { ModelSelectorComponent } from '#/tui/components/dialogs/model-selector';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { createTUIState, type KimiTUIOptions } from '#/tui/kimi-tui';
import type { AppState } from '#/tui/types';
import { createEmptySessionStats } from '#/tui/utils/session-stats';

import { VirtualTerminal } from '../../../../packages/pi-tui/test/virtual-terminal';

const WIDTH = 120;
const HEIGHT = 30;

function fakeInitialAppState(): AppState {
  return {
    model: 'test-model',
    workDir: '/tmp/kimi-test',
    additionalDirs: [],
    sessionId: 'sess-1',
    permissionMode: 'manual',
    planMode: false,
    inputMode: 'prompt',
    swarmMode: false,
    thinkingEffort: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    isCompacting: false,
    isReplaying: false,
    cacheReadTokens: 0,
    cacheMissTokens: 0,
    cacheOtherTokens: 0,
    tokenSpeed: 0,
    sessionStats: createEmptySessionStats(),
    outputTokens: 0,
    locale: 'en',
    streamingPhase: 'idle',
    streamingStartTime: 0,
    stepRetry: null,
    theme: 'dark',
    version: '0.0.0-test',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    upgrade: { autoInstall: true },
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
    mcpServersSummary: null,
  };
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replaceAll(/\u001B\[[0-9;?]*[a-zA-Z]|\u001B\][^\u0007]*\u0007/g, '');
}

async function mountMainScreen(): Promise<{
  state: ReturnType<typeof createTUIState>;
  vt: VirtualTerminal;
}> {
  const opts: KimiTUIOptions = {
    initialAppState: fakeInitialAppState(),
    startup: { continueLast: false, yolo: false, auto: false, plan: false },
  };
  const state = createTUIState(opts);
  const vt = new VirtualTerminal(WIDTH, HEIGHT);
  (state.ui as { terminal: Terminal }).terminal = vt;
  // Mirror KimiTUI.buildLayout for the main-screen (non-fullscreen) mode.
  state.ui.clear();
  state.ui.addChild(state.transcriptContainer);
  state.ui.addChild(state.activityContainer);
  state.ui.addChild(state.todoPanelContainer);
  state.ui.addChild(state.workflowPanelContainer);
  state.ui.addChild(state.queueContainer);
  state.ui.addChild(state.btwPanelContainer);
  state.ui.addChild(state.editorContainer);
  state.editorContainer.addChild(state.editor);
  state.ui.start();
  await vt.waitForRender();
  return { state, vt };
}

function click(vt: VirtualTerminal, x: number, y: number): void {
  // SGR mouse: press + release on the same 1-based cell.
  vt.sendInput(`\x1b[<0;${x + 1};${y + 1}M`);
  vt.sendInput(`\x1b[<0;${x + 1};${y + 1}m`);
}

describe('TUI mouse click integration', () => {
  it('routes clicks to transcript components after a model dialog opens and closes', async () => {
    const { state, vt } = await mountMainScreen();

    // A Bash tool call with 5 output lines: collapsed shows 3, expanded shows 5.
    const toolCall = new ToolCallComponent(
      { id: 'call_bash', name: 'Bash', args: { command: 'printf output' } },
      {
        tool_call_id: 'call_bash',
        output: ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n'),
        is_error: false,
      },
    );
    state.transcriptContainer.addChild(toolCall);
    state.ui.requestRender(true);
    await vt.waitForRender();

    const headerRow = (): number => {
      const rows = vt.getViewport().map((l) => stripAnsi(l));
      // The header renders the i18n verb ("Ran a command") with the tool name;
      // match on the command verb which is stable in the test env.
      return rows.findIndex((l) => l.includes('Ran a command') || l.includes('command'));
    };

    // Click the tool call header (gutter 2 → column 2+; click anywhere on the row).
    const row = headerRow();
    expect(row).toBeGreaterThanOrEqual(0);
    click(vt, 3, row);
    state.ui.requestRender(true);
    await vt.waitForRender();
    expect(
      vt.getViewport().some((l) => stripAnsi(l).includes('line4')),
      'tool call should expand after the first click',
    ).toBe(true);

    // Open a model dialog (replaces the editor), then close it.
    const dialog = new ModelSelectorComponent({
      models: {
        'test-model': {
          provider: 'managed:kimi-code',
          model: 'test-model',
          maxContextSize: 200_000,
          displayName: 'Test Model',
        } as never,
      },
      currentValue: 'test-model',
      currentThinkingEffort: 'on',
      onSelect: () => {},
      onCancel: () => {},
    });
    state.editorContainer.clear();
    state.editorContainer.addChild(dialog);
    state.ui.requestRender(true);
    await vt.waitForRender();

    state.editorContainer.clear();
    state.editorContainer.addChild(state.editor);
    state.ui.requestRender(true);
    await vt.waitForRender();

    // Click the tool call header again — must still toggle (collapse).
    const rowAfter = headerRow();
    expect(rowAfter).toBeGreaterThanOrEqual(0);
    click(vt, 3, rowAfter);
    state.ui.requestRender(true);
    await vt.waitForRender();
    expect(
      vt.getViewport().some((l) => stripAnsi(l).includes('line4')),
      'tool call should collapse after clicking again post-dialog',
    ).toBe(false);
  });
});
