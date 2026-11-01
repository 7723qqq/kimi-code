import { describe, expect, it, mock } from 'bun:test';

import type { Event } from '@moonshot-ai/kimi-code-sdk';
import { Container } from '@moonshot-ai/pi-tui';

import { PromptOptimizerActivityController } from '#/tui/controllers/prompt-optimizer-activity';
import { createFakeClock } from '#test/helpers/fake-clock';

void mock.module('#/i18n', () => ({
  t: (key: string, params?: Record<string, string | number>): string => {
    const translations: Record<string, string> = {
      'tui.messages.promptOptimizePhases.starting': 'rewriting prompt…',
      'tui.messages.promptOptimizePhases.thinking': 'reading your draft…',
      'tui.messages.promptOptimizePhases.tool': 'checking {{tool}}…',
      'tui.messages.promptOptimizePhases.writing': 'writing the rewrite…',
      'tui.messages.promptOptimizePhases.hintCollapsed': 'ctrl+o for steps',
      'tui.messages.promptOptimizePhases.hintExpanded': 'ctrl+o to collapse',
    };
    const msg = translations[key] ?? key;
    if (params === undefined) return msg;
    let result = msg;
    for (const [k, v] of Object.entries(params)) {
      result = result.replaceAll(`{{${k}}}`, String(v));
    }
    return result;
  },
}));

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function makeHarness() {
  const activityContainer = new Container();
  const requestRender = mock();
  const host = {
    state: {
      ui: { requestRender },
      activityContainer,
      renderClock: createFakeClock(0),
    },
  };
  const controller = new PromptOptimizerActivityController(host as never);
  const rows = (): readonly string[] => activityContainer.render(80).map((line) => strip(line));
  return { controller, activityContainer, rows, requestRender };
}

function event(type: string, rest: Record<string, unknown> = {}): Event {
  return { type, agentId: 'agent-opt', sessionId: 's1', ...rest } as unknown as Event;
}

describe('PromptOptimizerActivityController', () => {
  it('mounts exactly one row and starts at the generic phase', () => {
    const h = makeHarness();
    expect(h.controller.active).toBe(false);

    h.controller.begin();

    expect(h.controller.active).toBe(true);
    expect(h.activityContainer.children).toHaveLength(1);
    expect(h.rows().join('\n')).toContain('rewriting prompt…');
  });

  it('is idempotent, so a second begin does not stack rows', () => {
    const h = makeHarness();
    h.controller.begin();
    h.controller.begin();

    expect(h.activityContainer.children).toHaveLength(1);
  });

  it('shows which tool is running and what it is looking at', () => {
    const h = makeHarness();
    h.controller.begin();

    h.controller.applyEvent(
      event('tool.call.started', { name: 'Read', args: { path: 'src/app.ts' }, toolCallId: 'c1' }),
    );

    const text = h.rows().join('\n');
    expect(text).toContain('checking Read src/app.ts…');
  });

  it('names the search pattern for a Grep call', () => {
    const h = makeHarness();
    h.controller.begin();

    h.controller.applyEvent(
      event('tool.call.started', {
        name: 'Grep',
        args: { pattern: 'optimize(' },
        toolCallId: 'c1',
      }),
    );

    expect(h.rows().join('\n')).toContain('checking Grep optimize(…');
  });

  it('falls back to the bare tool name when the call carries nothing to show', () => {
    const h = makeHarness();
    h.controller.begin();

    h.controller.applyEvent(
      event('tool.call.started', { name: 'Glob', args: {}, toolCallId: 'c1' }),
    );

    expect(h.rows().join('\n')).toContain('checking Glob…');
  });

  it('returns to thinking once the tool resolves', () => {
    const h = makeHarness();
    h.controller.begin();
    h.controller.applyEvent(
      event('tool.call.started', { name: 'Read', args: { path: 'a.ts' }, toolCallId: 'c1' }),
    );

    h.controller.applyEvent(event('tool.result', { toolCallId: 'c1' }));

    expect(h.rows().join('\n')).toContain('reading your draft…');
  });

  it('reports thinking on a step start and writing on assistant text', () => {
    const h = makeHarness();
    h.controller.begin();

    h.controller.applyEvent(event('turn.step.started', { turnId: 1, step: 0 }));
    expect(h.rows().join('\n')).toContain('reading your draft…');

    h.controller.applyEvent(event('assistant.delta', { delta: 'Hi' }));
    expect(h.rows().join('\n')).toContain('writing the rewrite…');
  });

  it('ignores events it does not map instead of blanking the row', () => {
    const h = makeHarness();
    h.controller.begin();
    h.controller.applyEvent(
      event('tool.call.started', { name: 'Read', args: { path: 'a.ts' }, toolCallId: 'c1' }),
    );

    h.controller.applyEvent(event('tool.progress', { toolCallId: 'c1' }));

    expect(h.rows().join('\n')).toContain('checking Read a.ts…');
  });

  it('truncates to the terminal width instead of wrapping into a second row', () => {
    const h = makeHarness();
    h.controller.begin();
    h.controller.applyEvent(
      event('tool.call.started', {
        name: 'Read',
        args: { path: 'a/very/long/path/that/keeps/going/and/going.ts' },
        toolCallId: 'c1',
      }),
    );

    const narrow = h.activityContainer.render(24);
    expect(narrow).toHaveLength(1);
    expect(strip(narrow[0] ?? '').length).toBeLessThanOrEqual(24);
  });

  it('removes the row and reports the change', () => {
    const h = makeHarness();
    h.controller.begin();
    h.requestRender.mockClear();

    h.controller.clear();

    expect(h.controller.active).toBe(false);
    expect(h.activityContainer.children).toHaveLength(0);
    expect(h.rows()).toEqual([]);
    expect(h.requestRender).toHaveBeenCalled();
  });

  it('is safe to clear twice and to feed events after clearing', () => {
    const h = makeHarness();
    h.controller.begin();
    h.controller.clear();

    h.controller.clear();
    h.controller.applyEvent(event('turn.step.started', { turnId: 1, step: 0 }));

    expect(h.activityContainer.children).toHaveLength(0);
  });

  it('leaves a pre-existing activity child untouched', () => {
    const h = makeHarness();
    const mainSpinnerRow = { render: () => ['main agent working'], invalidate: () => {} };
    h.activityContainer.addChild(mainSpinnerRow as never);

    h.controller.begin();
    h.controller.clear();

    expect(h.activityContainer.children).toHaveLength(1);
    expect(h.rows()).toEqual(['main agent working']);
  });

  it('re-attaches the row after the activity pane rebuilds the container', () => {
    const h = makeHarness();
    h.controller.begin();
    h.activityContainer.clear();

    h.controller.applyEvent(
      event('tool.call.started', { name: 'Read', args: { path: 'a.ts' }, toolCallId: 'c1' }),
    );

    expect(h.activityContainer.children).toHaveLength(1);
    expect(h.rows().join('\n')).toContain('checking Read a.ts…');
  });

  it('never mounts the row twice when the container still holds it', () => {
    const h = makeHarness();
    h.controller.begin();

    h.controller.applyEvent(event('turn.step.started', { turnId: 1, step: 0 }));
    h.controller.applyEvent(event('assistant.delta', { delta: 'x' }));

    expect(h.activityContainer.children).toHaveLength(1);
  });

  it('stays one row until it is expanded, then lists the recent steps', () => {
    const h = makeHarness();
    h.controller.begin();
    h.controller.applyEvent(
      event('tool.call.started', { name: 'Read', args: { path: 'a.ts' }, toolCallId: 'c1' }),
    );
    h.controller.applyEvent(event('tool.result', { toolCallId: 'c1' }));
    h.controller.applyEvent(event('assistant.delta', { delta: 'x' }));

    expect(h.rows()).toHaveLength(1);
    expect(h.rows()[0]).toContain('ctrl+o for steps');

    expect(h.controller.expanded).toBe(false);
    expect(h.controller.toggleExpanded()).toBe(true);

    const expanded = h.rows();
    expect(expanded.length).toBeGreaterThan(1);
    expect(expanded.join('\n')).toContain('checking Read a.ts…');
    expect(expanded.join('\n')).toContain('ctrl+o to collapse');
  });

  it('reports nothing to toggle when no rewrite is running', () => {
    const h = makeHarness();
    expect(h.controller.toggleExpanded()).toBe(false);
    expect(h.controller.expanded).toBe(false);
  });

  it('keeps the step list bounded so a long rewrite stays a few rows', () => {
    const h = makeHarness();
    h.controller.begin();
    for (let i = 0; i < 12; i++) {
      h.controller.applyEvent(
        event('tool.call.started', {
          name: 'Read',
          args: { path: `f${i}.ts` },
          toolCallId: `c${i}`,
        }),
      );
    }
    h.controller.toggleExpanded();

    expect(h.rows().length).toBeLessThanOrEqual(4);
  });

  it('survives the activity pane removing only its own children', () => {
    const h = makeHarness();
    // A sibling the activity pane owns, next to the optimizer row in the same
    // shared container.
    const mainPaneRow = { render: () => ['main agent working'], invalidate: () => {} };
    h.activityContainer.addChild(mainPaneRow as never);
    h.controller.begin();

    h.controller.applyEvent(
      event('tool.call.started', { name: 'Read', args: { path: 'a.ts' }, toolCallId: 'c1' }),
    );

    // Both survive: the pane rebuild drops the pane's own row only, and the
    // optimizer's row is still mounted beside it.
    expect(h.activityContainer.children).toHaveLength(2);
    expect(h.rows().join('\n')).toContain('checking Read a.ts…');
  });
});
