import type { TuiMouseEvent } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import {
  MAX_VISIBLE_ROWS,
  NotifyPanelComponent,
  type NotifyEntry,
} from '#/tui/components/chrome/notify-panel';
import { hasHiddenContent, isExpandable } from '#/tui/utils/component-capabilities';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function render(panel: NotifyPanelComponent, width = 80): string[] {
  return panel.render(width).map(strip);
}

/** Line 0 is a blank spacer separating the box from the scrolling transcript. */
function titleOf(panel: NotifyPanelComponent, width = 80): string {
  return render(panel, width)[1]!;
}

function entry(id: string, text: string, agentId = 'main', agentName?: string): NotifyEntry {
  return { id, agentId, agentName, time: 0, text };
}

/**
 * Column of `text` on the top border (line 1 of the render), which is where the
 * tab strip lives. Mouse hit testing is column-based, so tests must derive the
 * column from the same rendered string the user sees rather than guessing it.
 */
function tabColumn(panel: NotifyPanelComponent, text: string, width = 80): number {
  const border = render(panel, width)[1] ?? '';
  const index = border.indexOf(text);
  if (index < 0) throw new Error(`tab ${text} not on the border: ${border}`);
  return index + 1;
}

/** A mouse event aimed at the top border's `column`. */
function borderClick(column: number, type: 'press' | 'click' = 'click'): TuiMouseEvent {
  return {
    type,
    button: 'left',
    x: column,
    y: 1,
    screenX: column,
    screenY: 1,
    width: 80,
    height: 10,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

function listRows(count: number, prefix = 'row'): string {
  return Array.from({ length: count }, (_, i) => `- ${prefix} ${String(i + 1)}`).join('\n');
}

describe('NotifyPanelComponent', () => {
  it('returns no lines when empty (so the layout slot collapses)', () => {
    const panel = new NotifyPanelComponent();
    expect(panel.render(80)).toEqual([]);
    expect(panel.isEmpty()).toBe(true);
    expect(panel.focus()).toBe(false);
  });

  it('renders the update in a padded, bordered box with the channel tab', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'Login module is clean; the bug is in **session expiry**.'));
    const lines = render(panel);

    expect(lines[0]).toBe('');
    expect(lines[1]).toMatch(/^╭/);
    expect(lines[1]).toContain('main');
    expect(lines[1]).toContain('Updates 1/1');
    expect(lines[1]).toContain('ctrl+n page');
    expect(lines[1]).toMatch(/─╮$/);
    expect(lines[2]).toMatch(/^│\s*│$/);
    expect(lines[3]).toMatch(/^│  /);
    expect(lines[3]).toContain('Login module is clean; the bug is in session expiry.');
    expect(lines.at(-2)).toMatch(/^│\s*│$/);
    expect(lines.at(-1)).toMatch(/^╰─+╯$/);
  });

  it('updates an entry in place and flattens entries in display order', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'Reading the'));
    panel.upsert(entry('tc-1', 'Reading the parser first.'));
    expect(panel.getEntries().map((item) => item.text)).toEqual(['Reading the parser first.']);
    expect(render(panel).join('\n')).toContain('Reading the parser first.');
  });

  it('follows the latest activity across channels while unfocused', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'main phase one'));
    panel.upsert(entry('tc-2', 'main phase two'));
    expect(titleOf(panel)).toContain('Updates 2/2');

    panel.upsert(entry('a0:c1', 'explore finding', 'a0', 'explore'));
    const lines = render(panel);
    expect(lines[1]).toContain('main');
    expect(lines[1]).toContain('explore');
    expect(lines[1]).toContain('Updates 1/1');
    expect(lines.join('\n')).toContain('explore finding');
    expect(lines.join('\n')).not.toContain('main phase');
  });

  it('switches channels with prev/nextChannel and pages inside a channel', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'main one'));
    panel.upsert(entry('tc-2', 'main two'));
    panel.upsert(entry('a0:c1', 'explore one', 'a0', 'explore'));

    expect(panel.focus()).toBe(true);
    expect(panel.nextChannel()).toBe(false);

    expect(panel.prevChannel()).toBe(true);
    expect(titleOf(panel)).toContain('Updates 2/2');
    expect(render(panel).join('\n')).toContain('main two');

    expect(panel.prevPage()).toBe(true);
    expect(titleOf(panel)).toContain('Updates 1/2');
    expect(render(panel).join('\n')).toContain('main one');
    expect(panel.prevPage()).toBe(false);

    expect(panel.nextPage()).toBe(true);
    expect(render(panel).join('\n')).toContain('main two');
  });

  it('collects an unread dot on background channels while focused, cleared on visit', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'main one'));
    panel.upsert(entry('a0:c1', 'explore one', 'a0', 'explore'));

    panel.focus();
    panel.prevChannel();
    expect(titleOf(panel)).not.toContain('●');

    panel.upsert(entry('a0:c2', 'explore two', 'a0', 'explore'));
    expect(titleOf(panel)).toContain('explore●');
    expect(render(panel).join('\n')).toContain('main one');

    expect(panel.nextChannel()).toBe(true);
    expect(titleOf(panel)).not.toContain('●');
    expect(titleOf(panel)).toContain('Updates 2/2');
    expect(render(panel).join('\n')).toContain('explore two');
  });

  it('dedups repeated channel labels with a counter', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('a1:c1', 'first explore', 'a1', 'explore'));
    panel.upsert(entry('a2:c1', 'second explore', 'a2', 'explore'));

    expect(panel.getChannels().map((ch) => ch.label)).toEqual(['explore', 'explore(2)']);
  });

  it('labels channels by raw agent id when no name is known', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('a9:c1', 'mystery worker', 'agent-9'));
    expect(panel.getChannels().map((ch) => ch.label)).toEqual(['agent-9']);
    expect(titleOf(panel)).toContain('agent-9');
  });

  it('caps a long entry at the row ceiling and reports what is hidden', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', listRows(30)));
    // The ceiling is a TOTAL-row budget, so the box never exceeds it: the
    // five lines of chrome (spacer/borders/padding) come out of the budget
    // rather than being added on top of it.
    const lines = render(panel);
    expect(lines.length).toBe(MAX_VISIBLE_ROWS);
    // A following view shows the newest rows, and the title reports the rest.
    const text = lines.join('\n');
    expect(text).toContain('• row 30 ');
    expect(text).not.toContain('• row 1 ');
    expect(titleOf(panel)).toMatch(/\+\d+ lines/);
  });

  it('scrolls the capped body with scrollBy, clamped to the entry bounds', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', listRows(30)));
    render(panel);

    // A following view sits on the tail, so scrolling up is the move that works.
    expect(panel.scrollBy(-1)).toBe(true);
    expect(render(panel).join('\n')).toContain('• row 29 ');

    // Scrolling down returns to the tail; clamped there, so it reports no move.
    expect(panel.scrollBy(999)).toBe(true);
    expect(render(panel).join('\n')).toContain('• row 30 ');
    expect(panel.scrollBy(1)).toBe(false);
  });

  it('does not reset a browsing offset when the panel loses focus', () => {
    // Focus and "where the reader is" are separate concerns: pressing esc must
    // not throw away the position the wheel established.
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', listRows(30)));
    panel.focus();
    render(panel);
    for (let i = 0; i < 5; i++) panel.scrollBy(-1);
    const browsing = render(panel).join('\n');
    expect(browsing).toContain('• row 25 ');
    panel.blur();
    render(panel);
    const after = render(panel).join('\n');
    expect(after).toContain('• row 25 ');
    expect(after).not.toContain('• row 30 ');
  });

  it('honours a terminal-derived budget below the fixed ceiling', () => {
    // 10 rows of terminal => a 5-row TOTAL budget, under MAX_VISIBLE_ROWS, so
    // the body gets 5 - 5 = 0 and the box degrades to its one-line stub.
    const panel = new NotifyPanelComponent(() => 10);
    panel.upsert(entry('tc-1', listRows(30)));
    const lines = render(panel);
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  it('renders focus state: highlighted hints, blur restores', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'phase one'));

    expect(titleOf(panel)).toContain('ctrl+n page');
    panel.focus();
    expect(titleOf(panel)).toContain('← → agent · ↑ ↓ scroll · [ ] update · esc close');
    panel.blur();
    expect(panel.blur()).toBe(false);
    expect(titleOf(panel)).toContain('ctrl+n page');
  });

  it('folds to a one-line preview stub when the turn ends, expands on focus', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'phase one intro\n\n- detail one\n- detail two'));
    panel.setEnded(true);

    const collapsed = render(panel);
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0]).toBe('');
    expect(collapsed[1]).toContain('▸');
    expect(collapsed[1]).toContain('main');
    expect(collapsed[1]).toContain('1 update');
    expect(collapsed[1]).toContain('phase one intro');
    expect(collapsed[1]).toContain('ctrl+n');
    expect(collapsed[1]).not.toContain('detail one');
    expect(collapsed[1]).not.toMatch(/[╭╮╰╯│]/);

    panel.focus();
    const expanded = render(panel);
    expect(expanded.join('\n')).toContain('detail one');
    expect(expanded.length).toBeGreaterThan(2);

    panel.blur();
    expect(render(panel)).toHaveLength(2);
  });

  it('stays expanded when the turn ends while the user is reading, folds on blur', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'phase one'));
    panel.focus();
    panel.setEnded(true);

    expect(render(panel).join('\n')).toContain('phase one');

    panel.blur();
    expect(render(panel)).toHaveLength(2);
  });

  it('unfolds and undims when a fresh update arrives after the turn ended', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'done with phase one'));
    panel.setEnded(true);
    expect(render(panel)).toHaveLength(2);

    panel.upsert(entry('tc-2', 'fresh turn update'));
    const lines = render(panel);
    expect(lines.join('\n')).toContain('fresh turn update');
    expect(lines[1]).not.toContain('turn ended');
  });

  it('removes an entry and drops empty channels', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'main one'));
    panel.upsert(entry('a0:c1', 'explore one', 'a0', 'explore'));

    expect(panel.remove('a0:c1')).toBe(true);
    expect(panel.getChannels().map((ch) => ch.label)).toEqual(['main']);
    expect(panel.remove('missing')).toBe(false);
  });

  it('clamps the page when the newest entry is removed', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'first'));
    panel.upsert(entry('tc-2', 'second'));
    expect(titleOf(panel)).toContain('Updates 2/2');

    expect(panel.remove('tc-2')).toBe(true);
    expect(titleOf(panel)).toContain('Updates 1/1');
    expect(panel.nextPage()).toBe(false);
  });

  it('releases focus when removal empties the panel', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'only'));
    expect(panel.focus()).toBe(true);

    expect(panel.remove('tc-1')).toBe(true);
    expect(panel.isEmpty()).toBe(true);
    expect(panel.isFocused()).toBe(false);
    expect(panel.prevPage()).toBe(false);
    expect(panel.nextPage()).toBe(false);
  });

  it('clears the unread count when a retracted entry was unread', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'main one'));
    panel.upsert(entry('a0:c1', 'explore one', 'a0', 'explore'));
    expect(panel.focus()).toBe(true);

    panel.upsert(entry('tc-2', 'main two'));
    const before = panel.getChannels().find((ch) => ch.label === 'main');
    expect(before?.unread).toBe(1);

    expect(panel.remove('tc-2')).toBe(true);
    const after = panel.getChannels().find((ch) => ch.label === 'main');
    expect(after?.unread).toBe(0);
  });

  it('keeps the unread count when a retracted entry was already read', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'main one'));
    panel.upsert(entry('a0:c1', 'explore one', 'a0', 'explore'));
    expect(panel.focus()).toBe(true);

    panel.upsert(entry('tc-2', 'delegation'));
    expect(panel.getChannels().find((ch) => ch.label === 'main')?.unread).toBe(1);

    expect(panel.prevChannel()).toBe(true);
    expect(panel.nextChannel()).toBe(true);
    panel.upsert(entry('tc-3', 'main three'));
    expect(panel.getChannels().find((ch) => ch.label === 'main')?.unread).toBe(1);

    expect(panel.remove('tc-2')).toBe(true);
    expect(panel.getChannels().find((ch) => ch.label === 'main')?.unread).toBe(1);
  });

  it('dims to a stub and notes the ended turn, and clears wholesale', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'done with phase one'));
    panel.setEnded(true);
    expect(render(panel)).toHaveLength(2);
    expect(titleOf(panel)).toContain('ctrl+n');

    panel.clear();
    expect(panel.isEmpty()).toBe(true);
    expect(panel.render(80)).toEqual([]);

    panel.upsert(entry('tc-2', 'fresh turn'));
    expect(titleOf(panel)).not.toContain('turn ended');
  });

  it('folds finished channels into one +N done tab', () => {
    // A fan-out of short-lived subagents used to push the strip past the width
    // budget, at which point the title dropped it entirely and the user could
    // no longer see or navigate the other agents.
    const panel = new NotifyPanelComponent();
    for (let i = 0; i < 4; i++) {
      panel.upsert(entry(`a${String(i)}`, `sub ${String(i)}`, `agent-${String(i)}`, 'explore'));
    }
    panel.upsert(entry('main-1', 'main update'));

    expect(titleOf(panel)).toContain('explore(4)');

    expect(panel.markFinished('agent-1')).toBe(true);
    expect(panel.markFinished('agent-2')).toBe(true);
    const folded = titleOf(panel);
    expect(folded).toContain('+2 done');
    expect(folded).not.toContain('explore(2)');
    expect(folded).not.toContain('explore(3)');
  });

  it('keeps the active channel visible even when it is finished', () => {
    // The current position must never be hidden behind the aggregate tab.
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('a1', 'one', 'agent-1', 'explore'));
    panel.upsert(entry('a2', 'two', 'agent-2', 'explore'));
    panel.markFinished('agent-1');
    panel.markFinished('agent-2');
    panel.prevChannel();
    // Active is now agent-1, so it needs its own tab — not part of +N done.
    expect(titleOf(panel)).toContain('explore');
    expect(titleOf(panel)).toContain('+1 done');
  });

  it('never folds the main agent channel', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('m1', 'main update'));
    expect(panel.markFinished('main')).toBe(false);
    expect(titleOf(panel)).toContain('main');
  });

  it('treats markFinished as idempotent and ignores unknown agents', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('a1', 'one', 'agent-1', 'explore'));
    expect(panel.markFinished('agent-1')).toBe(true);
    expect(panel.markFinished('agent-1')).toBe(false);
    expect(panel.markFinished('never-posted')).toBe(false);
  });

  it('still navigates to a folded channel', () => {
    // Folding is a label decision, not a model one: the entries stay reachable.
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('a1', 'from agent one', 'agent-1', 'explore'));
    panel.upsert(entry('a2', 'from agent two', 'agent-2', 'explore'));
    panel.markFinished('agent-1');
    expect(strip(panel.render(80).join('\n'))).toContain('from agent two');
    expect(panel.prevChannel()).toBe(true);
    expect(strip(panel.render(80).join('\n'))).toContain('from agent one');
  });

  it('keeps a browsing reader in place when new content arrives', () => {
    // Following ("new content wins") is a separate state from keyboard focus.
    // Before, an unfocused panel was force-following, so a wheel-scrolled reader
    // lost their place on every update — the reason the wheel had to grab focus.
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', listRows(30)));
    panel.upsert(entry('tc-2', listRows(30, 'row')));
    panel.render(80);

    // Browse up, unfocused. Five rows off the tail: the window is fixed by the
    // assertions below, not by a guess at the exact offset.
    for (let i = 0; i < 5; i++) expect(panel.scrollBy(-1)).toBe(true);
    const browsed = render(panel).join('\n');
    expect(browsed).toContain('• row 25 ');
    expect(browsed).not.toContain('• row 30 ');

    // New content must not yank the window while the reader is above the tail.
    panel.upsert(entry('tc-3', 'brand new update'));
    expect(render(panel).join('\n')).not.toContain('brand new update');
    expect(panel.isFocused()).toBe(false);
  });

  it('resumes following once the reader returns to the bottom', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', listRows(30)));
    panel.render(80);
    for (let i = 0; i < 5; i++) panel.scrollBy(-1);
    // Scroll past the end; the clamp lands on the tail and re-arms following.
    for (let i = 0; i < 40; i++) panel.scrollBy(1);
    panel.upsert(entry('tc-2', 'newest update'));
    expect(render(panel).join('\n')).toContain('newest update');
  });

  it('scrolls the current update on the mouse wheel', () => {
    // Without consuming the wheel the alt-screen routes it to the primary scroll
    // view, so scrolling over the box moved the transcript instead.
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', listRows(30)));

    const result = panel.handleMouse({
      type: 'wheel',
      button: 'none',
      x: 5,
      y: 3,
      screenX: 5,
      screenY: 3,
      width: 80,
      height: 12,
      shift: false,
      alt: false,
      ctrl: false,
      wheelDelta: 3,
    });

    expect(result?.handled).toBe(true);
    // Wheel-down moves the window; the first row is now out of view.
    expect(render(panel).join('\n')).not.toContain('• row 1 ');
  });

  it('ignores a wheel event with no delta', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', listRows(30)));
    expect(
      panel.handleMouse({
        type: 'wheel',
        button: 'none',
        x: 0,
        y: 0,
        screenX: 0,
        screenY: 0,
        width: 80,
        height: 12,
        shift: false,
        alt: false,
        ctrl: false,
      }),
    ).toBeUndefined();
  });

  it('switches channel when its tab is clicked', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('a1', 'first agent update', 'agent-1', 'explore'));
    panel.upsert(entry('a2', 'second agent update', 'agent-2', 'coder'));

    // The view follows the newest channel; click the older tab to go back.
    expect(render(panel).join('\n')).toContain('second agent update');
    const column = tabColumn(panel, 'explore');

    expect(panel.handleMouse(borderClick(column))?.handled).toBe(true);
    expect(render(panel).join('\n')).toContain('first agent update');
  });

  it('ignores a bare pointer press so one click does not act twice', () => {
    // The alt-screen emits `click` on release after a press that did not move.
    // Acting on `press` as well toggles twice, which for `+N done` cancels out
    // — a single click would do nothing. So `press` must be inert.
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('a1', 'one', 'agent-1', 'explore'));
    panel.upsert(entry('a2', 'two', 'agent-2', 'coder'));
    const column = tabColumn(panel, 'explore');

    expect(panel.handleMouse(borderClick(column, 'press'))).toBeUndefined();
    // Still on the newest channel, i.e. nothing moved.
    expect(render(panel).join('\n')).toContain('two');

    // The `click` that follows does the work, exactly once.
    expect(panel.handleMouse(borderClick(column, 'click'))?.handled).toBe(true);
    expect(render(panel).join('\n')).toContain('one');
  });

  it('toggles +N done exactly once per click', () => {
    const panel = new NotifyPanelComponent();
    for (let i = 1; i <= 4; i++) {
      panel.upsert(entry(`a${String(i)}`, `u${String(i)}`, `agent-${String(i)}`, 'explore'));
    }
    panel.markFinished('agent-1');
    panel.markFinished('agent-2');
    const column = tabColumn(panel, '+2 done');

    // One click expands; the tab flips to its collapse form rather than vanishing.
    expect(panel.handleMouse(borderClick(column, 'click'))?.handled).toBe(true);
    expect(panel.isFinishedExpanded()).toBe(true);
    expect(render(panel).join('\n')).toContain('−2 done');
  });

  it('expands the folded channels when the aggregate tab is clicked', () => {
    const panel = new NotifyPanelComponent();
    for (let i = 1; i <= 4; i++) {
      panel.upsert(entry(`a${String(i)}`, `u${String(i)}`, `agent-${String(i)}`, 'explore'));
    }
    panel.markFinished('agent-1');
    panel.markFinished('agent-2');
    expect(render(panel).join('\n')).toContain('+2 done');

    const column = tabColumn(panel, '+2 done');
    expect(panel.handleMouse(borderClick(column))?.handled).toBe(true);
    expect(panel.isFinishedExpanded()).toBe(true);
    // The folded channels are listed again, and the aggregate tab is gone.
    const after = render(panel).join('\n');
    expect(after).not.toContain('+2 done');
    expect(after).toContain('explore');
  });

  it('ignores clicks that miss a tab', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('a1', 'one'));
    // A body row, not the border.
    expect(panel.handleMouse({ ...borderClick(3), y: 3 })).toBeUndefined();
    // The border, but past the last tab (only the fill line is there).
    expect(panel.handleMouse(borderClick(79))).toBeUndefined();
    // A right-click never acts on tabs.
    expect(panel.handleMouse({ ...borderClick(2), button: 'right' })).toBeUndefined();
  });

  it('exposes the Expandable capability the fold fallback needs', () => {
    // The panels row turns an unhandled click into a fold toggle, and it decides
    // whether that is possible from these three methods (the same capability the
    // transcript's fold blocks implement).
    const panel = new NotifyPanelComponent();
    expect(isExpandable(panel)).toBe(true);
    // Nothing to reveal while empty: a click must not claim to have folded it.
    expect(hasHiddenContent(panel)).toBe(false);

    panel.upsert(entry('tc-1', 'an update'));
    expect(panel.isExpanded()).toBe(true);
    expect(hasHiddenContent(panel)).toBe(false);

    panel.setExpanded(false);
    expect(panel.isExpanded()).toBe(false);
    expect(hasHiddenContent(panel)).toBe(true);

    panel.setExpanded(true);
    expect(render(panel).join('\n')).toContain('an update');
  });

  it('folds and unfolds through setExpanded', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', listRows(30)));
    expect(render(panel).length).toBeGreaterThan(2);

    panel.setExpanded(false);
    // Folded: a one-line stub plus the spacer above it.
    expect(render(panel).length).toBe(2);
    expect(render(panel).join('\n')).toContain('ctrl+n');

    panel.setExpanded(true);
    expect(render(panel).length).toBeGreaterThan(2);
  });

  it('leaves body clicks unhandled so the container can fold', () => {
    // The panel claims only its tab strip; everything else returns undefined so
    // `GutterContainer`'s fallback owns the fold toggle. Two owners would mean
    // two behaviours for the same gesture.
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', listRows(30)));
    expect(panel.handleMouse({ ...borderClick(10), y: 3 })).toBeUndefined();
    expect(panel.handleMouse({ ...borderClick(10), y: 0 })).toBeUndefined();
  });

  it('offers a way back once the folded channels are expanded', () => {
    // Expanding used to remove the aggregate tab, leaving no visible way to fold
    // the group again — the toggle is a one-way door.
    const panel = new NotifyPanelComponent();
    for (let i = 1; i <= 4; i++) {
      panel.upsert(entry(`a${String(i)}`, `u${String(i)}`, `agent-${String(i)}`, 'explore'));
    }
    panel.markFinished('agent-1');
    panel.markFinished('agent-2');

    expect(titleOf(panel, 120)).toContain('+2 done');
    const foldedColumn = tabColumn(panel, '+2 done', 120);

    expect(panel.handleMouse(borderClick(foldedColumn))?.handled).toBe(true);
    const expanded = titleOf(panel, 120);
    expect(expanded).toContain('−2 done');
    // The folded channels now have their own tabs (the first keeps the bare
    // label; later ones are numbered).
    expect(expanded).toContain('explore · explore(2)');

    // Clicking the aggregate again folds them back.
    const expandedColumn = tabColumn(panel, '−2 done', 120);
    expect(panel.handleMouse(borderClick(expandedColumn))?.handled).toBe(true);
    expect(panel.isFinishedExpanded()).toBe(false);
    expect(titleOf(panel, 120)).toContain('+2 done');
  });

  it('never renders wider than the requested width', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', `${'word '.repeat(60)}\n\n- a very long bullet ${'x'.repeat(120)}`));
    panel.upsert(entry('a1:c1', listRows(12, 'later'), 'a1', 'explore'));
    for (const width of [24, 40, 80]) {
      for (const line of panel.render(width)) {
        expect(strip(line).length).toBeLessThanOrEqual(width);
      }
    }
  });
});
