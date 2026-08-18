import { Container } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { GoalMarkerComponent } from '#/tui/components/messages/goal-markers';
import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { UserMessageComponent } from '#/tui/components/messages/user-message';
import {
  TranscriptNavigationController,
  type TranscriptNavHost,
} from '#/tui/controllers/transcript-navigation';

vi.mock('#/i18n', () => ({
  t: (key: string) => key,
  setLocale: vi.fn(),
  getLocale: () => 'en',
}));

interface Harness {
  readonly host: TranscriptNavHost;
  readonly requestRender: ReturnType<typeof vi.fn>;
}

function createHarness(): Harness {
  const requestRender = vi.fn();
  const host: TranscriptNavHost = {
    state: {
      transcriptContainer: new Container(),
      scrollView: undefined,
      terminal: { columns: 120 } as never,
      ui: { requestRender } as never,
    },
  };
  return { host, requestRender };
}

function makeToolCall(id = 't1'): ToolCallComponent {
  return new ToolCallComponent({ id, name: 'Bash', args: {} }, undefined);
}

function stripAnsi(text: string): string {
  return text.replaceAll(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

describe('TranscriptNavigationController', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('activates and highlights the first navigable item', () => {
    const { host, requestRender } = createHarness();
    const tc = makeToolCall();
    host.state.transcriptContainer.addChild(tc);
    const nav = new TranscriptNavigationController(host);

    nav.toggle();

    expect(nav.isActive()).toBe(true);
    expect(requestRender).toHaveBeenCalled();
    // The focused header carries the accent background.
    const header = tc.render(100).find((l) => stripAnsi(l).includes('runningCommand'));
    expect(header).toBeDefined();
  });

  it('moves focus with j/k and wraps around', () => {
    const { host } = createHarness();
    const tc1 = makeToolCall('t1');
    const tc2 = makeToolCall('t2');
    const thinking = new ThinkingComponent('deep thought', true, 'finalized');
    host.state.transcriptContainer.addChild(tc1);
    host.state.transcriptContainer.addChild(tc2);
    host.state.transcriptContainer.addChild(thinking);
    const nav = new TranscriptNavigationController(host);
    nav.activate();

    // j moves to the second item.
    nav.handleKey('j');
    // k moves back to the first.
    nav.handleKey('k');
    // j twice wraps around to the third item (index 2).
    nav.handleKey('j');
    nav.handleKey('j');
    // k wraps back to the second item (index 1).
    nav.handleKey('k');

    // Enter toggles expansion of the focused item (tc2).
    nav.handleKey('\r');
    expect(tc2.isExpanded()).toBe(true);
    nav.handleKey('\r');
    expect(tc2.isExpanded()).toBe(false);
  });

  it('supports arrow keys and exits on Escape', () => {
    const { host } = createHarness();
    const tc1 = makeToolCall('t1');
    const tc2 = makeToolCall('t2');
    host.state.transcriptContainer.addChild(tc1);
    host.state.transcriptContainer.addChild(tc2);
    const nav = new TranscriptNavigationController(host);
    nav.activate();

    nav.handleKey('\x1b[B'); // ArrowDown
    nav.handleKey('\x1b[A'); // ArrowUp
    nav.handleKey('\x1b'); // Escape
    expect(nav.isActive()).toBe(false);
  });

  it('does not activate when there are no navigable items', () => {
    const { host } = createHarness();
    const nav = new TranscriptNavigationController(host);
    nav.toggle();
    expect(nav.isActive()).toBe(false);
  });

  it('clears the highlight when deactivated', () => {
    const { host } = createHarness();
    const tc = makeToolCall();
    host.state.transcriptContainer.addChild(tc);
    const nav = new TranscriptNavigationController(host);
    nav.activate();
    nav.deactivate();
    expect(nav.isActive()).toBe(false);
  });

  it('consumes keys only while active', () => {
    const { host } = createHarness();
    const tc = makeToolCall();
    host.state.transcriptContainer.addChild(tc);
    const nav = new TranscriptNavigationController(host);

    // Inactive: keys are not consumed.
    expect(nav.handleKey('j')).toBe(false);
    expect(nav.handleKey('\x1b')).toBe(false);

    nav.activate();
    expect(nav.handleKey('j')).toBe(true);
    expect(nav.handleKey('\x1b')).toBe(true);
  });

  it('navigates plain user/assistant messages too', () => {
    const { host } = createHarness();
    const user = new UserMessageComponent('hello');
    const assistant = new AssistantMessageComponent();
    assistant.updateContent('world');
    const tc = makeToolCall('t1');
    host.state.transcriptContainer.addChild(user);
    host.state.transcriptContainer.addChild(assistant);
    host.state.transcriptContainer.addChild(tc);
    const nav = new TranscriptNavigationController(host);
    nav.activate();

    // Enter on a plain user message is a no-op.
    nav.handleKey('\r');
    expect(tc.isExpanded()).toBe(false);
    // Enter on a plain assistant message is a no-op too.
    nav.handleKey('j');
    nav.handleKey('\r');
    expect(tc.isExpanded()).toBe(false);
    // Enter on the tool call expands it.
    nav.handleKey('j');
    nav.handleKey('\r');
    expect(tc.isExpanded()).toBe(true);
  });

  it('highlights the focused header with an accent background', () => {
    const previousChalkLevel = chalk.level;
    chalk.level = 3;
    try {
      const { host } = createHarness();
      const tc1 = makeToolCall('t1');
      const tc2 = makeToolCall('t2');
      host.state.transcriptContainer.addChild(tc1);
      host.state.transcriptContainer.addChild(tc2);
      const nav = new TranscriptNavigationController(host);
      nav.activate();

      const firstHeader = tc1.render(100).find((l) => stripAnsi(l).includes('runningCommand')) ?? '';
      expect(firstHeader).toMatch(/\u001B\[48/);

      nav.handleKey('j');
      const secondHeader = tc2.render(100).find((l) => stripAnsi(l).includes('runningCommand')) ?? '';
      expect(secondHeader).toMatch(/\u001B\[48/);
      const firstAfter = tc1.render(100).find((l) => stripAnsi(l).includes('runningCommand')) ?? '';
      expect(firstAfter).not.toMatch(/\u001B\[48/);
    } finally {
      chalk.level = previousChalkLevel;
    }
  });
});
