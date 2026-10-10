/**
 * NotifyPanel — mid-turn updates, shown as a bordered box right above the
 * input area (below the Todo panel), visually matching the editor.
 *
 * Updates are grouped into CHANNELS, one per agent: the main agent plus one
 * channel per subagent that posts a `NotifyUser` update. The top border is a
 * tab strip of channel labels; `Ctrl+N` focuses the box, then `←`/`→` switch
 * channels, `↑`/`↓` scroll the current update, and `[`/`]` step between updates
 * in the channel. While the user is not focused, the view follows the latest
 * activity across channels; while focused it stays put and other channels
 * collect an unread dot.
 *
 * The mouse works too: the wheel over the box scrolls the current update (and
 * does not fall through to the transcript), clicking a channel tab switches to
 * it, and clicking the `+N done` tab expands the folded channels into their own
 * tabs. Hit testing needs column ranges, which the render pass records — see
 * `tabHitRanges`.
 *
 * The box is capped at {@link MAX_VISIBLE_ROWS} rows and at half the terminal
 * height, whichever is smaller — an update body can be arbitrarily long, and
 * without a cap the box grew until the editor and footer were pushed off
 * screen. Content beyond the cap scrolls; the title carries how much is out of
 * view. When the turn ends the box folds to a one-line stub until the user
 * focuses it; the host clears the box when the next turn starts.
 */

import type { Component, TuiMouseEvent, TuiMouseEventResult } from '@moonshot-ai/pi-tui';
import { truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { t } from '#/i18n';
import { Markdown } from '#/tui/components/markdown/markdown';
import { MAIN_AGENT_ID } from '#/tui/constant/kimi-tui';
import { currentTheme } from '#/tui/theme';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import { createMarkdownOptions } from '#/tui/utils/markdown-options';

import { wrapWithSideBorders } from '../editor/custom-editor';

export interface NotifyEntry {
  readonly id: string;
  readonly agentId: string;
  readonly agentName?: string;
  readonly time: number;
  readonly text: string;
}

export interface NotifyChannelView {
  readonly label: string;
  readonly entries: readonly { readonly id: string; readonly text: string }[];
  readonly unread: number;
}

interface NotifyChannel {
  readonly key: string;
  readonly label: string;
  readonly entries: NotifyEntry[];
  /** Index of the entry on display. */
  page: number;
  /** First body row of the displayed entry that is visible. */
  scroll: number;
  /**
   * Sticking to the newest row, the way `BtwPanelComponent` does it: paging an
   * entry re-arms it, scrolling up disarms it, and reaching the bottom arms it
   * again. Independent of keyboard focus, so the wheel can browse without
   * grabbing focus the way `Ctrl+N` does.
   */
  followTail: boolean;
  /** Ids of entries that arrived while the user was reading another channel. */
  readonly unreadIds: Set<string>;
  /**
   * The agent behind this channel has stopped. A finished channel keeps its
   * entries (they stay readable) but stops claiming a tab of its own: several
   * completed subagents collapse into one `+N done` tab, because a per-agent
   * tab for work that is over crowds out the agents still running.
   */
  finished: boolean;
}

/**
 * Hard ceiling on the rendered box, borders included. Matches the fixed-cap
 * convention the todo panel uses (`MAX_VISIBLE`), so both panels in the shared
 * row behave the same way. The terminal half-height cap below is the smaller
 * of the two on a short terminal.
 */
export const MAX_VISIBLE_ROWS = 12;
/**
 * Rows the box always spends regardless of content: the leading spacer, the top
 * border plus its inner padding, and the bottom padding plus border. A budget
 * that covers only the body therefore overflows the terminal by this much — the
 * cap has to be expressed in total rows and the overhead subtracted from it.
 */
const PANEL_OVERHEAD_ROWS = 5;
/** Body rows below which the box stops drawing a body and degrades to a stub. */
const MIN_BODY_ROWS = 1;

/** Rows the terminal currently has; the host wires the real reader in. */
export type TerminalRowsProvider = () => number | undefined;

/**
 * A clickable span on the box's top border.
 *
 * The tab strip lives inside the border line, so a click arrives as a column in
 * that line. The render pass knows each tab's columns; this records them for the
 * next `handleMouse`, which has no other way to map a column back to a channel.
 */
interface TabHitRange {
  readonly from: number;
  readonly to: number;
  /** Channel key, or `undefined` for the `+N done` aggregate tab. */
  readonly key: string | undefined;
}

function padToVisibleWidth(text: string, target: number): string {
  const truncated = truncateToWidth(text, target);
  const gap = target - visibleWidth(truncated);
  return gap > 0 ? truncated + ' '.repeat(gap) : truncated;
}

export class NotifyPanelComponent implements Component {
  private readonly channels: NotifyChannel[] = [];
  /** Key of the channel on display; channels themselves are append-only. */
  private activeKey = MAIN_AGENT_ID;
  private focused = false;
  private ended = false;
  /** Turn ended and no one is reading: the box folds to a one-line stub. */
  private collapsed = false;
  /** How many body rows the displayed entry needs, and at what width. */
  private lastBodyHeight = 0;
  private lastWidth = 80;
  /** Clickable spans of the top border, refreshed by every `title()` call. */
  private tabHitRanges: TabHitRange[] = [];
  /** `+N done` expanded into individual tabs (mouse toggle). */
  private finishedExpanded = false;

  constructor(private readonly terminalRows: TerminalRowsProvider = () => undefined) {}

  /**
   * Body rows a render may occupy.
   *
   * The cap is a **total**-row budget, because that is what the terminal cares
   * about: {@link MAX_VISIBLE_ROWS} total, or half the terminal, whichever is
   * smaller, minus {@link PANEL_OVERHEAD_ROWS}. Expressing it as "body rows"
   * without the subtraction is what let a 6-row terminal get an 8-row panel.
   *
   * Below {@link MIN_BODY_ROWS} there is no room for a body, so the box degrades
   * to the one-line stub instead of drawing a box taller than its budget. An
   * unknown terminal height still gets the fixed ceiling — the cap must not
   * disappear just because the host did not supply a row count.
   */
  private bodyBudget(): number {
    const rows = this.terminalRows();
    const totalRows =
      rows === undefined || !Number.isFinite(rows) || rows <= 0
        ? MAX_VISIBLE_ROWS
        : Math.min(MAX_VISIBLE_ROWS, Math.floor(rows / 2));
    return totalRows - PANEL_OVERHEAD_ROWS;
  }

  /** True when there is not enough height for a box, so a stub is all we draw. */
  private mustCollapse(): boolean {
    return this.collapsed || this.bodyBudget() < MIN_BODY_ROWS;
  }

  /**
   * Add or update an entry in a channel. A repeated `id` updates the entry in
   * place; a new id appends. While unfocused the view jumps to the entry's
   * channel and its tail — the latest activity always wins; while focused the
   * user's page stays put and background channels collect unread instead.
   */
  upsert(entry: NotifyEntry): void {
    const ch = this.channelFor(entry);
    const existing = ch.entries.find((item) => item.id === entry.id);
    const isNew = existing === undefined;
    if (existing !== undefined) ch.entries[ch.entries.indexOf(existing)] = entry;
    else ch.entries.push(entry);
    if (!this.focused) {
      this.activeKey = ch.key;
      // Following means "new content wins"; a reader who scrolled up with the
      // wheel is not following, and yanking their window on every update would
      // lose their place — the whole point of not stealing focus.
      if (ch.followTail) {
        ch.page = ch.entries.length - 1;
        ch.scroll = 0;
      }
      ch.unreadIds.clear();
    } else if (isNew && ch.key !== this.activeKey) {
      ch.unreadIds.add(entry.id);
    }
    this.ended = false;
    this.collapsed = false;
  }

  /**
   * Fold or unfold the box.
   *
   * This is the `Expandable` capability the transcript's fold blocks also
   * implement (`utils/component-capabilities.ts`), which is what lets a click
   * anywhere on the panel toggle it through the same code path as a tool card —
   * rather than the panel inventing its own click target.
   *
   * Folding is not `Ctrl+N`: it changes what is drawn, not who owns the keyboard.
   */
  setExpanded(expanded: boolean): void {
    this.collapsed = !expanded;
  }

  isExpanded(): boolean {
    return !this.collapsed;
  }

  /**
   * True when unfolding would reveal something — the panel is folded and there
   * is at least one update to show. A panel with nothing to reveal stays inert so
   * a click on it does not claim to have done something.
   */
  hasHiddenContent(): boolean {
    return this.collapsed && this.channels.length > 0;
  }

  /**
   * Mark the channel for `agentId` as finished (its agent stopped). Unknown ids
   * are ignored: a subagent that never posted an update has no channel to fold.
   * The main agent's channel is never folded — it is the one the user reads.
   */
  markFinished(agentId: string): boolean {
    const ch = this.channels.find((channel) => channel.key === agentId);
    if (ch === undefined || ch.finished || ch.key === MAIN_AGENT_ID) return false;
    ch.finished = true;
    return true;
  }

  /**
   * Expand or collapse the folded `+N done` group. Collapsed by default: the
   * point of folding is that a fan-out of finished agents costs one tab, and
   * expanding is the opt-in for when the user wants to pick one of them.
   */
  setFinishedExpanded(expanded: boolean): void {
    this.finishedExpanded = expanded;
  }

  isFinishedExpanded(): boolean {
    return this.finishedExpanded;
  }

  /**
   * Mouse handling: the wheel scrolls the current update, and a click on the top
   * border acts on the tab under the cursor.
   *
   * Returning `handled` matters for the wheel: without it the alt-screen routes
   * the wheel to the primary scroll view (the transcript), so scrolling over the
   * box would move the conversation instead of the update the user is pointing at.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.channels.length === 0) return undefined;

    if (event.type === 'wheel') {
      // Direction comes only from `wheelDelta` (the button field has no wheel
      // value); a positive delta scrolls toward later rows.
      const delta = event.wheelDelta ?? 0;
      if (delta === 0) return undefined;
      // Browse without taking the keyboard: the wheel is not `Ctrl+N`, and
      // grabbing focus would swallow the user's next keystroke into the panel.
      this.scrollBy(delta);
      // Always consume: letting the transcript take over mid-read would scroll
      // the conversation out from under the box the pointer is resting on.
      return { handled: true };
    }

    // Only `click`, never `press`: the alt-screen establishes a candidate target
    // on press and emits `click` on release when the pointer did not move, so
    // acting on both would toggle twice per click — and for the `+N done` toggle
    // that cancels out, making a single click do nothing at all.
    if (event.type !== 'click' || event.button !== 'left') return undefined;

    // Row 1 is the top border: row 0 is the blank spacer the panel renders above
    // the box, and the layout counts it (see `measureHeight`). The tab strip is
    // embedded in that border, starting one column in for the corner.
    //
    // Anything else is left unhandled on purpose: `GutterContainer` turns an
    // unhandled click into the fold toggle, so clicking the body folds and
    // unfolds the box exactly like clicking a tool card does.
    if (event.y !== 1) return undefined;
    const key = this.tabKeyAt(event.x);
    if (key === undefined) return undefined;

    if (key === null) {
      // The `+N done` aggregate: toggle the folded channels open/closed.
      this.finishedExpanded = !this.finishedExpanded;
      return { handled: true, render: true };
    }
    this.switchToChannel(key);
    return { handled: true, render: true };
  }

  /** Channel key under `column`, `null` for the aggregate tab, `undefined` for none. */
  private tabKeyAt(column: number): string | null | undefined {
    for (const range of this.tabHitRanges) {
      if (column >= range.from && column < range.to) return range.key ?? null;
    }
    return undefined;
  }

  /** Make `key` the channel on display, landing on its newest entry. */
  private switchToChannel(key: string): boolean {
    const ch = this.channels.find((channel) => channel.key === key);
    if (ch === undefined || ch.key === this.activeKey) return false;
    this.activeKey = ch.key;
    ch.page = ch.entries.length - 1;
    ch.scroll = 0;
    ch.unreadIds.clear();
    return true;
  }

  remove(id: string): boolean {
    const ch = this.channels.find((channel) => channel.entries.some((entry) => entry.id === id));
    if (ch === undefined) return false;
    const index = ch.entries.findIndex((entry) => entry.id === id);
    ch.entries.splice(index, 1);
    if (ch.entries.length === 0) {
      this.channels.splice(this.channels.indexOf(ch), 1);
      if (ch.key === this.activeKey) this.activeKey = this.channels.at(-1)?.key ?? MAIN_AGENT_ID;
    } else {
      ch.page = Math.min(ch.page, ch.entries.length - 1);
      ch.scroll = 0;
      ch.unreadIds.delete(id);
    }
    if (this.channels.length === 0) this.focused = false;
    return true;
  }

  clear(): void {
    this.channels.length = 0;
    this.activeKey = MAIN_AGENT_ID;
    this.focused = false;
    this.ended = false;
    this.collapsed = false;
  }

  isEmpty(): boolean {
    return this.channels.length === 0;
  }

  getChannels(): readonly NotifyChannelView[] {
    return this.channels.map((ch) => ({
      label: ch.label,
      entries: ch.entries.map((entry) => ({ id: entry.id, text: entry.text })),
      unread: ch.unreadIds.size,
    }));
  }

  /** Every entry across channels, in display order (main first, then arrival). */
  getEntries(): readonly NotifyEntry[] {
    return this.channels.flatMap((ch) => ch.entries);
  }

  /**
   * The turn that produced these updates has ended: dim the title and fold
   * the box down to a one-line stub so the final reply owns the screen. A
   * focused user keeps reading — the fold lands when they blur.
   */
  setEnded(ended: boolean): void {
    this.ended = ended;
    if (ended && !this.focused) this.collapsed = true;
    if (!ended) this.collapsed = false;
  }

  /** Grab keyboard paging for the box; returns false when there is nothing to read. */
  focus(): boolean {
    if (this.channels.length === 0) return false;
    this.focused = true;
    this.collapsed = false;
    this.activeChannel().unreadIds.clear();
    return true;
  }

  blur(): boolean {
    if (!this.focused) return false;
    this.focused = false;
    if (this.ended) this.collapsed = true;
    // A browsing offset is left alone: focus and follow are separate concerns,
    // and losing focus (esc) should not throw away where the user was reading.
    return true;
  }

  isFocused(): boolean {
    return this.focused;
  }

  /** Older channel (`←`), landing on its latest update; false on the leftmost tab. */
  prevChannel(): boolean {
    const index = this.activeIndex();
    if (index <= 0) return false;
    this.activeKey = this.channels[index - 1]!.key;
    const ch = this.activeChannel();
    ch.page = ch.entries.length - 1;
    ch.scroll = 0;
    ch.followTail = true;
    ch.unreadIds.clear();
    return true;
  }

  /** Newer channel (`→`), landing on its latest update; false on the rightmost tab. */
  nextChannel(): boolean {
    const index = this.activeIndex();
    if (index >= this.channels.length - 1) return false;
    this.activeKey = this.channels[index + 1]!.key;
    const ch = this.activeChannel();
    ch.page = ch.entries.length - 1;
    ch.scroll = 0;
    ch.followTail = true;
    ch.unreadIds.clear();
    return true;
  }

  /** Older update in the current channel (`PgUp` / `[`); false on the first. */
  prevPage(): boolean {
    if (this.channels.length === 0) return false;
    const ch = this.activeChannel();
    if (ch.page <= 0) return false;
    ch.page -= 1;
    ch.scroll = 0;
    ch.followTail = true;
    return true;
  }

  /** Newer update in the current channel (`PgDn` / `]`); false on the latest. */
  nextPage(): boolean {
    if (this.channels.length === 0) return false;
    const ch = this.activeChannel();
    if (ch.page >= ch.entries.length - 1) return false;
    ch.page += 1;
    ch.scroll = 0;
    ch.followTail = true;
    return true;
  }

  /**
   * Scroll the displayed update by `delta` rows; false when it cannot move.
   *
   * The clamp needs the entry's full rendered height, which only a render knows.
   * `render()` records it, but a caller can legitimately scroll before the first
   * paint (tests, or a key arriving in the same tick as the entry), so the entry
   * is measured directly when no paint has happened yet.
   */
  scrollBy(delta: number): boolean {
    if (this.channels.length === 0) return false;
    const ch = this.activeChannel();
    const height = this.lastBodyHeight > 0 ? this.lastBodyHeight : this.measureBodyHeight(ch);
    this.lastBodyHeight = height;
    const max = Math.max(0, height - Math.max(MIN_BODY_ROWS, this.bodyBudget()));
    // Scrolling from the tail starts at the bottom, since `render` pinned the
    // offset there and a bare `scroll` field would be stale.
    const current = ch.followTail ? max : ch.scroll;
    const next = Math.max(0, Math.min(max, current + delta));
    ch.followTail = next === max;
    if (next === ch.scroll && ch.followTail) return false;
    ch.scroll = next;
    return true;
  }

  /** Body rows the displayed entry needs at the current width, unwrapped. */
  private measureBodyHeight(ch: NotifyChannel, width = this.lastWidth): number {
    const entry = ch.entries[Math.min(ch.page, ch.entries.length - 1)];
    if (entry === undefined) return 0;
    return new Markdown(
      entry.text.trim(),
      0,
      0,
      createMarkdownTheme(),
      undefined,
      createMarkdownOptions(),
    ).render(Math.max(1, width - 6)).length;
  }

  /** Rows of the displayed update currently out of view, for the title hint. */
  hiddenRows(): number {
    return Math.max(0, this.lastBodyHeight - Math.max(MIN_BODY_ROWS, this.bodyBudget()));
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.channels.length === 0) return [];
    const c = currentTheme.palette;
    const paint = chalk.hex(this.focused ? c.primary : c.border);

    if (this.mustCollapse()) {
      return ['', this.stubLine(width)].map((line) => truncateToWidth(line, width));
    }

    const innerWidth = Math.max(1, width - 6);
    const ch = this.activeChannel();
    const entry = ch.entries[Math.min(ch.page, ch.entries.length - 1)]!;
    const bodyRows = new Markdown(
      entry.text.trim(),
      0,
      0,
      createMarkdownTheme(),
      undefined,
      createMarkdownOptions(),
    ).render(innerWidth);

    // Record the entry's full height and width so `scrollBy` can clamp against
    // it: the rendered window is the only place the real height is known.
    this.lastBodyHeight = bodyRows.length;
    this.lastWidth = width;
    const budget = Math.max(MIN_BODY_ROWS, this.bodyBudget());
    const maxScroll = Math.max(0, bodyRows.length - budget);
    // A following view pins to the newest rows; a browsing one keeps its offset
    // clamped to the content. Focus is deliberately not consulted: the wheel can
    // scroll the box without taking the keyboard, so "is the user reading the
    // tail" is its own piece of state (`followTail`), not a focus consequence.
    if (ch.followTail) ch.scroll = maxScroll;
    else if (ch.scroll > maxScroll) ch.scroll = maxScroll;
    const windowRows = bodyRows.slice(ch.scroll, ch.scroll + budget);

    const padRow = (row: string): string => `   ${padToVisibleWidth(row, width - 6)}   `;
    const emptyRow = ' '.repeat(width);
    const lines: string[] = ['─'.repeat(width), emptyRow];
    for (const row of windowRows) {
      lines.push(padRow(row));
    }
    lines.push(emptyRow, '─'.repeat(width));

    const boxed = wrapWithSideBorders(lines, paint, { label: this.title(width) });
    return ['', ...boxed].map((line) => truncateToWidth(line, width));
  }

  private channelFor(entry: NotifyEntry): NotifyChannel {
    const key = entry.agentId;
    const found = this.channels.find((ch) => ch.key === key);
    if (found !== undefined) return found;
    const created: NotifyChannel = {
      key,
      label: this.labelFor(entry.agentName ?? key),
      entries: [],
      page: 0,
      scroll: 0,
      followTail: true,
      unreadIds: new Set(),
      finished: false,
    };
    if (key === MAIN_AGENT_ID) this.channels.unshift(created);
    else this.channels.push(created);
    return created;
  }

  /** Dedup identical labels as `explore`, `explore(2)`, `explore(3)`, … */
  private labelFor(base: string): string {
    if (!this.channels.some((ch) => ch.label === base)) return base;
    let n = 2;
    while (this.channels.some((ch) => ch.label === `${base}(${String(n)})`)) n += 1;
    return `${base}(${String(n)})`;
  }

  private activeIndex(): number {
    const index = this.channels.findIndex((ch) => ch.key === this.activeKey);
    return Math.max(0, index);
  }

  private activeChannel(): NotifyChannel {
    return this.channels[this.activeIndex()]!;
  }

  /**
   * The collapsed one-liner: an expand hint marker, the channel tabs, the
   * total update count, and a preview of the current entry's first line —
   * everything the user needs to decide whether to open the box.
   */
  private stubLine(width: number): string {
    const c = currentTheme.palette;
    const dim = chalk.hex(c.textDim);
    const marker = chalk.hex(c.primary)('▸');
    const tabs = this.tabStrip().tabs.join(dim(' · '));
    const total = this.channels.reduce((sum, ch) => sum + ch.entries.length, 0);
    const noun = total === 1 ? 'update' : 'updates';
    const head = ` ${marker} ${tabs} ${dim(`· ${String(total)} ${noun}`)}`;
    const tail = ` ${dim('· ctrl+n')}`;
    const preview = this.stubPreviewText();
    if (preview !== undefined) {
      const budget = width - visibleWidth(head) - visibleWidth(tail) - 3;
      if (budget >= 12)
        return `${head} ${dim('·')} ${dim(truncateToWidth(preview, budget))}${tail}`;
    }
    if (visibleWidth(head) + visibleWidth(tail) <= width) return `${head}${tail}`;
    return ` ${marker} ${dim(`${String(total)} ${noun} · ctrl+n`)}`;
  }

  /** First non-empty line of the current entry, stripped of list/bold markers. */
  private stubPreviewText(): string | undefined {
    const ch = this.activeChannel();
    const entry = ch.entries[Math.min(ch.page, ch.entries.length - 1)];
    if (entry === undefined) return undefined;
    const firstLine = entry.text
      .trim()
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim()
      .replace(/^[-*#>\s]+/, '')
      .replaceAll('**', '');
    return firstLine === undefined || firstLine.length === 0 ? undefined : firstLine;
  }

  /**
   * The styled top-border label: a tab strip of channel labels (active tab
   * highlighted, background channels with unread dotted), then the page
   * indicator and key hints, slimmed down progressively as width shrinks.
   */
  private title(width: number): string | undefined {
    const c = currentTheme.palette;
    const ch = this.activeChannel();
    const page = `${String(ch.page + 1)}/${String(ch.entries.length)}`;
    const state = this.ended ? ` · ${t('tui.messages.notifyPanelTurnEnded')}` : '';
    const hidden = this.hiddenRows();
    const more = hidden > 0 ? ` · +${String(hidden)} lines` : '';
    const hint = this.focused
      ? ` · ${t('tui.messages.notifyPanelHintFocused')}`
      : ` · ${t('tui.messages.notifyPanelHintUnfocused')}`;
    const paintTitle = this.ended ? chalk.hex(c.textDim).bold : chalk.hex(c.primary).bold;
    const tabs = this.tabStrip().tabs.join(chalk.hex(c.textDim)(' · '));
    // Degrade in order of what a reader needs least. The channel tabs go last
    // but one: they carry the unread dots, so dropping them before the hints
    // would hide the only signal that another agent has posted.
    const byTabStrip = [` · Updates ${page}`, ` · Updates ${page}${state}`];
    const candidates = [
      ` ${tabs}${byTabStrip[1]}${more}${hint} `,
      ` ${tabs}${byTabStrip[1]}${hint} `,
      ` ${tabs}${byTabStrip[0]}${more} `,
      ` ${tabs}${byTabStrip[0]} `,
      ` ${ch.label}${byTabStrip[1]} `,
      ` ${ch.label}${byTabStrip[0]} `,
    ];
    for (const candidate of candidates) {
      if (visibleWidth(candidate) <= width - 4) return paintTitle(candidate);
    }
    return undefined;
  }

  /**
   * The tab strip: one tab per channel that still deserves its own, plus a
   * single `+N done` tab folding the finished ones.
   *
   * Live channels keep individual tabs, because "which agent is telling me
   * something right now" is the question the strip answers. Finished channels
   * do not: five completed subagents would otherwise push the strip past the
   * width budget, at which point `title()` drops the strip entirely and the
   * user loses the ability to navigate at all. The active channel always keeps
   * its own tab, even when finished, so the current position stays visible.
   *
   * Returns `undefined` when folding applies and the caller asked for the
   * names, so a caller can decide how to phrase the aggregate tab.
   */
  private tabStrip(): { tabs: string[]; finishedCount: number } {
    const live: NotifyChannel[] = [];
    let finishedCount = 0;
    for (const ch of this.channels) {
      const keepsOwnTab = !ch.finished || ch.key === this.activeKey || this.finishedExpanded;
      if (keepsOwnTab) live.push(ch);
      else finishedCount += 1;
    }
    // Record the clickable span of every tab. The strip is joined with ` · ` and
    // embedded into the border one column in for the corner, so the running
    // visible width is the column where the next tab starts.
    const ranges: TabHitRange[] = [];
    const tabs: string[] = [];
    let column = 1;
    for (const ch of live) {
      const tab = this.renderTab(ch, ch.key === this.activeKey);
      const width = visibleWidth(tab);
      ranges.push({ from: column, to: column + width, key: ch.key });
      tabs.push(tab);
      column += width + 3;
    }
    // The aggregate tab stays on the strip in both states: folded it counts what
    // is hidden, expanded it offers the way back. Dropping it when expanded left
    // the group with no visible way to fold again.
    const aggregateCount = this.finishedCount();
    if (aggregateCount > 0) {
      const tab = this.finishedTab(aggregateCount);
      // `tabs` includes the aggregate so callers just join: building it again at
      // the call site is how the expanded state lost its way back to folded.
      ranges.push({ from: column, to: column + visibleWidth(tab), key: undefined });
      tabs.push(tab);
    }
    this.tabHitRanges = ranges;
    return { tabs, finishedCount };
  }

  /**
   * The aggregate tab, dimmed. Folded it reads `+N done` (these are hidden);
   * expanded it reads `−N done` (click to fold them again).
   */
  private finishedTab(count: number): string {
    return chalk.hex(currentTheme.palette.textDim)(
      this.finishedExpanded
        ? t('tui.messages.notifyPanelFinishedExpandedTab', { count })
        : t('tui.messages.notifyPanelFinishedTab', { count }),
    );
  }

  /**
   * How many finished channels the aggregate tab stands for — the same set the
   * strip folds, whether it is currently folded or expanded.
   */
  private finishedCount(): number {
    return this.channels.filter((ch) => ch.finished && ch.key !== this.activeKey).length;
  }

  private renderTab(channel: NotifyChannel, active: boolean): string {
    const c = currentTheme.palette;
    if (active) return chalk.hex(c.primary).bold(channel.label);
    const label = channel.unreadIds.size > 0 ? `${channel.label}●` : channel.label;
    return channel.unreadIds.size > 0 ? chalk.hex(c.primary)(label) : chalk.hex(c.textDim)(label);
  }
}
