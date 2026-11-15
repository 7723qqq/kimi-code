import { describe, expect, it, mock } from 'bun:test';

import { visibleWidth, type TUI, type TuiMouseEvent } from '@moonshot-ai/pi-tui';

import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { STATUS_BULLET } from '#/tui/constant/symbols';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function fakeUi(): {
  requestRender: ReturnType<typeof mock>;
  runFrame(time: number): void;
  pendingFrames(): number;
} & TUI {
  const queue = new Map<number, (time: number) => void>();
  let nextHandle = 1;
  const requestRender = mock();
  const ui = {
    requestRender,
    requestAnimationFrame: (callback: (time: number) => void): number => {
      const handle = nextHandle++;
      queue.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame: (handle: number): void => {
      queue.delete(handle);
    },
    runFrame: (time: number): void => {
      const pending = [...queue.values()];
      queue.clear();
      for (const callback of pending) callback(time);
    },
    pendingFrames: (): number => queue.size,
  };
  return ui as unknown as typeof ui & TUI;
}

const longThinking = ['line1', 'line2', 'line3', 'line4', 'line5', 'line6', 'line7'].join('\n');

describe('ThinkingComponent', () => {
  it('shows a highlighted live title before thinking content', () => {
    const component = new ThinkingComponent('working it out', true, 'live');
    const out = strip(component.render(80).join('\n'));

    expect(out).toContain(`${STATUS_BULLET.trimEnd()} Thinking`);
    expect(out).not.toContain('thinking…');
    expect(out).not.toContain(`${STATUS_BULLET}⠋`);
    expect(out).toContain('  working it out');
  });

  it('routes a click on the live header through its toggle button', () => {
    const component = new ThinkingComponent('working it out', true, 'live');
    const toggle = mock();
    component.setToggleHandler(toggle);
    component.render(80);

    expect(
      component.handleMouse({
        type: 'click',
        button: 'left',
        x: 1,
        y: 1,
        screenX: 1,
        screenY: 1,
        width: 80,
        height: 3,
        shift: false,
        alt: false,
        ctrl: false,
      } as TuiMouseEvent),
    ).toEqual({ handled: true });
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('keeps live thinking height-limited to the tail', () => {
    const component = new ThinkingComponent(longThinking, true, 'live');
    const out = strip(component.render(80).join('\n'));

    expect(out).not.toContain('line1');
    expect(out).not.toContain('line4');
    expect(out).not.toContain('line5');
    expect(out).toContain('line6');
    expect(out).toContain('line7');
    expect(out).not.toContain('ctrl+o to expand');
  });

  it('reports hidden content while live so a click can reveal the full reasoning', () => {
    const component = new ThinkingComponent(longThinking, true, 'live');
    component.render(80);

    expect(component.hasHiddenContent()).toBe(true);

    component.setExpanded(true);
    const out = strip(component.render(80).join('\n'));
    expect(out).toContain('line1');
    expect(out).toContain('line7');
  });

  it('does not report hidden content while live when the tail is the whole content', () => {
    const component = new ThinkingComponent(['line1', 'line2'].join('\n'), true, 'live');
    component.render(80);

    expect(component.hasHiddenContent()).toBe(false);
  });

  it('expands live thinking when setExpanded(true) is called', () => {
    const component = new ThinkingComponent(longThinking, true, 'live');
    component.setExpanded(true);
    const out = strip(component.render(80).join('\n'));

    expect(out).toContain(`${STATUS_BULLET.trimEnd()} Thinking`);
    expect(out).toContain('line1');
    expect(out).toContain('line2');
    expect(out).toContain('line3');
    expect(out).toContain('line4');
    expect(out).toContain('line5');
    expect(out).toContain('line6');
    expect(out).toContain('line7');
  });

  it('animates the live title on shared frames and stops on finalize', () => {
    const ui = fakeUi();
    const component = new ThinkingComponent('step', true, 'live', ui);

    expect(strip(component.render(80).join('\n'))).toContain(`${STATUS_BULLET.trimEnd()} Thinking`);
    expect(ui.pendingFrames()).toBe(1);
    expect(ui.requestRender).not.toHaveBeenCalled();

    ui.runFrame(120);
    expect(ui.requestRender).toHaveBeenCalled();
    expect(ui.pendingFrames()).toBe(1);

    component.finalize({ known: true, ms: 3_000 });
    expect(ui.pendingFrames()).toBe(0);
    ui.requestRender.mockClear();
    ui.runFrame(240);
    expect(ui.requestRender).not.toHaveBeenCalled();
  });

  it('finalizes in place into a collapsed preview', () => {
    const component = new ThinkingComponent(longThinking, true, 'live');

    component.finalize();

    const out = strip(component.render(80).join('\n'));
    expect(out).toContain('line1');
    expect(out).toContain('line2');
    expect(out).not.toContain('line3');
    expect(out).not.toContain('line4');
    expect(out).toContain('… (5 more lines, ctrl+o to expand)');
  });

  it('keeps every line in place under the given title when an opened thought finishes', () => {
    const component = new ThinkingComponent(`${longThinking}\n\n`, true, 'live');
    component.setExpanded(true);
    const live = component.render(80);
    component.setFinishedForm({ kind: 'opened', title: 'Thought for 5s' });
    expect(component.render(80)).toEqual(live);

    component.finalize({ known: true, ms: 5_000 });
    const finished = component.render(80);
    expect(finished.map((line) => strip(line).trimEnd())).toEqual([
      '',
      '  Thought for 5s',
      '  line1',
      '  line2',
      '  line3',
      '  line4',
      '  line5',
      '  line6',
      '  line7',
    ]);
    expect(finished.slice(2)).toEqual(live.slice(2));
    component.setFinishedForm({ kind: 'opened', title: 'Thought for 5s' });
    expect(component.render(80)).toBe(finished);

    component.setFinishedForm({ kind: 'standalone' });
    component.setExpanded(false);
    expect(strip(component.render(80).join('\n'))).toContain('● line1');
    expect(strip(component.render(80).join('\n'))).toContain('ctrl+o to expand');
  });

  it('expands and collapses after finalization', () => {
    const component = new ThinkingComponent(longThinking, true, 'live');
    component.finalize();

    component.setExpanded(true);
    const expanded = strip(component.render(80).join('\n'));
    expect(expanded).toContain('line7');
    expect(expanded).not.toContain('ctrl+o to expand');

    component.setExpanded(false);
    const collapsed = strip(component.render(80).join('\n'));
    expect(collapsed).not.toContain('line7');
    expect(collapsed).toContain('ctrl+o to expand');
  });

  it('keeps the finalized truncation footer within the requested render width', () => {
    const component = new ThinkingComponent(longThinking, true, 'live');
    component.finalize();

    for (const line of component.render(37)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(37);
    }
  });

  it('shows a single overflow line instead of swapping it for a same-height hint', () => {
    const component = new ThinkingComponent(['line1', 'line2', 'line3'].join('\n'), true, 'live');
    component.finalize();

    const out = strip(component.render(80).join('\n'));
    expect(out).toContain('line1');
    expect(out).toContain('line2');
    expect(out).toContain('line3');
    expect(out).not.toContain('more lines');
    expect(component.hasHiddenContent()).toBe(false);
  });

  it('collapses once folding saves at least one row', () => {
    const component = new ThinkingComponent(
      ['line1', 'line2', 'line3', 'line4'].join('\n'),
      true,
      'live',
    );
    component.finalize();

    const out = strip(component.render(80).join('\n'));
    expect(out).toContain('line1');
    expect(out).toContain('line2');
    expect(out).not.toContain('line3');
    expect(out).toContain('… (2 more lines, ctrl+o to expand)');
    expect(component.hasHiddenContent()).toBe(true);
  });
});
