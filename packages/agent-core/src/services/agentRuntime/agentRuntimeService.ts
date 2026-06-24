import { readFile } from 'node:fs/promises';
import { join } from 'pathe';

import {
  Disposable,
  type IDisposable,
  IInstantiationService,
  InstantiationType,
  registerSingleton,
} from '../../di';
import { ErrorCodes, KimiError } from '../../errors';
import { SessionStore } from '../../session/store';
import type { SessionSummary } from '../../rpc';
import {
  createAgentRuntime,
  IEventBus,
  IAgentRPCService,
  type AgentRuntime,
  type AgentRuntimeType,
} from '../agent';
import { IEnvironmentService } from '../environment/environment';
import {
  AgentRuntimeTodoError,
  IAgentRuntimeService,
} from './agentRuntime';
import { IEventService } from '../event/event';

interface AgentMetaState {
  readonly homedir: string;
  readonly type: AgentRuntimeType;
}

interface SessionState {
  readonly agents: Record<string, AgentMetaState>;
}

interface CachedRuntime {
  readonly runtime: AgentRuntime;
  readonly eventSubscription: IDisposable;
}

export class AgentRuntimeService
  extends Disposable
  implements IAgentRuntimeService
{
  declare readonly _serviceBrand: undefined;

  private readonly store: SessionStore;
  private readonly runtimes = new Map<string, Promise<CachedRuntime | undefined>>();

  constructor(
    @IEnvironmentService env: IEnvironmentService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IEventService private readonly eventService: IEventService,
  ) {
    super();
    this.store = new SessionStore(env.homeDir);
    this._register(
      this.eventService.onDidPublish((event) => {
        const sessionId = (event as { readonly sessionId?: string }).sessionId;
        if (sessionId === undefined || sessionId === '') return;
        void this.forget(sessionId).catch(() => undefined);
      }),
    );
  }

  async get(sessionId: string, agentId = 'main'): Promise<AgentRuntime | undefined> {
    const cached = await this.getCached(sessionId, agentId);
    return cached?.runtime;
  }

  async require(sessionId: string, agentId = 'main'): Promise<AgentRuntime> {
    const runtime = await this.get(sessionId, agentId);
    if (runtime !== undefined) return runtime;
    throw new AgentRuntimeTodoError(
      'packages/agent-core/src/services/agentRuntime/agentRuntimeService.ts:require',
      `Runtime for session "${sessionId}" agent "${agentId}" is not available through services/agent.`,
    );
  }

  async getRPC(
    sessionId: string,
    agentId = 'main',
  ): Promise<IAgentRPCService | undefined> {
    const runtime = await this.get(sessionId, agentId);
    return runtime?.get(IAgentRPCService);
  }

  async requireRPC(sessionId: string, agentId = 'main'): Promise<IAgentRPCService> {
    const runtime = await this.require(sessionId, agentId);
    return runtime.get(IAgentRPCService);
  }

  async getSessionSummary(sessionId: string): Promise<SessionSummary | undefined> {
    try {
      return await this.store.get(sessionId);
    } catch {
      return undefined;
    }
  }

  listSessionSummaries(options: {
    readonly workDir?: string;
    readonly includeArchive?: boolean;
  } = {}): Promise<readonly SessionSummary[]> {
    return this.store.list(options);
  }

  async forget(sessionId: string, agentId = 'main'): Promise<void> {
    const key = runtimeKey(sessionId, agentId);
    const cached = await this.runtimes.get(key);
    this.runtimes.delete(key);
    cached?.eventSubscription.dispose();
    await cached?.runtime.close();
  }

  override dispose(): void {
    if (this._store.isDisposed) return;
    const cached = [...this.runtimes.values()];
    this.runtimes.clear();
    for (const entry of cached) {
      void entry
        .then(async (resolved) => {
          resolved?.eventSubscription.dispose();
          await resolved?.runtime.close();
        })
        .catch(() => undefined);
    }
    super.dispose();
  }

  private getCached(
    sessionId: string,
    agentId: string,
  ): Promise<CachedRuntime | undefined> {
    const key = runtimeKey(sessionId, agentId);
    let cached = this.runtimes.get(key);
    if (cached === undefined) {
      cached = this.createRuntime(sessionId, agentId).catch((error: unknown) => {
        this.runtimes.delete(key);
        if (isNotFoundError(error)) return undefined;
        throw error;
      });
      this.runtimes.set(key, cached);
    }
    return cached;
  }

  private async createRuntime(
    sessionId: string,
    agentId: string,
  ): Promise<CachedRuntime | undefined> {
    const summary = await this.store.get(sessionId);
    const state = await readSessionState(summary.sessionDir);
    const meta = state?.agents[agentId];
    if (meta === undefined) return undefined;

    const runtime = createAgentRuntime(this.instantiation, {
      sessionId,
      agentId,
      type: meta.type,
      homedir: meta.homedir,
      cwd: summary.workDir,
      cron: false,
      background: false,
    });
    const eventSubscription = runtime.get(IEventBus).on((event) => {
      this.eventService.publish({ ...event, sessionId, agentId });
    });
    try {
      await runtime.restore();
    } catch (error) {
      eventSubscription.dispose();
      await runtime.close().catch(() => undefined);
      throw error;
    }
    return { runtime, eventSubscription };
  }
}

async function readSessionState(sessionDir: string): Promise<SessionState | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf8')) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const agents = parsed['agents'];
  if (!isRecord(agents)) return undefined;

  const result: Record<string, AgentMetaState> = {};
  for (const [agentId, entry] of Object.entries(agents)) {
    if (!isRecord(entry)) continue;
    const homedir = entry['homedir'];
    const type = entry['type'];
    if (typeof homedir !== 'string') continue;
    if (type !== 'main' && type !== 'sub' && type !== 'independent') continue;
    result[agentId] = { homedir, type };
  }
  return { agents: result };
}

function runtimeKey(sessionId: string, agentId: string): string {
  return `${sessionId}:${agentId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof KimiError && error.code === ErrorCodes.SESSION_NOT_FOUND;
}

registerSingleton(IAgentRuntimeService, AgentRuntimeService, InstantiationType.Delayed);
