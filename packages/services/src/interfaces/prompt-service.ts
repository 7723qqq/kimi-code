/**
 * `IPromptService` — daemon-facing prompt submission interface
 * (Chain 4 / P1.4, W7.2; abort in Chain 4b / P1.4b, W7.3).
 *
 * Wraps `IHarnessBridge.rpc.{prompt, cancel}` and tracks per-session "active
 * prompt" state for the `session.busy` (40901) and `prompt.already_completed`
 * (40903) error mappings.
 *
 * Endpoint mapping (REST.md §3.5):
 *   POST /v1/sessions/{sid}/prompts            → submit(sid, body)
 *   POST /v1/sessions/{sid}/prompts/{pid}:abort → abort(sid, pid)
 *
 * Sentinel errors:
 *   - `SessionNotFoundError`     → 40401 at the route layer
 *   - `SessionBusyError`         → 40901 at the route layer
 *   - `PromptNotFoundError`      → 40402 at the route layer
 *   - `PromptAlreadyCompletedError` → 40903 at the route layer (NOTE: per
 *     REST.md §3.5 this is "idempotent success" — wire `data` is
 *     `{aborted: false, at_seq: <last seen seq>}`, envelope.code is 40903)
 *
 * **Event lifecycle observability**: the service also implements
 * `IPromptLifecycleObserver` and is registered with the daemon's event bus
 * so it can:
 *   1. Capture `turn.started` → record `promptId ↔ turnId` mapping for the
 *      session's active prompt.
 *   2. Capture `turn.ended` (top-level) → synthesize `prompt.completed` /
 *      `prompt.aborted` events the bus broadcasts to subscribers. agent-core
 *      doesn't emit these directly — the daemon synthesizes them so clients
 *      get prompt-level lifecycle without sniffing the turn graph.
 *
 * Documented further in `packages/services/src/impls/prompt-service-impl.ts`.
 */

import { createDecorator } from '@moonshot-ai/agent-core';
import type { Event, PromptSubmission, PromptSubmitResult } from '@moonshot-ai/protocol';

export interface PromptAbortResult {
  /** True iff this call performed the cancel (false on idempotent already-completed). */
  aborted: boolean;
  /** Per-session seq at the moment the abort was issued (informational). */
  at_seq?: number;
}

export interface IPromptService {
  /**
   * `POST /v1/sessions/{sid}/prompts` — submit a prompt for execution.
   *
   * Throws `SessionNotFoundError` (→ 40401) for unknown `sid`.
   * Throws `SessionBusyError`     (→ 40901) when another prompt is active.
   */
  submit(sid: string, body: PromptSubmission): Promise<PromptSubmitResult>;

  /**
   * `POST /v1/sessions/{sid}/prompts/{pid}:abort` — cancel an in-flight prompt.
   *
   * Per REST.md §3.5: aborting an already-completed prompt returns
   * `PromptAlreadyCompletedError` (→ 40903 with `data.aborted: false`).
   * Idempotent calls (same id, multiple aborts) collapse to a single cancel
   * RPC + subsequent calls return 40903.
   *
   * Throws `SessionNotFoundError` (→ 40401) for unknown `sid`.
   * Throws `PromptNotFoundError`  (→ 40402) when `pid` is unknown for `sid`.
   */
  abort(sid: string, pid: string): Promise<PromptAbortResult>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IPromptService = createDecorator<IPromptService>('IPromptService');

/**
 * Optional lifecycle observer surface. The daemon's `IEventBus` impl invokes
 * `observe(event)` AFTER fan-out to subscribers. The observer may return zero
 * or more synthetic events that the bus then publishes as if they had come
 * from the agent. This is how we synthesize `prompt.completed` and
 * `prompt.aborted` (agent-core's event union has no such types — see W7
 * prompt §critical discovery point #2).
 *
 * Keeping it a separate interface lets the EventBus accept any number of
 * observers (today just the prompt service; tomorrow potentially a session
 * usage aggregator etc.) without growing API surface.
 */
export interface IPromptLifecycleObserver {
  /**
   * Called by the event bus on EVERY published event. Implementations should
   * be fast + side-effect-light; long-running follow-ups must be queued
   * elsewhere. Returns an array of derived events (possibly empty) to publish
   * after the original event's fan-out completes.
   */
  observeEvent(event: Event): readonly Event[];
}

/**
 * Sentinel — REST → 40901 `session.busy`. Carries the active prompt id so the
 * route layer can include it in `details`.
 */
export class SessionBusyError extends Error {
  readonly sessionId: string;
  readonly activePromptId: string;
  constructor(sessionId: string, activePromptId: string) {
    super(`session ${sessionId} is busy (prompt ${activePromptId} in flight)`);
    this.name = 'SessionBusyError';
    this.sessionId = sessionId;
    this.activePromptId = activePromptId;
  }
}

/**
 * Sentinel — REST → 40402 `prompt.not_found`.
 */
export class PromptNotFoundError extends Error {
  readonly sessionId: string;
  readonly promptId: string;
  constructor(sessionId: string, promptId: string) {
    super(`prompt ${promptId} does not exist in session ${sessionId}`);
    this.name = 'PromptNotFoundError';
    this.sessionId = sessionId;
    this.promptId = promptId;
  }
}

/**
 * Sentinel — REST → 40903 `prompt.already_completed`. Carries the prompt id
 * and a flag so the route layer can emit the documented
 * `data: {aborted: false}` envelope despite the non-zero code.
 */
export class PromptAlreadyCompletedError extends Error {
  readonly sessionId: string;
  readonly promptId: string;
  constructor(sessionId: string, promptId: string) {
    super(`prompt ${promptId} in session ${sessionId} is already completed`);
    this.name = 'PromptAlreadyCompletedError';
    this.sessionId = sessionId;
    this.promptId = promptId;
  }
}
