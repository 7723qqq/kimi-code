import type { Event } from '@moonshot-ai/kimi-code-sdk';

import {
  PromptOptimizerActivityLine,
  type PromptOptimizerPhase,
} from '../components/chrome/prompt-optimizer-activity-line';
import { MoonLoader } from '../components/chrome/moon-loader';
import { currentTheme } from '../theme';
import type { TUIState } from '../tui-state';

export interface PromptOptimizerActivityHost {
  readonly state: TUIState;
}

const TOOL_DETAIL_MAX_CHARS = 60;

/**
 * Owns the one-row live status shown above the input box while Ctrl+P runs.
 *
 * The row is mounted as its own child of `state.activityContainer` — the same
 * docked slot the main agent's spinner uses — but it never reads or writes the
 * fields that slot's normal occupant is derived from (`livePane.mode`,
 * `appState.streamingPhase`, `state.activitySpinner`). The controller that
 * rebuilds that occupant therefore cannot clear this row, and this row cannot
 * make the main flow look busy.
 *
 * The activity container is a `VStack`-managed dock slot with a ceiling; it
 * holds the main agent's pane plus, when present, this line. Putting the line in
 * the same container is what "above the input box, in the activity area" means
 * visually, while a separate component keeps the two lifecycles independent.
 */
export class PromptOptimizerActivityController {
  private readonly host: PromptOptimizerActivityHost;
  private line: PromptOptimizerActivityLine | undefined;
  private spinner: MoonLoader | undefined;

  constructor(host: PromptOptimizerActivityHost) {
    this.host = host;
  }

  get active(): boolean {
    return this.line !== undefined;
  }

  /**
   * Show the row, starting at the generic "rewriting" phase.
   *
   * Called before the request leaves the TUI so the row exists on the first
   * frame after Ctrl+P — waiting for the first engine event would leave a blank
   * slot, and the round-trip's first event can be hundreds of milliseconds out.
   */
  begin(): void {
    if (this.line !== undefined) return;
    const spinner = new MoonLoader(
      this.host.state.ui,
      'braille',
      (s) => currentTheme.fg('primary', s),
      '',
      this.host.state.renderClock,
    );
    spinner.start();
    const line = new PromptOptimizerActivityLine(spinner);
    line.setPhase({ kind: 'starting' });
    this.spinner = spinner;
    this.line = line;
    this.host.state.activityContainer.addChild(line);
    this.host.state.ui.requestRender();
  }

  setPhase(phase: PromptOptimizerPhase): void {
    this.line?.setPhase(phase);
    this.host.state.ui.requestRender();
  }

  /**
   * Feed one optimizer-agent event into the row.
   *
   * Only the three shapes that say what the run is *doing* are consumed: a step
   * start (the model is thinking), a tool call (which tool, and on what), and
   * the return to thinking once that call resolves. Result and delta events are
   * deliberately ignored — the row is a phase indicator, not a transcript.
   */
  applyEvent(event: Event): void {
    if (this.line === undefined) return;
    if (event.type === 'turn.step.started' || event.type === 'tool.result') {
      this.setPhase({ kind: 'thinking' });
      return;
    }
    if (event.type === 'tool.call.started') {
      this.setPhase({
        kind: 'tool',
        toolName: event.name,
        detail: toolDetail(event.args),
      });
      return;
    }
    if (event.type === 'assistant.delta') {
      this.setPhase({ kind: 'writing' });
    }
  }

  /** Remove the row and stop its spinner. Idempotent. */
  clear(): void {
    const line = this.line;
    if (line === undefined) return;
    this.line = undefined;
    // pi-tui's `Component` has no `remove()`; `Container.removeChild` is the
    // only removal API, so the DOM-flavoured rule does not apply here.
    // oxlint-disable-next-line eslint-plugin-unicorn/prefer-dom-node-remove
    this.host.state.activityContainer.removeChild(line);
    this.spinner?.stop();
    this.spinner = undefined;
    this.host.state.ui.requestRender();
  }
}

/**
 * The part of a tool call worth showing next to its name: the path for a read,
 * the pattern for a search. Anything longer is cut at the row's own width later,
 * so this only has to stop a whole file body from reaching the label.
 */
function toolDetail(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ['path', 'file_path', 'pattern', 'query']) {
    const value = record[key];
    if (typeof value !== 'string' || value.length === 0) continue;
    return value.length <= TOOL_DETAIL_MAX_CHARS
      ? value
      : `${value.slice(0, TOOL_DETAIL_MAX_CHARS)}…`;
  }
  return undefined;
}
