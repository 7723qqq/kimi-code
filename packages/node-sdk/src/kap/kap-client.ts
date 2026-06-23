import {
  ErrorCodes,
  KimiError,
  noopTelemetryClient,
  resolveConfigPath,
  resolveKimiHome,
  type CoreAPI,
  type GoalSnapshot,
  type RPCMethods,
  type TelemetryClient,
} from '@moonshot-ai/agent-core';
import type { Kaos } from '@moonshot-ai/kaos';
import { assertKimiHostIdentity, type KimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';
import type { SessionStatusResponse } from '@moonshot-ai/protocol';

import { SDKRpcClientBase } from '#/rpc';
import type { KimiHarnessOptions, SessionStatus } from '#/types';

import { buildCoreApiProxy } from './core-proxy';
import { contextHandlers } from './handlers/context';
import { metaHandlers } from './handlers/meta';
import { promptHandlers } from './handlers/prompts';
import { resumeHandlers } from './handlers/resume';
import { serviceHandlers } from './handlers/services';
import { sessionHandlers } from './handlers/sessions';
import { KapAuthFacade } from './kap-auth';
import { KapHttpClient } from './http-client';
import { handleReverseRequest } from './reverse-channel';
import type { CoreApiHandlerMap } from './types';
import { KapWsClient } from './ws-client';

export class SDKKapClient extends SDKRpcClientBase {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity: KimiHostIdentity | undefined;
  readonly telemetry: TelemetryClient;
  readonly auth: KapAuthFacade;

  private readonly http: KapHttpClient;
  private readonly ws: KapWsClient;
  private readonly proxy: RPCMethods<CoreAPI>;
  private readonly goalSnapshots = new Map<string, GoalSnapshot | null>();

  constructor(options: KimiHarnessOptions & { kap: NonNullable<KimiHarnessOptions['kap']> }) {
    super();
    this.identity = options.identity === undefined ? undefined : assertKimiHostIdentity(options.identity);
    this.homeDir = resolveKimiHome(options.homeDir);
    this.configPath = resolveConfigPath({ homeDir: this.homeDir, configPath: options.configPath });
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    this.http = new KapHttpClient(options.kap);
    this.ws = new KapWsClient(options.kap, {
      onEvent: (event) => {
        if (event.type === 'goal.updated') {
          const snapshot = (event as { snapshot?: GoalSnapshot | null }).snapshot ?? null;
          this.goalSnapshots.set(event.sessionId, snapshot);
        }
        this.receiveEvent(event);
      },
      onReverseRequest: (frame) =>
        void handleReverseRequest({ client: this, http: this.http }, frame),
    });
    this.auth = new KapAuthFacade({
      homeDir: this.homeDir,
      configPath: this.configPath,
      identity: this.identity,
      onRefresh: options.onOAuthRefresh,
      http: this.http,
    });
    this.proxy = buildCoreApiProxy(this.handlers(), {
      http: this.http,
      ws: this.ws,
      serverUrl: options.kap.serverUrl,
    });
  }

  protected override getRpc(): Promise<RPCMethods<CoreAPI>> {
    return Promise.resolve(this.proxy);
  }

  async subscribeSession(sessionId: string): Promise<void> {
    await this.ws.connect();
    await this.ws.subscribe(sessionId);
  }

  async unsubscribeSession(sessionId: string): Promise<void> {
    await this.ws.unsubscribe(sessionId);
  }

  override async createSession(input: Parameters<SDKRpcClientBase['createSession']>[0]) {
    const summary = await super.createSession(input);
    await this.subscribeSession(summary.id);
    return summary;
  }

  override async resumeSession(input: Parameters<SDKRpcClientBase['resumeSession']>[0]) {
    const summary = await super.resumeSession(input);
    await this.subscribeSession(summary.id);
    return summary;
  }

  override async forkSession(input: Parameters<SDKRpcClientBase['forkSession']>[0]) {
    const summary = await super.forkSession(input);
    await this.subscribeSession(summary.id);
    return summary;
  }

  override async createSessionWithKaos(
    input: Parameters<SDKRpcClientBase['createSessionWithKaos']>[0],
    kaos: Kaos,
    persistenceKaos?: Kaos,
  ): Promise<import('#/types').SessionSummary> {
    const summary = await super.createSessionWithKaos(input, kaos, persistenceKaos);
    await this.subscribeSession(summary.id);
    return summary;
  }

  override async resumeSessionWithKaos(
    input: Parameters<SDKRpcClientBase['resumeSessionWithKaos']>[0],
    kaos: Kaos,
    persistenceKaos?: Kaos,
  ): Promise<import('#/types').ResumedSessionSummary> {
    const summary = await super.resumeSessionWithKaos(input, kaos, persistenceKaos);
    await this.subscribeSession(summary.id);
    return summary;
  }

  override async setModel(input: { sessionId: string; model: string }) {
    await this.http.post(`/sessions/${input.sessionId}/profile`, {
      agent_config: { model: input.model },
    });
    return { model: input.model };
  }

  override async setThinking(input: { sessionId: string; level: string }): Promise<void> {
    await this.http.post(`/sessions/${input.sessionId}/profile`, {
      agent_config: { thinking: input.level },
    });
  }

  override async setPermission(input: { sessionId: string; mode: 'yolo' | 'manual' | 'auto' }): Promise<void> {
    await this.http.post(`/sessions/${input.sessionId}/profile`, {
      agent_config: { permission_mode: input.mode },
    });
  }

  override async setPlanMode(input: { sessionId: string; enabled: boolean }): Promise<void> {
    await this.http.post(`/sessions/${input.sessionId}/profile`, {
      agent_config: { plan_mode: input.enabled },
    });
  }

  override async setSwarmMode(input: { sessionId: string; enabled: boolean }): Promise<void> {
    await this.http.post(`/sessions/${input.sessionId}/profile`, {
      agent_config: { swarm_mode: input.enabled },
    });
  }

  override async getStatus(input: { sessionId: string }): Promise<SessionStatus> {
    const status = await this.http.get<SessionStatusResponse>(`/sessions/${input.sessionId}/status`);
    return {
      model: status.model,
      thinkingLevel: status.thinking_level,
      permission: status.permission as SessionStatus['permission'],
      planMode: status.plan_mode,
      swarmMode: status.swarm_mode,
      contextTokens: status.context_tokens,
      maxContextTokens: status.max_context_tokens,
      contextUsage: status.context_usage,
    };
  }

  override async createGoal(input: { sessionId: string; objective: string; replace?: boolean }): Promise<GoalSnapshot> {
    await this.http.post(`/sessions/${input.sessionId}/profile`, {
      agent_config: { goal_objective: input.objective },
    });
    return this.goalSnapshots.get(input.sessionId) ?? this.emptyGoalSnapshot(input.objective);
  }

  override async getGoal(input: { sessionId: string }): Promise<{ goal: GoalSnapshot | null }> {
    return { goal: this.goalSnapshots.get(input.sessionId) ?? null };
  }

  override async pauseGoal(input: { sessionId: string }): Promise<GoalSnapshot> {
    await this.http.post(`/sessions/${input.sessionId}/profile`, { agent_config: { goal_control: 'pause' } });
    return this.requireGoalSnapshot(input.sessionId);
  }

  override async resumeGoal(input: { sessionId: string }): Promise<GoalSnapshot> {
    await this.http.post(`/sessions/${input.sessionId}/profile`, { agent_config: { goal_control: 'resume' } });
    return this.requireGoalSnapshot(input.sessionId);
  }

  override async cancelGoal(input: { sessionId: string }): Promise<GoalSnapshot> {
    await this.http.post(`/sessions/${input.sessionId}/profile`, { agent_config: { goal_control: 'cancel' } });
    return this.requireGoalSnapshot(input.sessionId);
  }

  private requireGoalSnapshot(sessionId: string): GoalSnapshot {
    const snapshot = this.goalSnapshots.get(sessionId);
    if (snapshot === undefined || snapshot === null) {
      throw new KimiError(ErrorCodes.GOAL_NOT_FOUND, `No goal snapshot cached for session ${sessionId}`);
    }
    return snapshot;
  }

  private emptyGoalSnapshot(objective: string): GoalSnapshot {
    return {
      goalId: '',
      objective,
      status: 'active',
      turnsUsed: 0,
      tokensUsed: 0,
      wallClockMs: 0,
      budget: {
        tokenBudget: null,
        turnBudget: null,
        wallClockBudgetMs: null,
        remainingTokens: null,
        remainingTurns: null,
        remainingWallClockMs: null,
        tokenBudgetReached: false,
        turnBudgetReached: false,
        wallClockBudgetReached: false,
        overBudget: false,
      },
    };
  }

  async close(): Promise<void> {
    this.ws.close();
  }

  /** Handler registry — extended by each subsequent phase. */
  protected handlers(): CoreApiHandlerMap {
    return {
      ...metaHandlers,
      ...sessionHandlers,
      ...resumeHandlers,
      ...promptHandlers,
      ...contextHandlers,
      ...serviceHandlers,
    };
  }
}
