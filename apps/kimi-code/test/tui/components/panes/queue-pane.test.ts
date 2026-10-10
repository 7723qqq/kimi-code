import { describe, expect, it } from 'vitest';

import { QueuePaneComponent } from '#/tui/components/panes/queue-pane';

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('QueuePaneComponent', () => {
  it('renders queued messages with the steer hint', () => {
    const component = new QueuePaneComponent({
      isCompacting: false,
      isStreaming: true,
      canSteerImmediately: true,
      messages: [{ text: 'first message' }, { text: '/skill:review src/app.ts' }],
    });

    const output = stripAnsi(component.render(120).join('\n'));

    expect(output).toContain('❯ first message');
    expect(output).toContain('❯ /skill:review src/app.ts');
    expect(output).toContain('ctrl-s to steer immediately');
  });

  it('caps a deep queue and keeps the newest messages visible', () => {
    // A queue grows while the user keeps typing; without a ceiling the pane
    // pushed the editor off screen on a short terminal.
    const messages = Array.from({ length: 30 }, (_, i) => ({ text: `queued ${String(i + 1)}` }));
    const component = new QueuePaneComponent({
      isCompacting: false,
      isStreaming: true,
      canSteerImmediately: true,
      messages,
      terminalRows: () => 24,
    });

    const output = stripAnsi(component.render(120).join('\n'));

    expect(output).toContain('queued 30');
    expect(output).not.toContain('queued 1 ');
    expect(output).toContain('earlier queued message(s) hidden');
  });

  it('shrinks to the terminal on a short screen', () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({ text: `queued ${String(i + 1)}` }));
    const component = new QueuePaneComponent({
      isCompacting: false,
      isStreaming: true,
      canSteerImmediately: true,
      messages,
      terminalRows: () => 6,
    });

    // 6 rows => a 3-row total budget; the pane must fit inside it.
    expect(component.render(120).length).toBeLessThanOrEqual(3);
    expect(stripAnsi(component.render(120).join('\n'))).toContain('queued 30');
  });

  it('renders every message when the queue fits the budget', () => {
    const component = new QueuePaneComponent({
      isCompacting: false,
      isStreaming: true,
      canSteerImmediately: true,
      messages: [{ text: 'one' }, { text: 'two' }],
      terminalRows: () => 24,
    });

    const output = stripAnsi(component.render(120).join('\n'));

    expect(output).toContain('one');
    expect(output).toContain('two');
    expect(output).not.toContain('hidden');
  });

  it('renders compaction hint when waiting for compaction', () => {
    const component = new QueuePaneComponent({
      isCompacting: true,
      isStreaming: false,
      canSteerImmediately: true,
      messages: [{ text: 'after compact' }],
    });

    const output = stripAnsi(component.render(120).join('\n'));

    expect(output).toContain('will send after compaction');
  });

  it('omits the steer hint when immediate steering is disabled', () => {
    const component = new QueuePaneComponent({
      isCompacting: false,
      isStreaming: true,
      canSteerImmediately: false,
      messages: [{ text: 'after init' }],
    });

    const output = stripAnsi(component.render(120).join('\n'));

    expect(output).toContain('will send after current task');
    expect(output).not.toContain('ctrl-s to steer immediately');
  });

  it('truncates long messages to a single line', () => {
    const longText = 'a'.repeat(200);
    const component = new QueuePaneComponent({
      isCompacting: false,
      isStreaming: true,
      canSteerImmediately: true,
      messages: [{ text: longText }],
    });

    const lines = component.render(30);
    expect(lines).toHaveLength(3); // border + message + hint
    const messageLine = stripAnsi(lines[1] as string);
    expect(messageLine).not.toContain('a'.repeat(30));
    expect(messageLine.endsWith('…')).toBe(true);
  });

  it('collapses multiline text into a single line', () => {
    const component = new QueuePaneComponent({
      isCompacting: false,
      isStreaming: true,
      canSteerImmediately: true,
      messages: [{ text: 'line one\nline two\nline three' }],
    });

    const lines = component.render(120);
    expect(lines).toHaveLength(3); // border + message + hint
    const messageLine = stripAnsi(lines[1] as string);
    expect(messageLine).toContain('line one line two line three');
    expect(messageLine).not.toContain('\n');
  });

  it('renders bash queued items with a $ prompt to distinguish them from text', () => {
    const component = new QueuePaneComponent({
      isCompacting: false,
      isStreaming: true,
      canSteerImmediately: false,
      messages: [{ text: 'ls -la', mode: 'bash' }],
    });

    const output = stripAnsi(component.render(120).join('\n'));
    expect(output).toContain('❯ $ ls -la');
  });

  it('omits the steer hint when every queued item is a bash command', () => {
    const component = new QueuePaneComponent({
      isCompacting: false,
      isStreaming: true,
      canSteerImmediately: true,
      messages: [{ text: 'ls', mode: 'bash' }],
    });

    const output = stripAnsi(component.render(120).join('\n'));
    expect(output).not.toContain('ctrl-s to steer immediately');
    expect(output).toContain('will send after current task');
  });

  it('keeps the steer hint when at least one queued item is steerable', () => {
    const component = new QueuePaneComponent({
      isCompacting: false,
      isStreaming: true,
      canSteerImmediately: true,
      messages: [{ text: 'ls', mode: 'bash' }, { text: 'focus on tests' }],
    });

    const output = stripAnsi(component.render(120).join('\n'));
    expect(output).toContain('ctrl-s to steer immediately');
  });
});
