import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { EngineSessionHandle, type SessionCallbacks, type SessionPrompt } from '@moonshot-ai/kimi-agent/session-handle';
import type { Event, QuestionItem, ToolInputDisplay } from '#/events';
import {
  resolveNativeLlm,
  probeShellPath,
  buildPolicySnapshot,
  resolveGithubCredentials,
} from './native-llm-resolver';
import { ImageLimits } from '#/image-limits';
import { KimiHarness } from '#/kimi-harness';
import {
  loadRuntimeConfig,
  validateConfig,
  writeConfigFile,
  type KimiConfig,
  type KimiConfigPatch,
} from '#/config-local';
import {
  SDKRpcClientBase,
  type SessionIdRpcInput,
  type SessionPromptRpcInput,
} from '#/rpc';
import type {
  ConfigDiagnostics,
  CreateSessionOptions,
  ExperimentalFeatureState,
  ExportSessionInput,
  ExportSessionResult,
  GetConfigOptions,
  KimiHostIdentity,
  ListSessionsOptions,
  PluginCommandDef,
  ResumeSessionInput,
  ResumedSessionSummary,
  SessionSummary,
  SessionSummaryPage,
  SkillSummary,
  TelemetryClient,
  TelemetryProperties,
  WorkspaceTrustInfo,
} from '#/types';

import { KimiAuthFacade } from '#/auth';
import { resolveConfigPath, resolveKimiHome } from '#/config-local/path';
import type { OAuthRefreshOutcome } from '@moonshot-ai/kimi-code-oauth';

export interface SDKRpcClientNativeOptions {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
  readonly identity?: KimiHostIdentity | undefined;
  readonly auth?: KimiAuthFacade | undefined;
  readonly onOAuthRefresh?: ((outcome: OAuthRefreshOutcome) => void) | undefined;
  readonly telemetry?: TelemetryClient | undefined;
  readonly uiMode?: string | undefined;
  readonly sessionStartedProperties?: TelemetryProperties | undefined;
  readonly imageLimits?: ImageLimits | undefined;
}

interface NativeSessionMeta {
  readonly id: string;
  readonly workDir: string;
  readonly sessionDir: string;
  readonly createdAt: number;
  updatedAt: number;
  title: string;
  busy: boolean;
  messageCount: number;
  handle?: EngineSessionHandle;
}

export class SDKRpcClientNative extends SDKRpcClientBase {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity: KimiHostIdentity | undefined;
  readonly telemetry: TelemetryClient;
  readonly auth: KimiAuthFacade;

  private readonly liveSessions = new Map<string, NativeSessionMeta>();
  private readonly sessionBaseDir: string;

  constructor(options: SDKRpcClientNativeOptions = {}) {
    super();
    this.homeDir = resolveKimiHome(options.homeDir);
    this.configPath = resolveConfigPath({ homeDir: this.homeDir, configPath: options.configPath });
    this.identity = options.identity;
    this.telemetry = options.telemetry ?? { track: () => {} };
    this.auth =
      options.auth ??
      new KimiAuthFacade({
        homeDir: this.homeDir,
        configPath: this.configPath,
        identity: this.identity,
        onRefresh: options.onOAuthRefresh,
      });
    this.sessionBaseDir = join(this.homeDir, 'sessions');
    if (!existsSync(this.sessionBaseDir)) {
      mkdirSync(this.sessionBaseDir, { recursive: true });
    }
  }

  // oxlint-disable-next-line typescript/no-explicit-any
  protected override async getRpc(): Promise<any> {
    return this;
  }

  override async createSession(input: CreateSessionOptions): Promise<SessionSummary> {
    const sessionId = input.id ? input.id : `session_${randomUUID()}`;
    const workDir = input.workDir ?? process.cwd();
    const sessionDir = join(this.sessionBaseDir, sessionId);
    const now = Date.now();

    const config = loadRuntimeConfig(this.configPath);
    const nativeLlm = resolveNativeLlm(config);
    const shellPath = probeShellPath();
    let currentTurnId = 0;

    const callbacks: SessionCallbacks = {
      llmChat: async () =>
        JSON.stringify({
          content: 'Hello! I am Kimi Code.',
          tool_calls: [],
          finish_reason: 'stop',
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
            input_cache_read: 0,
            input_cache_creation: 0,
          },
        }),
      executeTool: async (req: string) => {
        try {
          const parsed = JSON.parse(req) as { tool_call_id?: string; arguments?: unknown };
          const res = await this.toolCall({
            toolCallId: parsed.tool_call_id ?? randomUUID(),
            args: parsed.arguments ?? {},
          });
          return JSON.stringify(res);
        } catch {
          return JSON.stringify({ output: '', isError: true });
        }
      },
      emitEvent: (eventJson: string) => {
        try {
          const parsed = JSON.parse(eventJson);
          if (parsed.type === 'llm.delta') {
            if (parsed.part?.type === 'text' && typeof parsed.part.text === 'string') {
              this.receiveEvent({
                sessionId,
                agentId: 'main',
                type: 'assistant.delta',
                turnId: currentTurnId,
                delta: parsed.part.text,
              } as unknown as Event);
            } else if (parsed.part?.type === 'think' && typeof parsed.part.think === 'string') {
              this.receiveEvent({
                sessionId,
                agentId: 'main',
                type: 'thinking.delta',
                turnId: currentTurnId,
                delta: parsed.part.think,
              } as unknown as Event);
            }
          } else if (parsed.type === 'tool.native') {
            this.receiveEvent({
              sessionId,
              agentId: 'main',
              type: 'tool.call.started',
              turnId: currentTurnId,
              toolCallId: String(parsed.tool_call_id ?? randomUUID()),
              name: String(parsed.tool_name ?? 'tool'),
              args: parsed.arguments ?? {},
            } as unknown as Event);
            this.receiveEvent({
              sessionId,
              agentId: 'main',
              type: 'tool.result',
              turnId: currentTurnId,
              toolCallId: String(parsed.tool_call_id ?? randomUUID()),
              output: String(parsed.content ?? ''),
              isError: Boolean(parsed.is_error),
            } as unknown as Event);
          } else if (parsed.type === 'tool.native.progress') {
            this.receiveEvent({
              sessionId,
              agentId: 'main',
              type: 'tool.progress',
              turnId: currentTurnId,
              toolCallId: String(parsed.tool_call_id ?? randomUUID()),
              update: { kind: 'output', text: String(parsed.text ?? '') },
            } as unknown as Event);
          } else {
            this.receiveEvent({
              sessionId,
              agentId: 'main',
              ...parsed,
            } as unknown as Event);
          }
        } catch {
          // ignore malformed event
        }
      },
      checkPermission: async (req: string) => {
        try {
          const parsed = JSON.parse(req) as {
            tool_call_id?: string;
            tool_name?: string;
            action?: string;
            display?: ToolInputDisplay;
          };
          const res = await this.requestApproval({
            sessionId,
            agentId: 'main',
            toolCallId: parsed.tool_call_id ?? randomUUID(),
            action: parsed.action ?? 'execute',
            toolName: parsed.tool_name ?? 'unknown',
            display: parsed.display ?? { kind: 'command', command: parsed.tool_name ?? 'action' },
          });
          if (res.decision === 'approved') {
            return JSON.stringify({ decision: 'allow' });
          }
          return JSON.stringify({ decision: 'deny', reason: res.feedback ?? 'User rejected' });
        } catch {
          return JSON.stringify({ decision: 'deny', reason: 'cancelled' });
        }
      },
      askQuestion: async (req: string) => {
        try {
          const parsed = JSON.parse(req) as { tool_call_id?: string; questions?: QuestionItem[] };
          const res = await this.requestQuestion({
            sessionId,
            agentId: 'main',
            toolCallId: parsed.tool_call_id ?? randomUUID(),
            questions: parsed.questions ?? [],
          });
          if (res === null) {
            return JSON.stringify({ answers: {}, cancelled: true, reason: 'cancelled' });
          }
          const rawAnswers = 'answers' in res ? res.answers : res;
          const answers: Record<string, string> = {};
          for (const [k, v] of Object.entries(rawAnswers)) {
            answers[k] = typeof v === 'string' ? v : 'true';
          }
          const method = 'method' in res ? res.method : undefined;
          return JSON.stringify({ answers, ...(method ? { method } : {}) });
        } catch {
          return JSON.stringify({ answers: {}, cancelled: true, reason: 'error' });
        }
      },
      turnEvent: (eventJson: string) => {
        try {
          const parsed = JSON.parse(eventJson);
          if (parsed.type === 'turn.started') {
            currentTurnId = typeof parsed.turn_id === 'number' ? parsed.turn_id : Number(parsed.turn_id) || 0;
            this.receiveEvent({
              sessionId,
              agentId: 'main',
              type: 'turn.started',
              turnId: currentTurnId,
              prompt: String(parsed.prompt ?? ''),
            } as unknown as Event);
          } else if (parsed.type === 'turn.ended') {
            this.receiveEvent({
              sessionId,
              agentId: 'main',
              type: 'turn.ended',
              turnId: currentTurnId,
              reason: String(parsed.reason ?? parsed.status ?? 'completed'),
            } as unknown as Event);
          } else {
            this.receiveEvent({
              sessionId,
              agentId: 'main',
              ...parsed,
            } as unknown as Event);
          }
        } catch {
          // ignore malformed turn event
        }
      },
    };

    const policySnapshot = buildPolicySnapshot(config, workDir);
    const githubCreds = resolveGithubCredentials(config);
    const authToken =
      nativeLlm?.authProvider === undefined
        ? undefined
        : (request: string) => {
            const parsed = JSON.parse(request) as { provider: string; force: boolean };
            const tokenProvider = this.auth.resolveOAuthTokenProvider(parsed.provider);
            return tokenProvider.getAccessToken({ force: parsed.force === true });
          };

    const params = {
      turnId: sessionId,
      systemPrompt: 'You are Kimi Code, an intelligent AI coding assistant.',
      modelName: nativeLlm?.model ?? 'default',
      messages: [],
      tools: [],
      workspaceRoot: workDir,
      nativeTools: config.agent?.nativeTools !== false,
      shellPath,
      policySnapshotJson: JSON.stringify(policySnapshot),
      ...(githubCreds.githubToken ? { githubToken: githubCreds.githubToken } : {}),
      ...(githubCreds.githubBaseUrl ? { githubBaseUrl: githubCreds.githubBaseUrl } : {}),
      ...(nativeLlm ? { nativeLlm } : {}),
    };

    const handle = await EngineSessionHandle.create(
      params,
      { ...callbacks, authToken },
    );

    const meta: NativeSessionMeta = {
      id: sessionId,
      workDir,
      sessionDir,
      createdAt: now,
      updatedAt: now,
      title: 'New Session',
      busy: false,
      messageCount: 0,
      handle,
    };
    this.liveSessions.set(sessionId, meta);

    return {
      id: sessionId,
      workDir,
      sessionDir,
      title: meta.title,
      createdAt: now,
      updatedAt: now,
    };
  }

  override async resumeSession(input: ResumeSessionInput): Promise<ResumedSessionSummary> {
    const sessionId = input.id;
    let meta = this.liveSessions.get(sessionId);
    if (meta === undefined) {
      const now = Date.now();
      meta = {
        id: sessionId,
        workDir: process.cwd(),
        sessionDir: join(this.sessionBaseDir, sessionId),
        createdAt: now,
        updatedAt: now,
        title: 'Resumed Session',
        busy: false,
        messageCount: 0,
      };
      this.liveSessions.set(sessionId, meta);
    }
    return {
      id: sessionId,
      workDir: meta.workDir,
      sessionDir: meta.sessionDir,
      title: meta.title,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      sessionMetadata: {
        createdAt: new Date(meta.createdAt).toISOString(),
        updatedAt: new Date(meta.updatedAt).toISOString(),
        title: meta.title,
        isCustomTitle: false,
        agents: {},
        custom: {},
      },
      agents: {},
    };
  }

  override async listSessions(_input: ListSessionsOptions = {}): Promise<readonly SessionSummary[]> {
    return Array.from(this.liveSessions.values()).map((meta) => ({
      id: meta.id,
      workDir: meta.workDir,
      sessionDir: meta.sessionDir,
      title: meta.title,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    }));
  }

  override async listSessionsPage(_input?: ListSessionsOptions): Promise<SessionSummaryPage> {
    const items = await this.listSessions();
    return {
      items,
    };
  }

  override async deleteSession(input: SessionIdRpcInput): Promise<void> {
    const meta = this.liveSessions.get(input.sessionId);
    if (meta?.handle) {
      await meta.handle.dispose().catch(() => {});
    }
    this.liveSessions.delete(input.sessionId);
  }

  override async closeSession(input: SessionIdRpcInput): Promise<void> {
    const meta = this.liveSessions.get(input.sessionId);
    if (meta?.handle) {
      await meta.handle.dispose().catch(() => {});
    }
  }

  override async prompt(input: SessionPromptRpcInput): Promise<void> {
    const meta = this.liveSessions.get(input.sessionId);
    if (!meta || !meta.handle) return;
    meta.busy = true;
    meta.updatedAt = Date.now();

    const prompt: SessionPrompt = {
      role: 'user',
      content: typeof input.input === 'string' ? input.input : JSON.stringify(input.input),
    };
    try {
      const turnId = await meta.handle.enqueueTurn(prompt, 'newTurn');
      await meta.handle.turnOutcome(turnId);
    } finally {
      meta.busy = false;
      meta.updatedAt = Date.now();
    }
  }

  override async cancel(input: SessionIdRpcInput): Promise<void> {
    const meta = this.liveSessions.get(input.sessionId);
    if (!meta?.handle) return;
    await meta.handle.cancelTurn();
  }

  override async steer(input: SessionPromptRpcInput): Promise<void> {
    const meta = this.liveSessions.get(input.sessionId);
    if (!meta?.handle) return;
    meta.updatedAt = Date.now();

    const prompt: SessionPrompt = {
      role: 'user',
      content: typeof input.input === 'string' ? input.input : JSON.stringify(input.input),
    };
    const turnId = await meta.handle.enqueueTurn(prompt, 'activeOrNewTurn');
    if (!meta.busy) {
      meta.busy = true;
      try {
        await meta.handle.turnOutcome(turnId);
      } finally {
        meta.busy = false;
        meta.updatedAt = Date.now();
      }
    }
  }

  override async exportSession(input: ExportSessionInput): Promise<ExportSessionResult> {
    return {
      zipPath: join(this.sessionBaseDir, `${input.id}.zip`),
      entries: [],
      sessionDir: join(this.sessionBaseDir, input.id),
      manifest: {
        exportedAt: new Date().toISOString(),
        sessionId: input.id,
        kimiCodeVersion: input.version,
        wireProtocolVersion: '2.0.0',
        os: process.platform,
        nodejsVersion: process.version,
      },
    };
  }

  override async getConfig(_input?: GetConfigOptions): Promise<KimiConfig> {
    return loadRuntimeConfig(this.configPath);
  }

  override async setConfig(patch: KimiConfigPatch): Promise<KimiConfig> {
    const current = loadRuntimeConfig(this.configPath);
    const updated = validateConfig({
      ...current,
      ...patch,
      providers: {
        ...current.providers,
        ...(patch.providers as unknown as Record<string, unknown>),
      },
    });
    await writeConfigFile(this.configPath, updated);
    return updated;
  }

  override async getConfigDiagnostics(): Promise<ConfigDiagnostics> {
    return { warnings: [] };
  }

  override async listWorkspaceSkills(_workDir: string): Promise<readonly SkillSummary[]> {
    return [];
  }

  override async listPluginCommands(): Promise<readonly PluginCommandDef[]> {
    return [];
  }

  override async getExperimentalFeatures(): Promise<readonly ExperimentalFeatureState[]> {
    return [];
  }

  override async getWorkspaceTrustInfo(_workDir: string): Promise<WorkspaceTrustInfo> {
    return { trusted: true, gatedMcpServers: [] };
  }

  override async trustWorkspace(_workDir: string): Promise<void> {}

  async ensureConfigFile(): Promise<void> {
    if (!existsSync(this.configPath)) {
      writeFileSync(this.configPath, '', 'utf8');
    }
  }

  async close(): Promise<void> {
    for (const meta of this.liveSessions.values()) {
      if (meta.handle) {
        await meta.handle.dispose().catch(() => {});
      }
    }
    this.liveSessions.clear();
  }
}

export function createKimiHarnessNative(options: SDKRpcClientNativeOptions): KimiHarness {
  const rpc = new SDKRpcClientNative(options);
  return new KimiHarness(rpc, {
    identity: rpc.identity,
    uiMode: options.uiMode,
    homeDir: rpc.homeDir,
    configPath: rpc.configPath,
    auth: rpc.auth,
    telemetry: rpc.telemetry,
    ensureConfigFile: () => rpc.ensureConfigFile(),
    onClose: () => rpc.close(),
    imageLimits: options.imageLimits ?? new ImageLimits(process.env),
    sessionStartedProperties: options.sessionStartedProperties,
  });
}
