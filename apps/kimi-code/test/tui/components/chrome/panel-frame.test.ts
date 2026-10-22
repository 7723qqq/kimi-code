import { visibleWidth } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it } from 'bun:test';

import { setLocale } from '#/i18n';
import { DeviceCodeBoxComponent } from '#/tui/components/chrome/device-code-box';
import { renderPanelFrame } from '#/tui/components/chrome/panel-frame';
import { TodoPanelComponent } from '#/tui/components/chrome/todo-panel';
import { UsagePanelComponent } from '#/tui/components/messages/usage-panel';
import {
  PANEL_BOTTOM_LEFT,
  PANEL_BOTTOM_RIGHT,
  PANEL_HORIZONTAL,
  PANEL_TOP_LEFT,
  PANEL_TOP_RIGHT,
  PANEL_VERTICAL,
} from '#/tui/constant/panel';

afterEach(() => {
  setLocale('en');
});

const id = (s: string): string => s;

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('renderPanelFrame', () => {
  it('draws `╭ <title> ─…─╮` over `│ <content> │` with one cell of inner padding', () => {
    // contentWidth = max(longest body line, visibleWidth(' Hi ')) = 4.
    expect(renderPanelFrame({ title: 'Hi', body: ['ab'], width: 30, paint: id })).toEqual([
      '  ╭ Hi ──╮',
      '  │ ab   │',
      '  ╰──────╯',
    ]);
  });

  it('normalises a padded title so call sites can keep their own spacing', () => {
    const padded = renderPanelFrame({ title: ' Usage ', body: [''], width: 30, paint: id });
    const plain = renderPanelFrame({ title: 'Usage', body: [''], width: 30, paint: id });
    expect(padded).toEqual(plain);
    expect(padded[0]?.startsWith('  ╭ Usage ')).toBe(true);
  });

  it('truncates the title to the interior width with an ellipsis', () => {
    // width 12 -> 6 interior columns; the title is clipped before the dashes.
    const out = renderPanelFrame({ title: 'A very long title', body: [''], width: 12, paint: id });
    expect(out.map(strip)[0]).toBe('  ╭ A very…╮');
    for (const line of out) expect(visibleWidth(line)).toBeLessThanOrEqual(12);
  });

  it('indents for the transcript and starts at column 0 for the status strip', () => {
    const indented = renderPanelFrame({ title: 'T', body: ['x'], width: 20, paint: id });
    const flush = renderPanelFrame({
      title: 'T',
      body: ['x'],
      width: 20,
      paint: id,
      indent: 0,
    });
    expect(indented[0]?.startsWith('  ')).toBe(true);
    expect(flush[0]?.startsWith(`${PANEL_TOP_LEFT} `)).toBe(true);
    expect(indented[0]?.slice(2)).toBe(flush[0]);
  });

  it('drops the box when the indent and padding leave no interior', () => {
    // 5 columns cannot hold indent 2 + two borders + two padding cells.
    const narrow = renderPanelFrame({ title: 'Hi', body: ['abcdef'], width: 5, paint: id });
    expect(narrow.map(strip)).toEqual(['Hi', 'abcd…']);
    expect(renderPanelFrame({ title: 'Hi', body: ['body'], width: 0, paint: id })).toEqual(['']);
  });

  it('paints border and title through their own callbacks', () => {
    const out = renderPanelFrame({
      title: 'T',
      body: ['x'],
      width: 20,
      paint: (s) => `<${s}>`,
      titlePaint: (s) => `[${s}]`,
    });
    expect(out[0]).toBe(
      `  <${PANEL_TOP_LEFT}>[ T ]<${PANEL_HORIZONTAL.repeat(2)}><${PANEL_TOP_RIGHT}>`,
    );
    expect(out[1]).toBe(`  <${PANEL_VERTICAL}> x   <${PANEL_VERTICAL}>`);
    expect(out[2]).toBe(
      `  <${PANEL_BOTTOM_LEFT}${PANEL_HORIZONTAL.repeat(5)}${PANEL_BOTTOM_RIGHT}>`,
    );
  });
});

describe('panel frame adoption', () => {
  it('usage and device-code boxes share corners, indent and title format', () => {
    setLocale('en');

    const usage = new UsagePanelComponent(() => ['body'], 'primary').render(40).map(strip);
    const device = new DeviceCodeBoxComponent({ title: 'Sign in', url: 'https://example.test' })
      .render(40)
      .map(strip);

    // usage / device-code are transcript panels (indent 2). Both share the
    // same glyphs. The todo panel is not in this list on purpose: it is a
    // status-strip region, and the strip's frame belongs to the status
    // surface (see the next case).
    const cases: ReadonlyArray<{ lines: readonly string[]; indent: string; title: string }> = [
      { lines: usage, indent: '  ', title: 'Usage' },
      { lines: device, indent: '  ', title: 'Sign in' },
    ];

    for (const { lines, indent, title } of cases) {
      const top = lines.find((line) => line.includes(PANEL_TOP_LEFT));
      const bottom = lines.find((line) => line.includes(PANEL_BOTTOM_LEFT));
      expect(top).toBeDefined();
      expect(bottom).toBeDefined();
      expect(top?.startsWith(`${indent}${PANEL_TOP_LEFT} ${title} `)).toBe(true);
      expect(top?.endsWith(PANEL_TOP_RIGHT)).toBe(true);
      expect(bottom?.startsWith(`${indent}${PANEL_BOTTOM_LEFT}${PANEL_HORIZONTAL}`)).toBe(true);
      expect(bottom?.endsWith(PANEL_BOTTOM_RIGHT)).toBe(true);

      // Every row between the borders is a canonical body row: `│ `, content,
      // ` │`, all inside the width.
      const bodyRows = lines.slice(lines.indexOf(top!), lines.indexOf(bottom!));
      for (const row of bodyRows.slice(1)) {
        expect(row.startsWith(`${indent}${PANEL_VERTICAL} `)).toBe(true);
        expect(row.endsWith(` ${PANEL_VERTICAL}`)).toBe(true);
      }
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it('the todo panel draws content only: the strip\'s frame belongs to the status surface', () => {
    setLocale('en');

    const todoPanel = new TodoPanelComponent();
    todoPanel.setTodos([{ title: 'task', status: 'pending' }]);
    const lines = todoPanel.render(40).map(strip);

    // The "Todo" label heads the progress row, and the panel paints no box of
    // its own — the status surface draws the one frame around the strip.
    expect(lines[0]).toContain('Todo');
    expect(lines.join('\n')).not.toMatch(/[╭╮╰╯│]/);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });
});
