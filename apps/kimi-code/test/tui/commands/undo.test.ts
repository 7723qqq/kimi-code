import { describe, expect, it, mock, type Mock } from 'bun:test';

import { handleUndoCommand } from '#/tui/commands/undo';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import type { TranscriptEntry } from '#/tui/types';

function entry(partial: Partial<TranscriptEntry> & Pick<TranscriptEntry, 'kind' | 'content'>): TranscriptEntry {
  return {
    id: `t-${Math.random().toString(36).slice(2, 10)}`,
    turnId: undefined,
    renderMode: 'plain',
    ...partial,
  };
}

function hostWith(entries: TranscriptEntry[]): SlashCommandHost {
  return {
    session: { undoHistory: mock(async () => {}) },
    state: {
      transcriptEntries: entries,
      transcriptContainer: { children: [], addChild: mock() },
      ui: { requestRender: mock() },
      appState: { streamingPhase: 'idle' },
    },
    showError: mock(),
  } as unknown as SlashCommandHost;
}

describe('/undo with bundled prompts', () => {
  it('removes the bundle cards with their prompt, keeping a standalone skill card before them', async () => {
    const entries: TranscriptEntry[] = [
      entry({ kind: 'user', content: 'earlier question' }),
      entry({
        kind: 'skill_activation',
        content: 'Activated skill: review',
        skillTrigger: 'user-slash',
      }),
      entry({ kind: 'user', content: 'prompt one' }),
      entry({ kind: 'assistant', content: 'answer one' }),
      entry({
        kind: 'skill_activation',
        content: 'Activated skill: security',
        skillTrigger: 'user-slash',
        bundledWithPrompt: true,
      }),
      entry({ kind: 'user', content: 'prompt two' }),
      entry({ kind: 'assistant', content: 'answer two' }),
    ];
    const host = hostWith(entries);

    await handleUndoCommand(host, '1');

    expect(host.session?.undoHistory).toHaveBeenCalledWith(1);
    expect(entries.map((item) => item.content)).toEqual([
      'earlier question',
      'Activated skill: review',
      'prompt one',
      'answer one',
    ]);
  });

  it('removes bundle cards around an interleaved hook result and keeps the hook result', async () => {
    const entries: TranscriptEntry[] = [
      entry({
        kind: 'skill_activation',
        content: 'Activated skill: review',
        skillTrigger: 'user-slash',
        bundledWithPrompt: true,
      }),
      entry({ kind: 'assistant', content: 'hook note', hookResult: true }),
      entry({ kind: 'user', content: 'bundled prompt' }),
      entry({ kind: 'assistant', content: 'bundled answer' }),
    ];
    const host = hostWith(entries);

    await handleUndoCommand(host, '1');

    expect(host.session?.undoHistory).toHaveBeenCalledWith(1);
    expect(entries.map((item) => item.content)).toEqual(['hook note']);
  });

  it('does not count bundle cards as undo anchors of their own', async () => {
    const entries: TranscriptEntry[] = [
      entry({ kind: 'user', content: 'prompt one' }),
      entry({ kind: 'assistant', content: 'answer one' }),
      entry({
        kind: 'skill_activation',
        content: 'Activated skill: review',
        skillTrigger: 'user-slash',
        bundledWithPrompt: true,
      }),
      entry({ kind: 'user', content: 'prompt two' }),
      entry({ kind: 'assistant', content: 'answer two' }),
    ];
    const host = hostWith(entries);

    await handleUndoCommand(host, '2');

    expect(host.session?.undoHistory).toHaveBeenCalledWith(2);
    expect(entries).toHaveLength(0);
  });
});

describe('/undo todo panel refresh', () => {
  function hostWithTodos(
    entries: TranscriptEntry[],
    session: Record<string, unknown>,
  ): { host: SlashCommandHost; setTodoList: Mock<(...args: any[]) => any> } {
    const host = hostWith(entries);
    const setTodoList = mock();
    (host as { streamingUI?: unknown }).streamingUI = { setTodoList };
    (host as { session?: unknown }).session = session;
    return { host, setTodoList };
  }

  it('does not poll the engine for todos after a successful undo', async () => {
    const entries: TranscriptEntry[] = [
      entry({ kind: 'user', content: 'question' }),
      entry({ kind: 'assistant', content: 'answer' }),
    ];
    const getTodos = mock(async () => [{ title: 'kept', status: 'pending' }]);
    const { host, setTodoList } = hostWithTodos(entries, {
      undoHistory: mock(async () => {}),
      getTodos,
    });

    await handleUndoCommand(host, '1');

    // The engine publishes `todo.updated` from its durable commit callback, so
    // undo — which restores state without going through the write methods —
    // still reaches the panel. A pull here would be a second, redundant path
    // that only the TUI would have.
    expect(getTodos).not.toHaveBeenCalled();
    expect(setTodoList).not.toHaveBeenCalled();
  });

  it('keeps the panel as-is when the engine has no todo read surface', async () => {
    const entries: TranscriptEntry[] = [
      entry({ kind: 'user', content: 'question' }),
      entry({ kind: 'assistant', content: 'answer' }),
    ];
    const { host, setTodoList } = hostWithTodos(entries, {
      undoHistory: mock(async () => {}),
      getTodos: mock(async () => {
        throw new Error('getTodos is only available on the agent-core-v2 engine.');
      }),
    });

    await handleUndoCommand(host, '1');

    expect(setTodoList).not.toHaveBeenCalled();
  });

  it('hides the panel when the restored todos are all done', async () => {
    const entries: TranscriptEntry[] = [
      entry({ kind: 'user', content: 'question' }),
      entry({ kind: 'assistant', content: 'answer' }),
    ];
    const { host, setTodoList } = hostWithTodos(entries, {
      undoHistory: mock(async () => {}),
      getTodos: mock(async () => [{ title: 'finished', status: 'done' }]),
    });

    await handleUndoCommand(host, '1');

    // All-done suppression lives on the event path now; the undo command
    // itself only cuts the conversation.
    expect(setTodoList).not.toHaveBeenCalled();
  });
});
