/**
 * TranscriptNavigationController — keyboard-driven message navigation.
 *
 * Mirrors the opencode-style activity-feed interaction: while active, `j`/`k`
 * (or ↑/↓) move between expandable transcript blocks, `Enter` toggles the
 * focused block's expansion, and `Esc` exits. The focused block's header is
 * highlighted via the component's `setNavigated` hook, and the transcript
 * ScrollView scrolls the focused block into view.
 *
 * The controller is a pure coordinator: it owns the focus index and the
 * key handling, and delegates expansion/highlighting to the components.
 */

import { Key, decodeKittyPrintable, matchesKey, type Component } from '@moonshot-ai/pi-tui';

import type { TUIState } from '../tui-state';
import { CHROME_GUTTER } from '../constant/rendering';
import { AssistantMessageComponent } from '../components/messages/assistant-message';
import { GoalMarkerComponent } from '../components/messages/goal-markers';
import { ThinkingComponent } from '../components/messages/thinking';
import { ToolCallComponent } from '../components/messages/tool-call';
import { UserMessageComponent } from '../components/messages/user-message';

/** The slice of the host the navigation controller needs. */
export interface TranscriptNavHost {
  state: Pick<TUIState, 'transcriptContainer' | 'scrollView' | 'terminal' | 'ui'>;
}

/**
 * A transcript child the navigation mode can focus. Expandable blocks
 * (tool calls, thinking, goal markers) also expose `setExpanded`; plain
 * messages (user / assistant) are focusable but not expandable.
 */
export type NavigableTranscriptItem =
  | ToolCallComponent
  | ThinkingComponent
  | GoalMarkerComponent
  | UserMessageComponent
  | AssistantMessageComponent;

function toNavigableItem(component: Component): NavigableTranscriptItem | undefined {
  if (
    component instanceof ToolCallComponent ||
    component instanceof ThinkingComponent ||
    component instanceof GoalMarkerComponent ||
    component instanceof UserMessageComponent ||
    component instanceof AssistantMessageComponent
  ) {
    return component;
  }
  return undefined;
}

function isExpandable(
  item: NavigableTranscriptItem,
): item is ToolCallComponent | ThinkingComponent | GoalMarkerComponent {
  return (
    item instanceof ToolCallComponent ||
    item instanceof ThinkingComponent ||
    item instanceof GoalMarkerComponent
  );
}

export class TranscriptNavigationController {
  private active = false;
  private index = 0;
  private items: NavigableTranscriptItem[] = [];

  constructor(private readonly host: TranscriptNavHost) {}

  isActive(): boolean {
    return this.active;
  }

  /** Handle a key while navigation is active. Returns true when consumed. */
  handleKey(data: string): boolean {
    if (!this.active) return false;

    if (matchesKey(data, Key.escape)) {
      this.deactivate();
      return true;
    }
    if (matchesKey(data, Key.enter)) {
      this.toggleExpandFocused();
      return true;
    }
    if (matchesKey(data, Key.down)) {
      this.move(1);
      return true;
    }
    if (matchesKey(data, Key.up)) {
      this.move(-1);
      return true;
    }
    const printable = decodeKittyPrintable(data) ?? data;
    if (printable === 'j') {
      this.move(1);
      return true;
    }
    if (printable === 'k') {
      this.move(-1);
      return true;
    }
    return false;
  }

  toggle(): void {
    if (this.active) {
      this.deactivate();
    } else {
      this.activate();
    }
  }

  activate(): void {
    if (this.active) return;
    this.rebuildItems();
    if (this.items.length === 0) return;
    this.active = true;
    this.index = Math.min(this.index, this.items.length - 1);
    this.applyNavigated();
    this.scrollToFocused();
    this.host.state.ui.requestRender();
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.clearNavigated();
    this.host.state.ui.requestRender();
  }

  private move(delta: number): void {
    if (this.items.length === 0) return;
    this.clearNavigated();
    this.index = (this.index + delta + this.items.length) % this.items.length;
    this.applyNavigated();
    this.scrollToFocused();
    this.host.state.ui.requestRender();
  }

  private toggleExpandFocused(): void {
    const item = this.items[this.index];
    if (item === undefined || !isExpandable(item)) return;
    item.setExpanded(!item.isExpanded());
    this.host.state.ui.requestRender();
  }

  private rebuildItems(): void {
    this.items = [];
    for (const child of this.host.state.transcriptContainer.children) {
      const item = toNavigableItem(child);
      if (item !== undefined) this.items.push(item);
    }
  }

  private applyNavigated(): void {
    this.items.forEach((item, i) => item.setNavigated(i === this.index));
  }

  private clearNavigated(): void {
    for (const item of this.items) item.setNavigated(false);
  }

  private scrollToFocused(): void {
    const scrollView = this.host.state.scrollView;
    if (scrollView === undefined) return;
    const width = Math.max(1, this.host.state.terminal.columns - CHROME_GUTTER * 2);

    let start = 0;
    for (let i = 0; i < this.index; i++) {
      const item = this.items[i];
      if (item === undefined) continue;
      start += item.render(width).length;
    }
    const focused = this.items[this.index];
    if (focused === undefined) return;
    const height = focused.render(width).length;
    if (height <= 0) return;

    const viewport = scrollView.viewportHeight;
    const current = scrollView.scrollTop;
    if (start < current || start + height > current + viewport) {
      scrollView.scrollTo(start, { disableFollow: true });
    }
  }
}
