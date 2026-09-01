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
    private readonly transport: SessionTransport,
  ) {}

  /** Create a session over the napi addon transport (the M1d entry point). */
  static async create(
    params: Record<string, unknown>,
    callbacks: SessionCallbacks,
  ): Promise<EngineSessionHandle> {
    return EngineSessionHandle.createWith(new NapiSessionTransport(), params, callbacks);
  }

  /** Create a session over an arbitrary transport (napi or stdio). */
  static async createWith(
    transport: SessionTransport,
    params: Record<string, unknown>,
    callbacks: unknown,
  ): Promise<EngineSessionHandle> {
    const id = await transport.createSession(params, callbacks);
    return new EngineSessionHandle(id, transport);
  }

  /** Enqueue a prompt; resolves with the engine-assigned turn id (monotonic). */
  enqueueTurn(prompt: SessionPrompt, admission: SessionAdmission): Promise<number> {
    return this.transport.enqueueTurn(this.id, prompt, admission);
  }

  /** Resolve with the outcome of one enqueued turn (exactly once). */
  turnOutcome(turnId: number): Promise<SessionTurnOutcome> {
    return this.transport.turnOutcome(this.id, turnId);
  }

  /** Cancel a turn by id; without an id the active turn (if any). */
  cancelTurn(turnId?: number): Promise<boolean> {
    return this.transport.cancelTurn(this.id, turnId);
  }

  status(): Promise<SessionStatus> {
    return this.transport.status(this.id);
  }

  isSettled(): Promise<boolean> {
    return this.transport.isSettled(this.id);
  }

  /** Resolves once the session is fully idle. */
  settled(): Promise<void> {
    return this.transport.settled(this.id);
  }

  /**
   * Try to acquire quiescence: an exclusive window in which enqueued turns
   * are parked instead of admitted (undo checkpoints, compaction). Fails
   * when a guard is already held or any turn is outstanding.
   */
  tryAcquireQuiescence(): Promise<boolean> {
    return this.transport.tryAcquireQuiescence(this.id);
  }

  /** Release the quiescence window: held turns replay in FIFO order. */
  releaseQuiescence(): Promise<void> {
    return this.transport.releaseQuiescence(this.id);
  }

  setHistory(history: SessionPrompt[]): Promise<void> {
    return this.transport.setHistory(this.id, history);
  }

  clearHistory(): Promise<void> {
    return this.transport.clearHistory(this.id);
  }

  extendHistory(history: SessionPrompt[]): Promise<void> {
    return this.transport.extendHistory(this.id, history);
  }

  historyLen(): Promise<number> {
    return this.transport.historyLen(this.id);
  }

  dispose(): Promise<void> {
    return this.transport.dispose(this.id);
  }
}

/**
 * The transport-agnostic session surface. `createSession` wires the
 * session-scoped host callbacks on the transport (napi: TSFN registry;
 * stdio: AgentProcess handlers) and returns the engine-assigned session id;
 * every other method addresses a session by id. All methods are async: the
 * stdio transport round-trips JSON-RPC, and the napi transport's sync calls
 * are lifted into promises for a uniform handle API. The `callbacks`
 * parameter is typed per transport — the concrete transports narrow it.
 */
export interface SessionTransport {
  createSession(params: Record<string, unknown>, callbacks: unknown): Promise<string>;
  enqueueTurn(
    sessionId: string,
    prompt: SessionPrompt,
    admission: SessionAdmission,
  ): Promise<number>;
  turnOutcome(sessionId: string, turnId: number): Promise<SessionTurnOutcome>;
  cancelTurn(sessionId: string, turnId?: number): Promise<boolean>;
  status(sessionId: string): Promise<SessionStatus>;
  isSettled(sessionId: string): Promise<boolean>;
  settled(sessionId: string): Promise<void>;
  tryAcquireQuiescence(sessionId: string): Promise<boolean>;
  releaseQuiescence(sessionId: string): Promise<void>;
  setHistory(sessionId: string, history: SessionPrompt[]): Promise<void>;
  clearHistory(sessionId: string): Promise<void>;
  extendHistory(sessionId: string, history: SessionPrompt[]): Promise<void>;
  historyLen(sessionId: string): Promise<number>;
  dispose(sessionId: string): Promise<void>;
}

/** The napi addon transport: the callback registry + session.* module calls. */
class NapiSessionTransport implements SessionTransport {
  private readonly mod: SessionNativeModule;

  constructor() {
    this.mod = loadSessionNativeModule();
  }

  async createSession(
    params: Record<string, unknown>,
    callbacks: SessionCallbacks,
  ): Promise<string> {
    // Capture the optional callbacks so the guards below narrow them (TS
    // does not narrow property accesses on a parameter into closures).
    const emitEvent = callbacks.emitEvent;
    const checkPermission = callbacks.checkPermission;
    const finalizeTool = callbacks.finalizeTool;
    const drainSteers = callbacks.drainSteers;
    const askQuestion = callbacks.askQuestion;
    const stateRead = callbacks.stateRead;
    const stateWrite = callbacks.stateWrite;
    const turnEvent = callbacks.turnEvent;
    const telemetry = callbacks.telemetry;
    const listTools = callbacks.listTools;
    const goal = callbacks.goal;
    return this.mod.createEngineSession(
      params,
      makeRequestCallback(this.mod, (p) => callbacks.llmChat(p)),
      makeRequestCallback(this.mod, (p) => callbacks.executeTool(p)),
      emitEvent === undefined ? undefined : makeEventCallback(this.mod, emitEvent),
      checkPermission === undefined
        ? undefined
        : makeRequestCallback(this.mod, (p) => checkPermission(p)),
      finalizeTool === undefined
        ? undefined
        : makeRequestCallback(this.mod, (p) => finalizeTool(p)),
      drainSteers === undefined
        ? undefined
        : makeRequestCallback(this.mod, async () => JSON.stringify(await drainSteers())),
      askQuestion === undefined
        ? undefined
        : makeRequestCallback(this.mod, (p) => askQuestion(p)),
      stateRead === undefined
        ? undefined
        : makeRequestCallback(this.mod, (p) => stateRead(p)),
      stateWrite === undefined
        ? undefined
        : makeRequestCallback(this.mod, (p) => stateWrite(p)),
      turnEvent === undefined ? undefined : makeEventCallback(this.mod, turnEvent),
      telemetry === undefined ? undefined : makeEventCallback(this.mod, telemetry),
      listTools === undefined
        ? undefined
        : makeRequestCallback(this.mod, async () => JSON.stringify(await listTools())),
      goal === undefined
        ? undefined
        : makeRequestCallback(this.mod, async () => JSON.stringify((await goal()) ?? null)),
    );
  }

  async enqueueTurn(
    sessionId: string,
    prompt: SessionPrompt,
    admission: SessionAdmission,
  ): Promise<number> {
    return this.mod.sessionEnqueueTurn(sessionId, JSON.stringify(prompt), admission);
  }

  async turnOutcome(sessionId: string, turnId: number): Promise<SessionTurnOutcome> {
    return this.mod.sessionTurnOutcome(sessionId, turnId);
  }

  async cancelTurn(sessionId: string, turnId?: number): Promise<boolean> {
    return this.mod.sessionCancelTurn(sessionId, turnId);
  }

  async status(sessionId: string): Promise<SessionStatus> {
    return this.mod.sessionStatus(sessionId);
  }

  async isSettled(sessionId: string): Promise<boolean> {
    return this.mod.sessionIsSettled(sessionId);
  }

  async settled(sessionId: string): Promise<void> {
    return this.mod.sessionSettled(sessionId);
  }

  async tryAcquireQuiescence(sessionId: string): Promise<boolean> {
    return this.mod.sessionTryAcquireQuiescence(sessionId);
  }

  async releaseQuiescence(sessionId: string): Promise<void> {
    this.mod.sessionReleaseQuiescence(sessionId);
  }

  async setHistory(sessionId: string, history: SessionPrompt[]): Promise<void> {
    this.mod.sessionSetHistory(sessionId, JSON.stringify(history));
  }

  async clearHistory(sessionId: string): Promise<void> {
    this.mod.sessionClearHistory(sessionId);
  }

  async extendHistory(sessionId: string, history: SessionPrompt[]): Promise<void> {
    this.mod.sessionExtendHistory(sessionId, JSON.stringify(history));
  }

  async historyLen(sessionId: string): Promise<number> {
    return this.mod.sessionHistoryLen(sessionId);
  }

  async dispose(sessionId: string): Promise<void> {
    this.mod.sessionDispose(sessionId);
  }
}