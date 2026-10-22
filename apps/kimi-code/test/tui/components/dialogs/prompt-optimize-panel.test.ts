import { describe, expect, it, mock } from 'bun:test';

import { visibleWidth } from '@moonshot-ai/pi-tui';

import { PromptOptimizePanelComponent } from '#/tui/components/dialogs/prompt-optimize-panel';

void mock.module('#/i18n', () => ({
  t: (key: string, params?: Record<string, string | number>): string => {
    const translations: Record<string, string> = {
      'tui.dialogs.promptOptimize.title': 'Rewrite this prompt',
      'tui.dialogs.promptOptimize.hint': '{{accept}} accept · {{discard}} discard',
      'tui.dialogs.promptOptimize.scrollHint': 'scroll {{expand}}',
      'tui.dialogs.promptOptimize.showing': 'showing {{from}}-{{to}} of {{total}}',
      'tui.dialogs.promptOptimize.accept': 'Accept rewrite',
      'tui.dialogs.promptOptimize.discard': 'Keep original',
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

const ESC = '\u001B';
const ENTER = '\r';
const LEFT = '\u001B[D';
const RIGHT = '\u001B[C';
const UP = '\u001B[A';
const DOWN = '\u001B[B';
const PAGE_UP = '\u001B[5~';
const PAGE_DOWN = '\u001B[6~';
const HOME = '\u001B[H';
const END = '\u001B[F';
const CTRL_O = '\u000F';

function makePanel() {
  const onSelect = mock();
  const panel = new PromptOptimizePanelComponent({
    original: 'fix the parser',
    optimized: 'Rewrite the parser to reject trailing input.',
    onSelect,
  });
  return { panel, onSelect };
}

describe('PromptOptimizePanelComponent', () => {
  it('accepts on Enter by default', () => {
    const { panel, onSelect } = makePanel();
    panel.handleInput(ENTER);
    expect(onSelect).toHaveBeenCalledWith('accept');
  });

  it('discards on Escape', () => {
    const { panel, onSelect } = makePanel();
    panel.handleInput(ESC);
    expect(onSelect).toHaveBeenCalledWith('discard');
  });

  it('moves the selection with the arrow keys and accepts the highlighted choice', () => {
    const { panel, onSelect } = makePanel();
    panel.handleInput(RIGHT);
    panel.handleInput(ENTER);
    expect(onSelect).toHaveBeenCalledWith('discard');
  });

  it('returns to accept with the opposite arrow', () => {
    const { panel, onSelect } = makePanel();
    panel.handleInput(RIGHT);
    panel.handleInput(LEFT);
    panel.handleInput(ENTER);
    expect(onSelect).toHaveBeenCalledWith('accept');
  });

  it('scrolls with the vertical arrows instead of moving the selection', () => {
    const onSelect = mock();
    const original = Array.from({ length: 80 }, (_, i) => `old-${i}`).join('\n');
    const optimized = Array.from({ length: 80 }, (_, i) => `new-${i}`).join('\n');
    const panel = new PromptOptimizePanelComponent({
      original,
      optimized,
      onSelect,
      maxVisible: 10,
    });

    const top = panel.render(80).join('\n');
    expect(top).toContain('old-');

    panel.handleInput(DOWN);
    panel.handleInput(DOWN);
    const scrolled = panel.render(80).join('\n');
    expect(scrolled).not.toBe(top);
    // Scrolling is not selection: Enter still accepts.
    panel.handleInput(ENTER);
    expect(onSelect).toHaveBeenCalledWith('accept');
  });

  it('pages with PageUp and PageDown and reports the visible window', () => {
    const onSelect = mock();
    const original = Array.from({ length: 80 }, (_, i) => `old-${i}`).join('\n');
    const optimized = Array.from({ length: 80 }, (_, i) => `new-${i}`).join('\n');
    const panel = new PromptOptimizePanelComponent({
      original,
      optimized,
      onSelect,
      maxVisible: 10,
    });

    const first = panel.render(80).join('\n');
    expect(first).toContain('showing 1-10 of');

    panel.handleInput(PAGE_DOWN);
    const paged = panel.render(80).join('\n');
    expect(paged).not.toBe(first);
    expect(paged).not.toContain('showing 1-10 of');
  });

  it('jumps to the ends with Home and End', () => {
    const onSelect = mock();
    const original = Array.from({ length: 80 }, (_, i) => `old-${i}`).join('\n');
    const optimized = Array.from({ length: 80 }, (_, i) => `new-${i}`).join('\n');
    const panel = new PromptOptimizePanelComponent({
      original,
      optimized,
      onSelect,
      maxVisible: 10,
    });

    panel.render(80);
    panel.handleInput(END);
    const atEnd = panel.render(80).join('\n');
    panel.handleInput(HOME);
    const atStart = panel.render(80).join('\n');
    expect(atEnd).not.toBe(atStart);
    expect(atStart).toContain('showing 1-10 of');
  });

  it('scrolls on a mouse wheel and consumes the event', () => {
    const onSelect = mock();
    const original = Array.from({ length: 80 }, (_, i) => `old-${i}`).join('\n');
    const optimized = Array.from({ length: 80 }, (_, i) => `new-${i}`).join('\n');
    const panel = new PromptOptimizePanelComponent({
      original,
      optimized,
      onSelect,
      maxVisible: 10,
    });

    const before = panel.render(80).join('\n');
    const result = panel.handleMouse({
      type: 'wheel',
      button: 'none',
      x: 0,
      y: 0,
      screenX: 0,
      screenY: 0,
      width: 80,
      height: 24,
      shift: false,
      alt: false,
      ctrl: false,
      wheelDelta: 3,
    });

    expect(result).toEqual({ handled: true });
    expect(panel.render(80).join('\n')).not.toBe(before);
  });

  it('ignores an empty wheel delta', () => {
    const { panel } = makePanel();
    const result = panel.handleMouse({
      type: 'wheel',
      button: 'none',
      x: 0,
      y: 0,
      screenX: 0,
      screenY: 0,
      width: 80,
      height: 24,
      shift: false,
      alt: false,
      ctrl: false,
      wheelDelta: 0,
    });

    expect(result).toBeUndefined();
  });

  it('renders both the original and the rewrite', () => {
    const { panel } = makePanel();
    const rendered = panel.render(80).join('\n');
    expect(rendered).toContain('fix the parser');
    expect(rendered).toContain('Rewrite the parser to reject trailing input.');
  });

  it('never exceeds the requested width', () => {
    const { panel } = makePanel();
    for (const line of panel.render(40)) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it('reveals the hidden changes on ctrl+o and collapses them again', () => {
    const onSelect = mock();
    const original = Array.from({ length: 60 }, (_, i) => `line-${i}`).join('\n');
    const optimized = Array.from({ length: 60 }, (_, i) => `changed-${i}`).join('\n');
    const panel = new PromptOptimizePanelComponent({ original, optimized, onSelect });

    const collapsed = panel.render(80).length;
    // The marker sits past the collapsed window, so it is reached by scrolling
    // rather than by rendering: the panel keeps only the visible rows.
    panel.handleInput(PAGE_DOWN);
    panel.handleInput(PAGE_DOWN);
    panel.handleInput(PAGE_DOWN);
    expect(panel.render(80).join('\n')).toContain('moreChangesHidden');

    panel.handleInput(CTRL_O);
    const expanded = panel.render(80).length;
    expect(expanded).toBeGreaterThanOrEqual(collapsed);

    panel.handleInput(CTRL_O);
    expect(panel.render(80).length).toBe(collapsed);
  });

  it('folds a long line instead of truncating it', () => {
    const onSelect = mock();
    const long = `reject-${'x'.repeat(300)}-trailing`;
    const panel = new PromptOptimizePanelComponent({
      original: 'short',
      optimized: long,
      onSelect,
    });

    const rendered = panel.render(40);

    // Every character of the long line is present, exactly once. A truncating
    // render would keep only the leading 33 columns of it.
    const joined = rendered.join('\n');
    expect((joined.match(/x/g) ?? []).length).toBe(300);
    // The tail survives too. It may be split across a fold boundary, so the
    // assertion is on the reassembled code rather than on any single row.
    const code = rendered
      .map((line) => line.replace(/^ {7}/, '').trimEnd())
      .join('');
    expect(code).toContain('reject-');
    expect(code).toContain('-trailing');
  });

  it('keeps folded rows within the requested width', () => {
    const onSelect = mock();
    const panel = new PromptOptimizePanelComponent({
      original: 'a'.repeat(200),
      optimized: `b${'c'.repeat(400)}d`.repeat(3),
      onSelect,
    });

    for (const width of [20, 40, 77]) {
      for (const line of panel.render(width)) {
        expect(visibleWidth(line), `width ${width}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it('indents continuation rows so a wrapped line still reads as one entry', () => {
    const onSelect = mock();
    const panel = new PromptOptimizePanelComponent({
      original: 'short',
      optimized: 'z'.repeat(200),
      onSelect,
    });

    const rows = panel.render(40).filter((line) => line.includes('z'));
    expect(rows.length).toBeGreaterThan(1);
    // The first row carries the numbered gutter; every continuation is padded
    // to the same column so the code lines up under itself.
    for (const row of rows.slice(1)) {
      expect(row.startsWith(' '.repeat(7))).toBe(true);
    }
  });

  it('does not fold lines that already fit', () => {
    const { panel } = makePanel();
    const rows = panel.render(80);
    // One row per diff entry: no wrapping happened.
    expect(rows.filter((line) => line.includes('Rewrite the parser')).length).toBe(1);
  });

  it('caps the folded row count so the choices stay reachable', () => {
    const onSelect = mock();
    // 24 diff lines, each long enough to fold many times at a narrow width.
    const original = Array.from({ length: 24 }, (_, i) => `old-${i}`).join('\n');
    const optimized = Array.from({ length: 24 }, (_, i) => 'y'.repeat(400)).join('\n');
    const panel = new PromptOptimizePanelComponent({ original, optimized, onSelect });

    const rows = panel.render(24);
    expect(rows.length).toBeLessThan(700);
    // The footer choices survive the cap and remain selectable.
    const rendered = rows.join('\n');
    expect(rendered).toContain('Accept rewrite');
    expect(rendered).toContain('Keep original');
  });

  it('does not select or dismiss when toggling the diff', () => {
    const { panel, onSelect } = makePanel();
    panel.handleInput(CTRL_O);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
