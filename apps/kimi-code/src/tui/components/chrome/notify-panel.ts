/**
 * NotifyPanel — mid-turn updates, drawn as content rows inside the status
 * surface's frame, below the Todo panel.
 *
 * Updates are grouped into CHANNELS, one per agent: the main agent plus one
 * channel per subagent that posts a `NotifyUser` update. The panel's first row
 * is a tab strip of channel labels (the surface draws the frame around it);
 * `Ctrl+N` focuses the panel, then `←`/`→` switch channels, `↑`/`↓` scroll the
 * current update, and `[`/`]` step between updates in the channel. While the
 * user is not focused, the view follows the latest activity across channels;
 * while focused it stays put and other channels collect an unread dot.
 *
 * The mouse works too: the wheel over the panel scrolls the current update (and
 * does not fall through to the transcript) without needing a click first, and
 * clicking a channel tab switches to it. A click anywhere else folds or unfolds
 * the box (the surface's fallback); it deliberately does **not** take the
 * keyboard, which stays on `Ctrl+N`.
 *
 * The panel is capped at {@link MAX_VISIBLE_ROWS} rows and at half the terminal
 * height, whichever is smaller — an update body can be arbitrarily long, and
 * without a cap the panel grew until the editor and footer were pushed off
 * screen. Inside the status surface the host's granted budget wins over both
 * caps. Content beyond the cap scrolls; the header row carries how much is out
 * of view. When the turn ends the panel folds to a one-line stub until the user
 * focuses it; the host clears it when the next turn starts.
 *
 * A newly arrived update is read from its **top**: the panel then walks that
 * entry downward on its own timer, stopping at the end, until the next update
 * restarts the walk (see {@link NotifyPanelComponent.upsert}). Following the
 * tail outright showed the end of a long update before its beginning. Scrolling
 * by hand — wheel, arrows or paging — cancels the walk immediately.
 */

import type { Component, TuiMouseEvent, TuiMouseEventResult } from '@moonshot-ai/pi-tui';
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { t } from '#/i18n';
import { NOTIFY_AUTOSCROLL_INTERVAL_MS } from '#/tui/constant/rendering';
import { Markdown } from '#/tui/components/markdown/markdown';
import { MAIN_AGENT_ID } from '#/tui/constant/kimi-tui';
import { currentTheme, type ColorPalette } from '#/tui/theme';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import {
  createMarkdownOptions,
  getMarkdownMermaidMode,
  type MermaidRenderMode,
} from '#/tui/utils/markdown-options';

export interface NotifyEntry {
  readonly id: string;
  readonly agentId: string;
  readonly agentName?: string;
  readonly time: number;
  /** One-line headline of the update; absent for updates posted without one. */
  readonly title?: string;
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
  /**
   * Rows the view advances by itself to read the entry through, `0` when the
   * view is not auto-advancing. A fresh update starts at its top and walks down
   * on a timer: the whole entry is usually longer than the box, and showing its
   * end while the opening lines were never on screen is reading a message
   * backwards. Wheel, paging or a new entry clears this — the user's own
   * position always wins over the animation.
   */
  autoAdvance: boolean;
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
 * Hard ceiling on the panel's own rows while it is mounted standalone: the
 * header row included. Matches the fixed-cap convention the todo panel uses
 * (`MAX_VISIBLE`), so both panels in the shared row behave the same way. The
 * terminal half-height cap below is the smaller of the two on a short
 * terminal, and a budget granted by the status surface wins over both.
 */
export const MAX_VISIBLE_ROWS = 12;
/**
 * Rows the panel always spends regardless of content: the header row that
 * carries the tab strip, the page indicator and the key hints. A budget that
 * covers only the body therefore overflows by this much — the cap has to be
 * expressed in total rows and the overhead subtracted from it. The strip's
 * frame belongs to the status surface and is not counted here.
 *
 * Exported so the region can state the height below which the box is a stub
 * (`{@link PANEL_OVERHEAD_ROWS} + {@link MIN_BODY_ROWS}`) instead of keeping a
 * second copy of the sum in step by hand.
 */
export const PANEL_OVERHEAD_ROWS = 1;
/** Body rows below which the box stops drawing a body and degrades to a stub. */
export const MIN_BODY_ROWS = 1;

/** Rows the terminal currently has; the host wires the real reader in. */
export type TerminalRowsProvider = () => number | undefined;

/**
 * A clickable span on the header row's tab strip.
 *
 * The tab strip is the panel's first content row, so a click arrives as a
 * column in that row. The render pass knows each tab's columns; this records
 * them for the next `handleMouse`, which has no other way to map a column back
 * to a channel.
 */
interface TabHitRange {
  readonly from: number;
  readonly to: number;
  /** Channel key, or `undefined` for the `+N done` aggregate tab. */
  readonly key: string | undefined;
}

/**
 * One entry's rendered body and the inputs it was rendered from.
 *
 * The key is deliberately wider than `(text, width)`. The rows carry ANSI
 * colours and the structure the Markdown options select, and none of those
 * changes reaches the box as an invalidation — the status surface forwards
 * `invalidate()` to its regions and the updates region does not implement one —
 * so a key that stopped at the text and the width would keep painting the
 * palette of a scheme the user has already left.
 */
interface RenderedBodyCache {
  readonly text: string;
  readonly renderWidth: number;
  readonly palette: ColorPalette;
  readonly latex: boolean | undefined;
  readonly mermaid: MermaidRenderMode;
  readonly rows: string[];
}

/**
 * The share of the terminal a standalone box may claim: half the screen, never
 * more than `cap`, and never zero. Used when no host granted an explicit budget.
 */
function terminalShare(rows: number | undefined, cap: number): number {
  if (rows === undefined || !Number.isFinite(rows) || rows <= 0) return cap;
  return Math.max(1, Math.min(cap, Math.floor(rows / 2)));
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
  /**
   * Body rows the last layout may actually draw: the host's granted budget
   * when there is one, the box's own cap otherwise. Recorded so
   * {@link hasHiddenContent} can answer the fold contract after unfolding —
   * the box is clipping its body, so a click must be able to close it again.
   */
  private lastGrantedBodyBudget = 0;
  /**
   * The viewed entry's rendered body, shared by the two passes of one frame:
   * the surface's height measurement and the paint that follows it both need
   * the same rows, and each used to build its own `Markdown` and parse the same
   * text, so a frame lexed and re-wrapped every line twice.
   */
  private lastBody: RenderedBodyCache | undefined;
  /** Clickable spans of the top border, refreshed by every `title()` call. */
  private tabHitRanges: TabHitRange[] = [];
  /** `+N done` expanded into individual tabs (mouse toggle). */
  private finishedExpanded = false;
  /** Drives the auto-advance while a fresh update is being read through. */
  private autoScrollTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * `requestRender` for the auto-advance timer; the host passes `ui.requestRender`.
   * Without it the panel simply never self-advances, which is what a standalone
   * mount in a test wants.
   */
  constructor(
    private readonly terminalRows: TerminalRowsProvider = () => undefined,
    private readonly requestRender?: () => void,
  ) {}

  /**
   * Total rows the status surface granted this box, or `undefined` while the
   * box is mounted standalone. The surface sets it before each paint, so the
   * strip has one height authority instead of every panel reading the terminal
   * and hoping the others agree.
   */
  private budget: number | undefined;

  /** Set the row budget granted by the host; `undefined` restores standalone sizing. */
  setBudget(rows: number | undefined): void {
    this.budget = rows;
  }

  /**
   * Body rows a render may occupy.
   *
   * The cap is a **total**-row budget, because that is what the terminal cares
   * about: {@link MAX_VISIBLE_ROWS} total, or half the terminal, whichever is
   * smaller, minus {@link PANEL_OVERHEAD_ROWS}. Expressing it as "body rows"
   * without the subtraction is what let a 6-row terminal get an 8-row panel.
   *
   * Below {@link MIN_BODY_ROWS} there is no room for a body, so the panel
   * degrades to the one-line stub instead of rendering more rows than its
   * budget. An unknown terminal height still gets the fixed ceiling — the cap
   * must not disappear just because the host did not supply a row count.
   */
  private bodyBudget(): number {
    if (this.budget !== undefined) return this.budget - PANEL_OVERHEAD_ROWS;
    return terminalShare(this.terminalRows(), MAX_VISIBLE_ROWS) - PANEL_OVERHEAD_ROWS;
  }

  /**
   * Rows the box would like at this width, for the surface's budget pass.
   *
   * Pure layout: the measurement answers the surface's question and stops
   * there. It used to render a full paint pass, which also ran the render's
   * state writes — measuring at the box's own cap (a larger budget than the
   * surface later grants) pinned a following view to a tail the real paint
   * then scrolled away, so a layout pass skipped the unread middle of an
   * update. The stub is one row, and below {@link MIN_BODY_ROWS} of body there
   * is nothing but the stub to measure.
   */
  measureHeight(width: number): number {
    if (this.channels.length === 0) return 0;
    // Measured at the box's own cap, not at the budget the host granted last
    // frame: the surface is asking what the box would draw if it had the rows,
    // and answering from a stale grant would under-report the height it needs.
    // Clearing the budget is also what decides `mustCollapse` here — a box that
    // only looks like a stub because a short strip squeezed it still measures
    // its real height. Nothing but the layout runs: no `scroll`, `followTail`
    // or `autoAdvance` write, so a measurement cannot move the reader.
    const granted = this.budget;
    this.budget = undefined;
    try {
      if (this.mustCollapse()) return 1;
      const layout = this.layoutBody(width);
      return 1 + Math.min(layout.bodyRows.length, layout.budget);
    } finally {
      this.budget = granted;
    }
  }

  /** True when there is not enough height for a box, so a stub is all we draw. */
  private mustCollapse(): boolean {
    return this.collapsed || this.bodyBudget() < MIN_BODY_ROWS;
  }

  /**
   * Add or update an entry in a channel. A repeated `id` updates the entry in
   * place; a new id appends.
   *
   * A fresh entry is read from its **top** and then walked down by the
   * auto-advance timer ({@link NOTIFY_AUTOSCROLL_INTERVAL_MS}), so a long update
   * is read in the order it was written instead of opening on its last lines.
   * An entry that changes in place is left alone: it is either already on
   * screen (the reader is where they are) or it is not the displayed one.
   *
   * While unfocused the view jumps to the entry's channel; while focused the
   * user's page stays put and background channels collect unread instead. A
   * reader who scrolled away from the tail keeps their place either way — the
   * whole point of not stealing focus is that the pointer and the keyboard do
   * not fight over the window.
   */
  upsert(entry: NotifyEntry): void {
    const ch = this.channelFor(entry);
    const existing = ch.entries.find((item) => item.id === entry.id);
    const isNew = existing === undefined;
    if (existing !== undefined) ch.entries[ch.entries.indexOf(existing)] = entry;
    else ch.entries.push(entry);
    if (!this.focused) {
      this.activeKey = ch.key;
      // "Following" spans two states now: pinned to the tail (`followTail`), or
      // walking down an entry the reader has not taken over yet (`autoAdvance`).
      // Both mean the newest activity wins; a reader who scrolled by hand is in
      // neither, and yanking their window on every update would lose their
      // place — the whole point of not stealing focus.
      if (ch.followTail || ch.autoAdvance) {
        ch.page = ch.entries.length - 1;
        if (isNew) {
          // A new entry opens at its top and is walked down; showing its last
          // lines before its first ones is reading the update backwards.
          ch.scroll = 0;
          ch.followTail = false;
          ch.autoAdvance = true;
        } else {
          // An edit to the entry already being read keeps the reader's row and
          // does not restart the walk, which would rewind them mid-read.
          ch.autoAdvance = false;
        }
      }
      ch.unreadIds.clear();
    } else if (isNew && ch.key !== this.activeKey) {
      ch.unreadIds.add(entry.id);
    }
    this.ended = false;
    this.collapsed = false;
    this.syncAutoScrollTimer();
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
   * Whether unfolding right now would reveal rows that are not on screen.
   *
   * The surface's only fold predicate, so the answer has to hold in both
   * directions: folded, the body is entirely hidden; expanded, it stays true
   * while the granted budget still clips the body — otherwise the box could be
   * opened but never closed, and a click on an expanded box did nothing at all.
   * The approval region answers the same contract the same way, by comparing
   * the rows it painted against the rows it was granted.
   *
   * Before the first paint there is nothing on screen either way, so an empty
   * box (and one whose entry fits) stays inert rather than claiming a fold.
   */
  hasHiddenContent(): boolean {
    if (this.channels.length === 0) return false;
    if (this.collapsed) return true;
    return this.lastBodyHeight > this.lastGrantedBodyBudget;
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

    // Row 0 is the header row that carries the tab strip — the surface draws
    // the frame above it, and the panel's own rows start at the strip.
    //
    // Anything else is left unhandled on purpose: `GutterContainer` turns an
    // unhandled click into the fold toggle, so clicking the body folds and
    // unfolds the panel exactly like clicking a tool card does.
    if (event.y !== 0) return undefined;
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
    this.syncAutoScrollTimer();
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
      ch.autoAdvance = false;
      ch.unreadIds.delete(id);
    }
    if (this.channels.length === 0) this.focused = false;
    this.syncAutoScrollTimer();
    return true;
  }

  clear(): void {
    this.channels.length = 0;
    this.activeKey = MAIN_AGENT_ID;
    this.focused = false;
    this.ended = false;
    this.collapsed = false;
    this.stopAutoScroll();
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
    // The keyboard is the reader taking over: stop the walk-through so their
    // first arrow key starts from what is on screen instead of fighting a timer.
    this.activeChannel().autoAdvance = false;
    this.syncAutoScrollTimer();
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
    ch.autoAdvance = false;
    ch.unreadIds.clear();
    this.syncAutoScrollTimer();
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
    ch.autoAdvance = false;
    ch.unreadIds.clear();
    this.syncAutoScrollTimer();
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
    ch.autoAdvance = false;
    this.syncAutoScrollTimer();
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
    ch.autoAdvance = false;
    this.syncAutoScrollTimer();
    return true;
  }

  /**
   * Scroll the displayed update by `delta` rows; false when it cannot move.
   *
   * The clamp needs the entry's full rendered height, which only a render knows.
   * `render()` records it, but a caller can legitimately scroll before the first
   * paint (tests, or a key arriving in the same tick as the entry), so the entry
   * is measured directly when no paint has happened yet.
   *
   * A following view starts from the tail, not from its stale `scroll` field:
   * the render pinned the offset there, so a wheel-up has to walk back from the
   * bottom. Reading `scroll` instead made the first wheel-up a no-op — it
   * computed the same tail offset the render had already pinned, reported "no
   * move", and swallowed the event. That is why the box looked like it needed a
   * click first: only after focus (which clears following) did the wheel do
   * anything.
   */
  scrollBy(delta: number): boolean {
    if (this.channels.length === 0) return false;
    const ch = this.activeChannel();
    const height = this.lastBodyHeight > 0 ? this.lastBodyHeight : this.measureBodyHeight(ch);
    this.lastBodyHeight = height;
    const max = Math.max(0, height - Math.max(MIN_BODY_ROWS, this.bodyBudget()));
    const current = ch.followTail ? max : ch.scroll;
    const next = Math.max(0, Math.min(max, current + delta));
    // The reader has taken over: their wheel position outranks the walk-through
    // timer, and cancelling here (not in the caller) covers the keyboard too.
    ch.autoAdvance = false;
    this.syncAutoScrollTimer();
    if (next === current) {
      // Already at the requested edge: nothing moves, and following stays as it
      // is — scrolling further down at the tail must not report a move.
      ch.followTail = current === max;
      ch.scroll = current;
      return false;
    }
    // Landing on the tail re-arms following; anywhere above it disarms.
    ch.scroll = next;
    ch.followTail = next === max;
    return true;
  }

  /**
   * Walk the displayed update one row further down, stopping at its end.
   *
   * This is what the periodic timer calls: the entry opens at its top and is
   * read downward at a readable pace. `false` means there was nothing left to
   * advance — the caller stops the timer, so a fully shown update does not keep
   * repainting the strip.
   */
  advanceAutoScroll(): boolean {
    if (this.channels.length === 0) return false;
    const ch = this.activeChannel();
    if (!ch.autoAdvance) return false;
    const height = this.lastBodyHeight > 0 ? this.lastBodyHeight : this.measureBodyHeight(ch);
    this.lastBodyHeight = height;
    const max = Math.max(0, height - Math.max(MIN_BODY_ROWS, this.bodyBudget()));
    const next = Math.min(max, ch.scroll + 1);
    if (next === ch.scroll) {
      // The whole entry is on screen (or the view was already at its end): the
      // walk is over and following takes back over, so later edits show up.
      ch.autoAdvance = false;
      ch.followTail = true;
      return false;
    }
    ch.scroll = next;
    ch.followTail = next === max;
    if (ch.followTail) ch.autoAdvance = false;
    return true;
  }

  /**
   * Start or stop the auto-advance timer to match the channels' state.
   *
   * One timer for the whole panel rather than one per channel: only the channel
   * on display can be advancing, and a per-channel timer would keep ticking for
   * a view nobody is looking at.
   */
  private syncAutoScrollTimer(): void {
    const advancing = this.channels.some((ch) => ch.autoAdvance && ch.key === this.activeKey);
    if (!advancing) {
      this.stopAutoScroll();
      return;
    }
    if (this.requestRender === undefined || this.autoScrollTimer !== undefined) return;
    const requestRender = this.requestRender;
    this.autoScrollTimer = setInterval(() => {
      if (this.advanceAutoScroll()) requestRender();
      else this.stopAutoScroll();
    }, NOTIFY_AUTOSCROLL_INTERVAL_MS);
    if (typeof this.autoScrollTimer === 'object' && 'unref' in this.autoScrollTimer) {
      this.autoScrollTimer.unref();
    }
  }

  private stopAutoScroll(): void {
    if (this.autoScrollTimer === undefined) return;
    clearInterval(this.autoScrollTimer);
    this.autoScrollTimer = undefined;
  }

  /**
   * The displayed entry's rendered rows at `width`, or the ones already
   * rendered for exactly this input.
   *
   * A frame asks for the body twice — once for the surface's height
   * measurement, once for the paint that follows — and each call used to build
   * a `Markdown` and lex and wrap the same text again. Sharing the rows makes
   * the second ask free.
   *
   * `text` and `renderWidth` are the layout key; the palette and the two
   * Markdown options are in the key as well because they decide the colours and
   * the structure that the rows carry, and neither announces itself: the box is
   * never invalidated, so no hook would come along to drop a stale entry.
   */
  private bodyRows(entry: NotifyEntry, width: number): string[] {
    const trimmed = entry.text.trim();
    const renderWidth = Math.max(1, width - 6);
    const options = createMarkdownOptions();
    const mermaid = getMarkdownMermaidMode();
    const palette = currentTheme.palette;
    const cached = this.lastBody;
    if (
      entry.title === undefined &&
      cached !== undefined &&
      cached.text === trimmed &&
      cached.renderWidth === renderWidth &&
      cached.palette === palette &&
      cached.latex === options.renderLatex &&
      cached.mermaid === mermaid
    ) {
      return cached.rows;
    }
    const markdown = new Markdown(trimmed, 0, 0, createMarkdownTheme(), undefined, options);
    const bodyRows = markdown.render(renderWidth);
    const rows =
      entry.title === undefined
        ? bodyRows
        : [
            ...wrapTextWithAnsi(entry.title, renderWidth).map((row) =>
              chalk.hex(palette.textStrong).bold(row),
            ),
            '',
            ...bodyRows,
          ];
    this.lastBody = {
      text: trimmed,
      renderWidth,
      palette,
      latex: options.renderLatex,
      mermaid,
      rows,
    };
    return rows;
  }

  /** Body rows the displayed entry needs at the current width, unwrapped. */
  private measureBodyHeight(ch: NotifyChannel, width = this.lastWidth): number {
    const entry = ch.entries[Math.min(ch.page, ch.entries.length - 1)];
    if (entry === undefined) return 0;
    return this.bodyRows(entry, width).length;
  }

  /** Rows of the displayed update currently out of view, for the title hint. */
  hiddenRows(): number {
    return Math.max(0, this.lastBodyHeight - Math.max(MIN_BODY_ROWS, this.bodyBudget()));
  }

  invalidate(): void {}

  /**
   * The body layout at `width`: what the displayed entry renders to, and the
   * window a paint may draw from it.
   *
   * Pure layout, deliberately separated from `render`'s state writes. `scroll`,
   * `followTail` and `autoAdvance` describe what the *reader* has done, and a
   * measurement pass (the surface asking how many rows the box wants, at the
   * box's own cap rather than the smaller budget the surface then grants) is not
   * the reader: running those writes during a measurement pinned a following
   * view to a tail the next real paint scrolled away, so an update's unread
   * middle was skipped. `granted` records the budget only when the host granted
   * one; a measurement leaves the box at full height and must not look clipped.
   */
  private layoutBody(width: number): { bodyRows: string[]; budget: number; maxScroll: number } {
    const ch = this.activeChannel();
    const entry = ch.entries[Math.min(ch.page, ch.entries.length - 1)]!;
    const bodyRows = this.bodyRows(entry, width);

    // Record the entry's full height and width so `scrollBy` can clamp against
    // it: the rendered window is the only place the real height is known.
    this.lastBodyHeight = bodyRows.length;
    this.lastWidth = width;
    const budget = Math.max(MIN_BODY_ROWS, this.bodyBudget());
    // The rows this layout may actually draw: the host's grant when there is
    // one, the box's own cap otherwise. Recording it unconditionally is what
    // lets a standalone mount answer "is the body clipped?" too — the cap is
    // its clipping authority — and the surface's paint runs after its budget
    // pass, so the granted number is the one left behind.
    this.lastGrantedBodyBudget = budget;
    return { bodyRows, budget, maxScroll: Math.max(0, bodyRows.length - budget) };
  }

  render(width: number): string[] {
    if (this.channels.length === 0) return [];
    // The strip's frame belongs to the status surface, so the panel draws
    // content only: the tab strip that used to be the box's top border opens
    // the body as its own row.
    if (this.mustCollapse()) {
      return [this.stubLine(width)].map((line) => truncateToWidth(line, width));
    }

    const ch = this.activeChannel();
    const { bodyRows, budget, maxScroll } = this.layoutBody(width);
    // A following view pins to the newest rows; a browsing one keeps its offset
    // clamped to the content. Focus is deliberately not consulted: the wheel can
    // scroll the box without taking the keyboard, so "is the user reading the
    // tail" is its own piece of state (`followTail`), not a focus consequence.
    if (ch.followTail) ch.scroll = maxScroll;
    else if (ch.scroll > maxScroll) ch.scroll = maxScroll;
    // An auto-advancing view that has reached the end has nothing left to walk:
    // stop the timer here, since the render is where the real height is known.
    if (ch.autoAdvance && ch.scroll >= maxScroll) {
      ch.autoAdvance = false;
      ch.followTail = true;
      this.syncAutoScrollTimer();
    }
    const windowRows = bodyRows.slice(ch.scroll, ch.scroll + budget);

    const padRow = (row: string): string => `   ${padToVisibleWidth(row, width - 6)}   `;
    const lines: string[] = [this.headerRow(width)];
    for (const row of windowRows) {
      lines.push(padRow(row));
    }
    return lines.map((line) => truncateToWidth(line, width));
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
      autoAdvance: false,
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
    const head = ` ${marker} ${tabs} ${dim(
      `· ${t(
        total === 1 ? 'tui.messages.notifyPanelUpdateCount_one' : 'tui.messages.notifyPanelUpdateCount_other',
        { count: total },
      )}`,
    )}`;
    const tail = ` ${dim('· ctrl+n')}`;
    const preview = this.stubPreviewText();
    if (preview !== undefined) {
      const budget = width - visibleWidth(head) - visibleWidth(tail) - 3;
      if (budget >= 12)
        return `${head} ${dim('·')} ${dim(truncateToWidth(preview, budget))}${tail}`;
    }
    if (visibleWidth(head) + visibleWidth(tail) <= width) return `${head}${tail}`;
    const shortCount = t(
      total === 1 ? 'tui.messages.notifyPanelUpdateCount_one' : 'tui.messages.notifyPanelUpdateCount_other',
      { count: total },
    );
    return ` ${marker} ${dim(`${shortCount} · ctrl+n`)}`;
  }

  /** First non-empty line of the current entry, stripped of list/bold markers. */
  private stubPreviewText(): string | undefined {
    const ch = this.activeChannel();
    const entry = ch.entries[Math.min(ch.page, ch.entries.length - 1)];
    if (entry === undefined) return undefined;
    if (entry.title !== undefined) return entry.title;
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
   * The header row: the tab strip that used to be the box's top border. The
   * surface owns the frame, so the strip and its page and key hints are
   * content now — the same string `title()` builds, drawn as the first row.
   */
  private headerRow(width: number): string {
    return this.title(width) ?? '';
  }

  /**
   * The styled header: a tab strip of channel labels (active tab highlighted,
   * background channels with unread dotted), then the page indicator and key
   * hints, slimmed down progressively as width shrinks.
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
    const pageLabel = t('tui.messages.notifyPanelPage', { page });
    const byTabStrip = [` · ${pageLabel}`, ` · ${pageLabel}${state}`];
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
