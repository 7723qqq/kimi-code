/// EngineSession handle over the napi boundary (M1d).
///
/// The napi surface upgrades from "one call per turn" (`runTurnRust`) to a
/// session handle: admission (four modes), the pending FIFO, the pump, turn
/// ids, cancellation, and quiescence live engine-side across turns. The host
/// creates one session (the engine pipeline is built once), enqueues turns,
/// and awaits outcomes.
///
/// The callbacks are session-scoped: they are wired once at creation and
/// route to whatever per-turn capabilities the host has registered (the
/// session runs turns serially, so one active registration suffices).
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** A serialized LLMMessage crossing the session boundary. */
export interface SessionPrompt {
  role: string;
  content: string;
  blocksJson?: string;
  toolCallsJson?: string;
  toolCallId?: string;
}

/** How an enqueued prompt joins the turn pipeline (v2 `StepRequest.admission`). */
export type SessionAdmission =
  | 'newTurn'
  | 'activeOrNewTurn'
  | 'activeOrNextTurn'
  | 'activeTurnOnly';

/** The outcome of one enqueued turn (engine-side failures reject the promise). */
export interface SessionTurnOutcome {
  status: 'ran' | 'cancelledBeforeStart';
  result?: {
    stopReason: string;
    steps: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    inputCacheRead: number;
    inputCacheCreation: number;
    eventsEmitted: number;
    llmRetries: number;
    llmTransport: string;
    nativeToolCalls: number;
  };
}

export interface SessionStatus {
  activeTurnId: number | null;
  pendingTurnIds: number[];
}

/** Session-scoped host callbacks (the run_turn callback set plus the goal provider). */
export interface SessionCallbacks {
  llmChat: (request: string) => Promise<string>;
  executeTool: (request: string) => Promise<string>;
  emitEvent?: (eventJson: string) => void;
  checkPermission?: (request: string) => Promise<string>;
  finalizeTool?: (request: string) => Promise<string>;
  drainSteers?: () => Promise<string>;
  askQuestion?: (request: string) => Promise<string>;
  stateRead?: (request: string) => Promise<string>;
  stateWrite?: (request: string) => Promise<string>;
  turnEvent?: (eventJson: string) => void;
  telemetry?: (eventJson: string) => void;
  listTools?: () => Promise<string>;
  /** Fresh goal snapshot per turn, as the snake_case wire goal JSON or null. */
  goal?: () => Promise<string | null>;
}

/** The session-scoped slice of the native addon. */
interface SessionNativeModule {
  createEngineSession(
    params: unknown,
    llmChatCb: (callbackId: number) => void,
    executeToolCb: (callbackId: number) => void,
    emitEventCb?: (callbackId: number) => void,
    checkPermissionCb?: (callbackId: number) => void,
    finalizeToolCb?: (callbackId: number) => void,
    drainSteersCb?: (callbackId: number) => void,
    askQuestionCb?: (callbackId: number) => void,
    stateReadCb?: (callbackId: number) => void,
    stateWriteCb?: (callbackId: number) => void,
    turnEventCb?: (callbackId: number) => void,
    telemetryCb?: (callbackId: number) => void,
    listToolsCb?: (callbackId: number) => void,
    goalCb?: (callbackId: number) => void,
  ): Promise<string>;
  sessionEnqueueTurn(sessionId: string, prompt: string, admission: string): number;
  sessionTurnOutcome(sessionId: string, turnId: number): Promise<SessionTurnOutcome>;
  sessionCancelTurn(sessionId: string, turnId?: number): boolean;
  sessionStatus(sessionId: string): SessionStatus;
  sessionIsSettled(sessionId: string): boolean;
  sessionSettled(sessionId: string): Promise<void>;
  sessionTryAcquireQuiescence(sessionId: string): boolean;
  sessionReleaseQuiescence(sessionId: string): void;
  sessionSetHistory(sessionId: string, historyJson: string): void;
  sessionClearHistory(sessionId: string): void;
  sessionExtendHistory(sessionId: string, historyJson: string): void;
  sessionHistoryLen(sessionId: string): number;
  sessionDispose(sessionId: string): void;
  getCallbackPayload(id: number): string | null;
  resolveCallback(id: number, error: string | null, result: string | null): void;
}

export function findKimiAgentAddon(): string | null {
  const projectRoot = resolve(import.meta.dirname, '..', '..');
  const candidates: string[] = [
    resolve(import.meta.dirname, 'kimi_agent.node'),
    resolve(projectRoot, 'packages/kimi-agent/kimi_agent.node'),
  ];
  for (const dir of [import.meta.dirname, resolve(projectRoot, 'packages/kimi-agent')]) {
    try {
      for (const entry of readdirSync(dir)) {
        if (entry.endsWith('.node') && entry.startsWith('kimi_agent')) {
          candidates.push(resolve(dir, entry));
        }
      }
    } catch {
      // ignore unreadable dirs
    }
  }
  // Packaged single-file binary: the .node file is embedded as a native
  // asset and extracted to a cache directory at runtime.
  const getNativePackageRoot = (globalThis as Record<string, unknown>)[
    '__kimi_getNativePackageRoot'
  ];
  const seaPkgRoot =
    typeof getNativePackageRoot === 'function'
      ? (getNativePackageRoot as (pkg: string) => string | null)('@moonshot-ai/kimi-agent')
      : undefined;
  if (seaPkgRoot !== null && seaPkgRoot !== undefined) {
    try {
      for (const entry of readdirSync(seaPkgRoot)) {
        if (entry.endsWith('.node') && entry.startsWith('kimi_agent')) {
          candidates.push(resolve(seaPkgRoot, entry));
        }
      }
    } catch {
      // ignore
    }
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

function loadSessionNativeModule(): SessionNativeModule {
  const modulePath = findKimiAgentAddon();
  if (!modulePath) {
    throw new Error('kimi_agent native addon not built; run `napi build` in packages/kimi-agent');
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(resolve(modulePath)) as SessionNativeModule;
}

/**
 * A request/response callback over the callback registry: the native side
 * fires with a callback id, the handler fetches the payload, answers, and
 * resolves.
 */
function makeRequestCallback(
  mod: SessionNativeModule,
  handler: (request: string) => Promise<string>,
): (callbackId: number) => void {
  return (callbackId: number) => {
    const payload = mod.getCallbackPayload(callbackId);
    if (!payload) return;
    void (async () => {
      try {
        mod.resolveCallback(callbackId, null, await handler(payload));
      } catch (error: unknown) {
        mod.resolveCallback(
          callbackId,
          error instanceof Error ? error.message : String(error),
          null,
        );
      }
    })();
  };
}

/** Fire-and-forget callback: fetch the payload, never resolve. */
function makeEventCallback(
  mod: SessionNativeModule,
  handler: (eventJson: string) => void,
): (callbackId: number) => void {
  return (callbackId: number) => {
    const payload = mod.getCallbackPayload(callbackId);
    if (!payload) return;
    handler(payload);
  };
}

/** Handle to one engine-owned session. */
export class EngineSessionHandle {
  private constructor(
    readonly id: string,
    private readonly mod: SessionNativeModule,
  ) {}

  /**
   * Create the session. `params` carries the session-scoped engine
   * configuration (the same shape as the per-turn `JsRunTurnParams`; the
   * per-turn fields — messages/tools/goal — are ignored by the session).
   */
  static async create(
    params: Record<string, unknown>,
    callbacks: SessionCallbacks,
  ): Promise<EngineSessionHandle> {
    const mod = loadSessionNativeModule();
    const id = await mod.createEngineSession(
      params,
      makeRequestCallback(mod, (p) => callbacks.llmChat(p)),
      makeRequestCallback(mod, (p) => callbacks.executeTool(p)),
      callbacks.emitEvent === undefined ? undefined : makeEventCallback(mod, callbacks.emitEvent),
      callbacks.checkPermission === undefined
        ? undefined
        : makeRequestCallback(mod, (p) => callbacks.checkPermission(p)),
      callbacks.finalizeTool === undefined
        ? undefined
        : makeRequestCallback(mod, (p) => callbacks.finalizeTool(p)),
      callbacks.drainSteers === undefined
        ? undefined
        : makeRequestCallback(mod, async () => JSON.stringify(await callbacks.drainSteers())),
      callbacks.askQuestion === undefined
        ? undefined
        : makeRequestCallback(mod, (p) => callbacks.askQuestion(p)),
      callbacks.stateRead === undefined
        ? undefined
        : makeRequestCallback(mod, (p) => callbacks.stateRead(p)),
      callbacks.stateWrite === undefined
        ? undefined
        : makeRequestCallback(mod, (p) => callbacks.stateWrite(p)),
      callbacks.turnEvent === undefined ? undefined : makeEventCallback(mod, callbacks.turnEvent),
      callbacks.telemetry === undefined ? undefined : makeEventCallback(mod, callbacks.telemetry),
      callbacks.listTools === undefined
        ? undefined
        : makeRequestCallback(mod, async () => JSON.stringify(await callbacks.listTools())),
      callbacks.goal === undefined
        ? undefined
        : makeRequestCallback(mod, async () => JSON.stringify((await callbacks.goal()) ?? null)),
    );
    return new EngineSessionHandle(id, mod);
  }

  /** Enqueue a prompt; returns the engine-assigned turn id (monotonic). */
  enqueueTurn(prompt: SessionPrompt, admission: SessionAdmission): number {
    return this.mod.sessionEnqueueTurn(this.id, JSON.stringify(prompt), admission);
  }

  /** Resolve with the outcome of one enqueued turn (exactly once). */
  turnOutcome(turnId: number): Promise<SessionTurnOutcome> {
    return this.mod.sessionTurnOutcome(this.id, turnId);
  }

  /** Cancel a turn by id; without an id the active turn (if any). */
  cancelTurn(turnId?: number): boolean {
    return this.mod.sessionCancelTurn(this.id, turnId);
  }

  status(): SessionStatus {
    return this.mod.sessionStatus(this.id);
  }

  isSettled(): boolean {
    return this.mod.sessionIsSettled(this.id);
  }

  /** Resolves once the session is fully idle. */
  settled(): Promise<void> {
    return this.mod.sessionSettled(this.id);
  }

  /**
   * Try to acquire quiescence: an exclusive window in which enqueued turns
   * are parked instead of admitted (undo checkpoints, compaction). Fails
   * when a guard is already held or any turn is outstanding.
   */
  tryAcquireQuiescence(): boolean {
    return this.mod.sessionTryAcquireQuiescence(this.id);
  }

  /** Release the quiescence window: held turns replay in FIFO order. */
  releaseQuiescence(): void {
    this.mod.sessionReleaseQuiescence(this.id);
  }

  setHistory(history: SessionPrompt[]): void {
    this.mod.sessionSetHistory(this.id, JSON.stringify(history));
  }

  clearHistory(): void {
    this.mod.sessionClearHistory(this.id);
  }

  extendHistory(history: SessionPrompt[]): void {
    this.mod.sessionExtendHistory(this.id, JSON.stringify(history));
  }

  historyLen(): number {
    return this.mod.sessionHistoryLen(this.id);
  }

  dispose(): void {
    this.mod.sessionDispose(this.id);
  }
}