import { afterEach, describe, expect, it, mock } from 'bun:test';

import type { Component, TuiMouseDispatchResult, TuiMouseEvent } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { ReadGroupComponent } from '#/tui/components/messages/read-group';
import { SkillActivationComponent } from '#/tui/components/messages/skill-activation';
import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { TranscriptContainer } from '#/tui/components/messages/transcript-container';
import { TranscriptGroupComponent } from '#/tui/components/messages/transcript-group';
import { UserMessageComponent } from '#/tui/components/messages/user-message';
import type { TranscriptPresentationOptions } from '#/tui/config';
import { currentTheme } from '#/tui/theme';
import type { ToolResultBlockData, TranscriptEntry } from '#/tui/types';
import { markTranscriptComponent } from '#/tui/utils/transcript-component-metadata';

let id = 0;
const defaultChalkLevel = chalk.level;

function options(overrides: Partial<TranscriptPresentationOptions> = {}): TranscriptPresentationOptions {
  return {
    fullscreen: true,
    groupTools: 'explore',
    groupThinking: true,
    ...overrides,
  };
}

function result(toolName: string, output = 'first\nsecond'): ToolResultBlockData {
  return { tool_call_id: `call-${++id}`, output, is_error: false };
}

function tool(
  name: string,
  args: Record<string, unknown> = {},
  toolResult: ToolResultBlockData | undefined = result(name),
): ToolCallComponent {
  const callId = toolResult?.tool_call_id ?? `call-${++id}`;
  return new ToolCallComponent(
    { id: callId, name, args },
    toolResult === undefined
      ? undefined
      : { ...toolResult, tool_call_id: callId },
    undefined,
    '/work',
  );
}

function runningTool(name: string, args: Record<string, unknown> = {}): ToolCallComponent {
  const callId = `call-${++id}`;
  return new ToolCallComponent({ id: callId, name, args }, undefined, undefined, '/work');
}

function thought(ms = 3000): ThinkingComponent {
  const component = new ThinkingComponent('reasoning', true, 'finalized');
  component.finalize({ known: true, ms });
  return component;
}

function liveThought(): ThinkingComponent {
  return new ThinkingComponent(['still reasoning', 'more', 'more', 'more', 'more'].join('\n'), true, 'live');
}

function user(text: string): UserMessageComponent {
  const component = new UserMessageComponent(text);
  const entry: TranscriptEntry = {
    id: `entry-${++id}`,
    kind: 'user',
    content: text,
    renderMode: 'markdown',
  };
  markTranscriptComponent(component, entry);
  return component;
}

interface FrameDriver {
  runFrame(time: number): void;
  pendingFrames(): number;
}

function makeContainer(presentation = options()): {
  container: TranscriptContainer;
  requestRender: ReturnType<typeof mock>;
  frames: FrameDriver;
} {
  const requestRender = mock();
  const queue = new Map<number, (time: number) => void>();
  let nextHandle = 1;
  const container = new TranscriptContainer(0, 0, {
    requestRender,
    requestAnimationFrame: (callback: (time: number) => void): number => {
      const handle = nextHandle++;
      queue.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame: (handle: number): void => {
      queue.delete(handle);
    },
  });
  container.setPresentationOptions(presentation);
  container.setHost({
    withScrollAnchor: (toggle) => {
      toggle();
    },
    withBottomAnchor: (toggle) => {
      toggle();
    },
    viewportRows: () => undefined,
    track: () => {},
    foldingChanged: () => {},
  });
  return {
    container,
    requestRender,
    frames: {
      runFrame: (time: number): void => {
        const pending = [...queue.values()];
        queue.clear();
        for (const callback of pending) callback(time);
      },
      pendingFrames: (): number => queue.size,
    },
  };
}

function plain(lines: readonly string[]): string {
  return lines.join('\n').replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function groups(container: TranscriptContainer): TranscriptGroupComponent[] {
  container.render(80);
  return (container.getRenderedLayout()?.children ?? [])
    .map((entry) => entry.component)
    .filter((component): component is TranscriptGroupComponent => component instanceof TranscriptGroupComponent);
}

function lineOf(container: TranscriptContainer, text: string): number {
  const index = plain(container.render(80))
    .split('\n')
    .findIndex((line) => line.includes(text));
  if (index < 0) throw new Error(`no line contains ${text}`);
  return index;
}

function click(container: TranscriptContainer, y: number, x = 0): TuiMouseDispatchResult | undefined {
  const rendered = container.render(80);
  const event: TuiMouseEvent = {
    type: 'click',
    button: 'left',
    x,
    y,
    screenX: x,
    screenY: y,
    width: 80,
    height: rendered.length,
    shift: false,
    alt: false,
    ctrl: false,
    clickCount: 1,
  };
  return container.handleMouse(event);
}

afterEach(() => {
  chalk.level = defaultChalkLevel;
  currentTheme.setTerminalBackground(undefined);
});

describe('TranscriptContainer projection', () => {
  it('leaves children untouched outside fullscreen or with grouping off', () => {
    for (const presentation of [options({ fullscreen: false }), options({ groupTools: 'off', groupThinking: false })]) {
      const { container } = makeContainer(presentation);
      const read = tool('Read', { path: 'a.ts' });
      const bash = tool('Bash', { command: 'ls' });
      container.addChild(read);
      container.addChild(bash);

      const text = plain(container.render(80));
      expect(groups(container)).toHaveLength(0);
      expect(text).toContain('Read');
      expect(text).toContain('Ran');
    }
  });

  it('folds consecutive read-only calls and finished thinking into one summary group', () => {
    const { container } = makeContainer();
    container.addChild(thought(3_000));
    container.addChild(tool('Read', { path: 'a.ts' }));
    container.addChild(tool('Grep', { pattern: 'needle' }));
    container.addChild(tool('Bash', { command: 'ls' }));

    const rendered = plain(container.render(80));
    expect(groups(container)).toHaveLength(1);
    expect(rendered).toContain('Thought for 3s');
    expect(rendered).toContain('read 1 file');
    expect(rendered).toContain('searched 1 pattern');
    expect(rendered).toContain('ran 1 command');
    expect(rendered).not.toContain('a.ts');
  });

  it('joins a running tool into the group and shows it on the collapsed tail', () => {
    const { container } = makeContainer();
    container.addChild(tool('Read', { path: 'a.ts' }));
    container.addChild(runningTool('Bash', { command: 'sleep 30' }));
    container.setTurnActive(true);

    const rendered = plain(container.render(80));
    expect(rendered).toContain('running 1 command');
    expect(rendered).toContain('└ $ sleep 30');
    expect(groups(container)).toHaveLength(1);
  });

  it('does not group a run made only of silent calls', () => {
    const { container } = makeContainer();
    container.addChild(tool('select_tools', { tools: [] }, { ...result('select_tools'), output: '' }));

    expect(groups(container)).toHaveLength(0);
  });

  it('keeps subagents, plans and questions as their own cards', () => {
    const { container } = makeContainer();
    container.addChild(tool('Read', { path: 'a.ts' }));
    container.addChild(tool('Agent'));
    container.addChild(tool('ExitPlanMode'));
    container.addChild(tool('AskUserQuestion'));

    expect(groups(container)).toHaveLength(1);
    container.render(80);
    const components = (container.getRenderedLayout()?.children ?? []).map((entry) => entry.component);
    expect(components.filter((component) => component instanceof TranscriptGroupComponent)).toHaveLength(1);
    expect(components.filter((component) => component instanceof ToolCallComponent)).toHaveLength(3);
  });

  it('hides a model-loaded skill card but keeps a user activation as a boundary', () => {
    const { container } = makeContainer();
    const modelSkill = new SkillActivationComponent('loader', undefined, 'model-tool');
    container.addChild(tool('Read', { path: 'a.ts' }));
    container.addChild(modelSkill);
    container.addChild(tool('Read', { path: 'b.ts' }));
    container.render(80);

    expect(groups(container)).toHaveLength(1);

    const { container: second } = makeContainer();
    second.addChild(tool('Read', { path: 'a.ts' }));
    second.addChild(new SkillActivationComponent('user-skill', undefined, 'user-slash'));
    second.addChild(tool('Read', { path: 'b.ts' }));
    second.render(80);
    const rendered = plain(second.render(80));
    expect(rendered).toContain('user-skill');
    expect(groups(second)).toHaveLength(2);
  });

  it('keeps a finishing thought out of the group until it stops', () => {
    const { container } = makeContainer();
    const live = liveThought();
    container.addChild(tool('Read', { path: 'a.ts' }));
    container.addChild(live);
    container.setTurnActive(true);

    expect(groups(container)).toHaveLength(1);
    expect(plain(container.render(80))).toContain('more');
  });
});

describe('TranscriptContainer interaction', () => {
  it('toggles a group from its title and from its collapsed tail', () => {
    const { container } = makeContainer();
    container.addChild(tool('Read', { path: 'a.ts' }));
    container.addChild(tool('Read', { path: 'b.ts' }));
    const y = lineOf(container, 'Read 2 files');

    expect(click(container, y)).toBeDefined();
    const expanded = plain(container.render(80));
    expect(expanded).toContain('├ Read a.ts');
    expect(expanded).toContain('└ Read b.ts');

    expect(click(container, lineOf(container, 'Read 2 files'))).toBeDefined();
    const collapsed = plain(container.render(80));
    expect(collapsed).not.toContain('├ Read a.ts');
  });

  it('opens one item detail in place from a row', () => {
    const { container } = makeContainer();
    container.addChild(tool('Read', { path: 'a.ts' }));
    container.addChild(tool('Read', { path: 'b.ts' }));
    click(container, lineOf(container, 'Read 2 files'));

    expect(click(container, lineOf(container, 'Read a.ts'))).toBeDefined();
    const rendered = plain(container.render(80));
    // The row stays; its detail appears beneath it without repeating the path row.
    expect(rendered).toContain('Read a.ts');
  });

  it('expands recent groups with ctrl+o and collapses them again', () => {
    const { container } = makeContainer();
    container.addChild(tool('Read', { path: 'a.ts' }));
    container.addChild(tool('Read', { path: 'b.ts' }));
    container.render(80);

    expect(container.toolOutputExpandHint()).toBe('expand');
    expect(container.toggleToolOutputExpansion()).toBe(true);
    expect(plain(container.render(80))).toContain('├ Read a.ts');

    expect(container.toggleToolOutputExpansion()).toBe(false);
    expect(plain(container.render(80))).not.toContain('├ Read a.ts');
  });

  it('toggles a node group from a click on any of its lines', () => {
    const { container } = makeContainer(options({ groupTools: 'auto' }));
    container.addChild(tool('Edit', { path: 'a.ts', old_string: 'a', new_string: 'b' }));
    container.addChild(tool('Edit', { path: 'b.ts', old_string: 'a', new_string: 'b' }));
    const y = lineOf(container, 'Edited 2 files');
    expect(click(container, y)).toBeDefined();
    expect(plain(container.render(80))).toContain('└ Edit b.ts');
  });
});

describe('TranscriptContainer turn cutoff', () => {
  it('only expands groups inside the recent-turn window', () => {
    const { container } = makeContainer();
    for (let turn = 0; turn < 5; turn += 1) {
      container.addChild(user(`question ${turn}`));
      container.addChild(tool('Read', { path: `file-${turn}.ts` }));
      container.addChild(tool('Read', { path: `other-${turn}.ts` }));
    }
    container.render(80);
    container.toggleToolOutputExpansion();

    const rendered = plain(container.render(80));
    // The oldest groups stay collapsed; the three most recent turns open.
    expect(rendered).not.toContain('├ Read file-0.ts');
    expect(rendered).toContain('├ Read file-4.ts');
  });

  it('counts a model-loaded skill card as part of its turn', () => {
    const { container } = makeContainer();
    for (let turn = 0; turn < 4; turn += 1) {
      container.addChild(user(`question ${turn}`));
      if (turn === 3) container.addChild(new SkillActivationComponent('x', undefined, 'model-tool'));
      container.addChild(tool('Read', { path: `file-${turn}.ts` }));
    }
    container.render(80);
    container.toggleToolOutputExpansion();

    expect(plain(container.render(80))).toContain('Read file-3.ts');
  });
});

describe('TranscriptContainer measurement', () => {
  it('reports the rendered viewport layout through the gutter', () => {
    const { container } = makeContainer();
    container.addChild(tool('Read', { path: 'a.ts' }));
    container.render(60);
    const layout = container.getRenderedLayout();
    expect(layout).toBeDefined();
    expect(layout!.contentWidth).toBe(60);
    expect(layout!.children[0]?.component).toBeInstanceOf(TranscriptGroupComponent);
  });

  it('renders regular-mode children as the components themselves', () => {
    const { container } = makeContainer(options({ fullscreen: false }));
    const component: Component = tool('Read', { path: 'a.ts' });
    container.addChild(component);
    container.render(80);
    expect(container.getRenderedLayout()?.children[0]?.component).toBe(component);
  });
});
