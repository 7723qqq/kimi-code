import { Spacer } from '@moonshot-ai/pi-tui';

import { MoonLoader, type SpinnerStyle } from '../components/chrome/moon-loader';
import { pickRandomWorkingTip } from '../components/chrome/working-tips';
import { ActivityPaneComponent, type ActivityPaneMode } from '../components/panes/activity-pane';
import { currentTheme } from '../theme';
import type { TUIState } from '../tui-state';
import type { StepRetryState } from '../types';
import { formatStepRetryDetail, formatStepRetryLabel } from '../utils/step-retry';
import type { SessionEventHandler } from './session-event-handler';

type EffectiveActivityPaneMode = ActivityPaneMode | 'idle' | 'session';
type LoadingTipKind = 'moon' | 'composing';

function loadingTipKind(mode: EffectiveActivityPaneMode): LoadingTipKind | undefined {
  if (mode === 'waiting' || mode === 'tool') return 'moon';
  if (mode === 'composing') return 'composing';
  return undefined;
}

function waitingSpinnerLabel(retry: StepRetryState | null): string {
  return retry === null ? '' : formatStepRetryLabel(retry);
}

/** Everything the activity-pane controller reads from the `KimiTUI` coordinator. */
export interface ActivityPaneHost {
  readonly state: TUIState;
  readonly sessionEventHandler: SessionEventHandler;
}

/**
 * Owns the right-side activity area: resolves the effective pane mode from
 * live-pane/app-state, mounts the matching spinner/tip pane, and keeps the
 * terminal progress indicator and the agent-swarm inline spinner in sync.
 */
export class ActivityPaneController {
  private readonly host: ActivityPaneHost;
  private lastActivityMode: string | undefined;
  private currentLoadingTip: { kind: LoadingTipKind; tip: string | undefined } | undefined =
    undefined;

  constructor(host: ActivityPaneHost) {
    this.host = host;
  }

  updateActivityPane(): void {
    const state = this.host.state;
    const effectiveMode = this.resolveActivityPaneMode();
    const tipKind = loadingTipKind(effectiveMode);
    // Pick a fresh loading tip when the loading kind changes. The same kind
    // covers waiting/tool (both moon spinners) and any intermediate thinking
    // phase, so a continuous burst of tool calls does not flip tips. Clear the
    // cache only when there is no loading UI at all.
    if (effectiveMode === 'idle' || effectiveMode === 'session' || effectiveMode === 'hidden') {
      this.currentLoadingTip = undefined;
    } else if (
      tipKind !== undefined &&
      (this.currentLoadingTip === undefined || this.currentLoadingTip.kind !== tipKind)
    ) {
      const previousTip = this.currentLoadingTip?.tip;
      this.currentLoadingTip = {
        kind: tipKind,
        tip: pickRandomWorkingTip(previousTip)?.text,
      };
    }
    this.syncTerminalProgress(this.shouldShowTerminalProgress(effectiveMode));
    const placeSpinnerInAgentSwarm = this.shouldPlaceActivitySpinnerInAgentSwarm(effectiveMode);
    // Carry the retry state in the mode key so an incoming/cleared
    // `turn.step.retrying` rebuilds the waiting pane with fresh label and
    // detail instead of hitting the cached-pane early return below.
    const retry = effectiveMode === 'waiting' ? state.appState.stepRetry : null;
    const retryKey =
      retry === null ? '' : `${formatStepRetryLabel(retry)}|${formatStepRetryDetail(retry)}`;
    const activityModeKey = `${effectiveMode}:${placeSpinnerInAgentSwarm ? 'swarm' : 'pane'}:${retryKey}`;

    if (
      activityModeKey === this.lastActivityMode &&
      (effectiveMode === 'waiting' ||
        effectiveMode === 'thinking' ||
        effectiveMode === 'composing' ||
        effectiveMode === 'tool')
    ) {
      if (placeSpinnerInAgentSwarm) {
        this.syncAgentSwarmActivitySpinner(state.activitySpinner?.instance);
      }
      return;
    }

    this.lastActivityMode = activityModeKey;
    state.activityContainer.clear();

    switch (effectiveMode) {
      case 'hidden':
        this.stopActivitySpinner();
        this.syncAgentSwarmActivitySpinner(undefined);
        state.ui.requestRender();
        return;
      case 'waiting': {
        const stepRetry = state.appState.stepRetry;
        const spinner = this.ensureActivitySpinner('moon', waitingSpinnerLabel(stepRetry));
        this.syncAgentSwarmActivitySpinner(placeSpinnerInAgentSwarm ? spinner : undefined);
        if (placeSpinnerInAgentSwarm) break;
        state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'waiting',
            spinner,
            tip: stepRetry === null ? this.currentLoadingTip?.tip : undefined,
            detail: stepRetry === null ? undefined : formatStepRetryDetail(stepRetry),
          }),
        );
        break;
      }
      case 'thinking': {
        this.stopActivitySpinner();
        this.syncAgentSwarmActivitySpinner(undefined);
        break;
      }
      case 'composing': {
        const spinner = this.ensureActivitySpinner('braille', 'working…', (s) =>
          currentTheme.fg('primary', s),
        );
        this.syncAgentSwarmActivitySpinner(undefined);
        state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'composing',
            spinner,
            tip: this.currentLoadingTip?.tip,
          }),
        );
        break;
      }
      case 'tool': {
        const spinner = this.ensureActivitySpinner('moon');
        this.syncAgentSwarmActivitySpinner(placeSpinnerInAgentSwarm ? spinner : undefined);
        if (placeSpinnerInAgentSwarm) break;
        state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'tool',
            spinner,
            tip: this.currentLoadingTip?.tip,
          }),
        );
        break;
      }
      case 'idle':
      case 'session': {
        this.stopActivitySpinner();
        this.syncAgentSwarmActivitySpinner(undefined);
        // Keep a placeholder row so the activity area does not fully shrink
        // when the spinner is removed at the end of streaming; combined with
        // pi-tui's clamp, this avoids a destructive full redraw (viewport jump).
        state.activityContainer.addChild(new Spacer(1));
        break;
      }
    }
    state.ui.requestRender();
  }

  private resolveActivityPaneMode(): EffectiveActivityPaneMode {
    const state = this.host.state;
    if (state.activeDialog === 'session-picker') return 'hidden';
    if (state.livePane.pendingApproval !== null) return 'hidden';
    if (state.appState.isCompacting) return 'hidden';
    if (state.livePane.pendingQuestion !== null) return 'hidden';

    const streamingPhase = state.appState.streamingPhase;

    // A running `!` shell command shows the moon spinner (same as `waiting`)
    // until it finishes, signalling that input is busy / queued.
    if (streamingPhase === 'shell') return 'waiting';

    if (state.livePane.mode === 'idle') {
      if (streamingPhase === 'thinking' || streamingPhase === 'composing') {
        return streamingPhase;
      }
    }

    return state.livePane.mode;
  }

  stopActivitySpinner(): void {
    if (this.host.state.activitySpinner !== null) {
      this.host.state.activitySpinner.instance.stop();
      this.host.state.activitySpinner = null;
    }
  }

  private shouldShowTerminalProgress(effectiveMode: EffectiveActivityPaneMode): boolean {
    if (this.host.state.appState.isCompacting) return true;
    return (
      effectiveMode === 'waiting' ||
      effectiveMode === 'thinking' ||
      effectiveMode === 'composing' ||
      effectiveMode === 'tool'
    );
  }

  private shouldPlaceActivitySpinnerInAgentSwarm(
    effectiveMode: EffectiveActivityPaneMode,
  ): boolean {
    return (
      this.host.sessionEventHandler.hasActiveAgentSwarmToolCall() &&
      (effectiveMode === 'waiting' || effectiveMode === 'tool')
    );
  }

  private syncAgentSwarmActivitySpinner(spinner: MoonLoader | undefined): void {
    this.host.sessionEventHandler.syncAgentSwarmActivitySpinner(spinner);
  }

  private syncTerminalProgress(active: boolean): void {
    const terminalState = this.host.state.terminalState;
    if (!terminalState.supportsProgress) return;
    if (terminalState.progressActive === active) return;
    this.host.state.terminal.setProgress(active);
    terminalState.progressActive = active;
  }

  private ensureActivitySpinner(
    style: SpinnerStyle,
    label = '',
    colorFn?: (s: string) => string,
  ): MoonLoader {
    const state = this.host.state;
    if (state.activitySpinner?.style !== style) {
      this.stopActivitySpinner();
    }

    if (state.activitySpinner === null) {
      const instance = new MoonLoader(state.ui, style, colorFn, label);
      state.activitySpinner = { instance, style };
      return instance;
    }

    state.activitySpinner.instance.setLabel(label);
    if (colorFn !== undefined) {
      state.activitySpinner.instance.setColorFn(colorFn);
    }
    return state.activitySpinner.instance;
  }
}
