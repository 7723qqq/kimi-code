/**
 * TUI2 BTW panel controller — interactive-agent panel state driven by the
 * response store.
 *
 * Replaces `tui/controllers/btw-panel.ts`'s `BtwPanelController`. The v1
 * controller mounted a `BtwPanelComponent` into a pi-tui Container and called
 * `requestRender()`; the tui2 version writes `store.state.btwPanel` and the
 * opentui reconciler re-renders the panel automatically.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Event, KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';

import { getNoActiveSessionMessage } from '../constant/kimi-tui';
import type { Tui2EventBus } from '../event';
import type { Tui2Store } from '../state';
import { formatErrorMessage } from '../utils/event-payload';
import { formatHookResultPlain } from '../utils/hook-result-format';

export interface BtwPanelHost {
  store: Tui2Store;
  bus: Tui2EventBus | undefined;
  session: Session | undefined;
  readonly harness: KimiHarness;

  showError(msg: string): void;
}

export interface BtwPanelController {
  open(agentId: string, initialPrompt: string): void;
  clear(): void;
  closeOrCancel(): boolean;
  cancelRunning(): boolean;
  sendUserInput(text: string): boolean;
  scroll(direction: 'up' | 'down'): boolean;
  routeEvent(event: Event): boolean;
  dispose(): void;
}

/**
 * The shape of the `btwPanel` slice. Mirrors the inline type declared at
 * `state.tsx:btwPanel`. Kept local so the controller and its tests can
 * reference a single source of truth.
 */
type BtwPanelSlice = {
  active: boolean;
  agentId: string;
  answer: string;
  thinking: string;
  running: boolean;
  done: boolean;
  failed: string | null;
  transientNotice: string | null;
  scrollOffset: number;
};

/**
 * Create a BTW panel controller over a host (store + event bus + session).
 * The panel state lives in `store.state.btwPanel`; events routed by
 * `routeEvent` mutate it in place.
 */
export function createBtwPanelController(host: BtwPanelHost): BtwPanelController {
  const { store, bus } = host;

  /**
   * Patch a subset of the `btwPanel` slice while preserving sibling fields.
   * SolidJS `createStore` setters replace at the given path; a bare
   * `setState('btwPanel', { answer: x })` would wipe `active` / `running` /
   * `thinking` etc., which the streaming event handler depends on. The
   * panel accumulates answer and thinking across many `assistant.delta` /
   * `thinking.delta` events, so every partial write must preserve them.
   *
   * Delegates to `store.patch` (the shared store-level helper) so the
   * spread invariant lives in exactly one place.
   */
  const patchBtwPanel = (partial: Partial<BtwPanelSlice>): void => {
    store.patch('btwPanel', partial);
  };

  const resetPanel = (): void => {
    store.setState('btwPanel', {
      active: false,
      agentId: '',
      answer: '',
      thinking: '',
      running: false,
      done: false,
      failed: null,
      transientNotice: null,
      scrollOffset: 0,
    });
  };

  const open = (agentId: string, initialPrompt: string): void => {
    store.setState('btwPanel', {
      active: true,
      agentId,
      answer: '',
      thinking: '',
      running: true,
      done: false,
      failed: null,
      transientNotice: null,
      scrollOffset: 0,
    });
    promptAgent(agentId, initialPrompt);
  };

  const clear = (): void => {
    const active = store.state.btwPanel;
    if (active.active && shouldCancelOnUnmount(active)) {
      void cancelAgent(active.agentId);
    }
    resetPanel();
  };

  const closeOrCancel = (): boolean => {
    const active = store.state.btwPanel;
    if (!active.active) return false;
    const shouldCancel = shouldCancelOnUnmount(active);
    resetPanel();
    if (shouldCancel) {
      void cancelAgent(active.agentId);
    }
    return true;
  };

  const cancelRunning = (): boolean => {
    const active = store.state.btwPanel;
    if (!active.active || !active.running) return false;
    void cancelAgent(active.agentId);
    return true;
  };

  const sendUserInput = (text: string): boolean => {
    const active = store.state.btwPanel;
    if (!active.active) return false;
    if (active.running) {
      patchBtwPanel({
        transientNotice: t('tui.statusMessages.btwBusyNotice'),
      });
      store.setState('editorDraft', text);
      return true;
    }
    submitPrompt(active.agentId, text);
    return true;
  };

  const scroll = (direction: 'up' | 'down'): boolean => {
    const active = store.state.btwPanel;
    if (!active.active) return false;
    const offset = active.scrollOffset;
    const next = direction === 'up' ? offset + 1 : Math.max(0, offset - 1);
    if (next === offset) return false;
    patchBtwPanel({ scrollOffset: next });
    return true;
  };

  const routeEvent = (event: Event): boolean => {
    const active = store.state.btwPanel;
    if (!active.active || event.agentId !== active.agentId) return false;

    switch (event.type) {
      case 'assistant.delta':
        patchBtwPanel({ answer: active.answer + event.delta });
        return true;
      case 'thinking.delta':
        patchBtwPanel({ thinking: active.thinking + event.delta });
        return true;
      case 'hook.result':
        patchBtwPanel({ answer: active.answer + formatHookResultPlain(event) });
        return true;
      case 'turn.ended':
        if (event.reason === 'completed') {
          patchBtwPanel({ running: false, done: true });
        } else {
          patchBtwPanel({ running: false, failed: formatBtwTurnEnd(event) });
        }
        return true;
      default:
        return true;
    }
  };

  const submitPrompt = (agentId: string, prompt: string): void => {
    const session = host.session;
    if (session === undefined) {
      patchBtwPanel({ running: false, failed: getNoActiveSessionMessage() });
      return;
    }
    void withInteractiveAgent(agentId, () => session.prompt(prompt)).catch((error: unknown) => {
      patchBtwPanel({
        running: false,
        failed: t('tui.messages.btwSendFailed', { error: formatErrorMessage(error) }),
      });
    });
  };

  const promptAgent = submitPrompt;

  const cancelAgent = async (agentId: string): Promise<void> => {
    const session = host.session;
    if (session === undefined) return;
    await withInteractiveAgent(agentId, () => session.cancel()).catch((error: unknown) => {
      host.showError(t('tui.messages.btwCancelFailed', { error: formatErrorMessage(error) }));
    });
  };

  const shouldCancelOnUnmount = (panel: {
    readonly running: boolean;
    readonly answer: string;
  }): boolean => panel.running || panel.answer.length === 0;

  const withInteractiveAgent = <T>(agentId: string, fn: () => Promise<T>): Promise<T> =>
    host.harness.withInteractiveAgent(agentId, fn);

  // Route session events into the active panel while it is open.
  const off = bus === undefined ? [] : [bus.subscribe(routeEvent)];

  return {
    open,
    clear,
    closeOrCancel,
    cancelRunning,
    sendUserInput,
    scroll,
    routeEvent,
    dispose(): void {
      for (const fn of off) fn();
    },
  };
}

function formatBtwTurnEnd(event: Extract<Event, { type: 'turn.ended' }>): string {
  if (event.reason === 'cancelled') {
    return t('tui.statusMessages.btwInterrupted');
  }
  if (event.error?.code === 'provider.filtered') {
    return t('tui.statusMessages.btwFiltered');
  }
  if (event.error !== undefined) {
    return `[${event.error.code}] ${event.error.message}`;
  }
  if (event.reason === 'blocked') {
    return t('tui.statusMessages.promptBlocked');
  }
  return `BTW turn ended with reason: ${event.reason}`;
}
