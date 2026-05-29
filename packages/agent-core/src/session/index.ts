import { homedir } from 'node:os';
import { join } from 'pathe';
import type { Kaos } from '@moonshot-ai/kaos';

import { ErrorCodes, KimiError } from '#/errors';
import { getRootLogger, log } from '#/logging/logger';
import type { Logger, SessionLogHandle } from '#/logging/types';
import type { KimiConfig, SDKSessionRPC } from '#/rpc';
import { proxyWithExtraPayload } from '#/rpc/types';

import { Agent, type AgentOptions, type AgentType } from '../agent';
import { HookEngine, type HookDef } from './hooks';
import type { PermissionManagerOptions, PermissionRule } from '../agent/permission';
import { parseBooleanEnv, resolveConfigValue, type BackgroundConfig } from '../config';
import { makeErrorPayload } from '../errors';
import {
  McpConnectionManager,
  McpOAuthService,
  type McpServerEntry,
  type SessionMcpConfig,
} from '../mcp';
import type {
  EnabledPluginSessionStart,
  PluginRuntimeApplyResult,
  PluginRuntimeSnapshot,
} from '../plugin';
import {
  DEFAULT_AGENT_PROFILES,
  DEFAULT_INIT_PROMPT,
  loadAgentsMd,
  prepareSystemPromptContext,
  type ResolvedAgentProfile,
} from '../profile';
import type { ProviderManager } from './provider-manager';
import type { ToolServices } from '../runtime-types';
import {
  registerBuiltinSkills,
  resolveSkillRoots,
  SkillRegistry,
  summarizeSkill,
  type SkillRoot,
  type SkillSummary,
} from '../skill';
import { noopTelemetryClient, type TelemetryClient } from '../telemetry';
import { SessionSubagentHost } from './subagent-host';

export interface SessionOptions {
  readonly kaos: Kaos;
  readonly config?: KimiConfig;
  readonly id?: string | undefined;
  readonly homedir: string;
  readonly kimiHomeDir?: string;
  readonly rpc: SDKSessionRPC;
  readonly toolServices?: ToolServices;
  readonly initializeMainAgent?: boolean | undefined;
  readonly providerManager?: ProviderManager | undefined;
  readonly background?: BackgroundConfig | undefined;
  readonly hooks?: readonly HookDef[];
  readonly permissionRules?: readonly PermissionRule[];
  readonly skills?: SessionSkillConfig;
  readonly mcpConfig?: SessionMcpConfig;
  readonly telemetry?: TelemetryClient | undefined;
  readonly pluginSessionStarts?: readonly EnabledPluginSessionStart[];
}

export interface SessionSkillConfig {
  readonly userHomeDir?: string;
  readonly explicitDirs?: readonly string[];
  readonly extraDirs?: readonly string[];
  readonly pluginSkillRoots?: readonly SkillRoot[];
  readonly mergeAllAvailableSkills?: boolean;
  readonly builtinDir?: string;
}

export interface AgentMeta {
  readonly homedir: string;
  readonly type: AgentType;
  readonly parentAgentId: string | null;
}

export interface SessionMeta {
  createdAt: string;
  updatedAt: string;
  title: string;
  isCustomTitle: boolean;
  lastPrompt?: string;
  forkedFrom?: string;
  agents: Record<string, AgentMeta>;
  custom: Record<string, any>;
}

const BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV = 'KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT';

export class Session {
  readonly rpc: SDKSessionRPC;
  readonly telemetry: TelemetryClient;
  readonly skills: SkillRegistry;
  readonly agents: Map<string, Agent> = new Map();
  readonly mcp: McpConnectionManager;
  readonly log: Logger;
  private readonly logHandle: SessionLogHandle | undefined;
  readonly hookEngine: HookEngine;
  private agentIdCounter = 0;
  private readonly skillsReady: Promise<void>;
  // Plugin ids whose skills have been loaded into the registry (initial load +
  // every reload). The registry is additive and has no unload path, so a plugin
  // id still in this set but absent from a later snapshot means its skills are
  // now stale and only a new session can drop them.
  private readonly loadedPluginSkillIds = new Set<string>();
  metadata: SessionMeta = {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: 'New Session',
    isCustomTitle: false,
    agents: {},
    custom: {},
  };
  private writeMetadataPromise = Promise.resolve();

  constructor(public readonly options: SessionOptions) {
    // Attach the per-session log sink up front so the constructor's
    // fire-and-forget `loadSkills` / `loadMcpServers` failures (and
    // anything else that races) land in the session log, not just global.
    this.logHandle =
      options.id === undefined
        ? undefined
        : getRootLogger().attachSession({
            sessionId: options.id,
            sessionDir: options.homedir,
          });
    this.log =
      this.logHandle?.logger ??
      (options.id === undefined ? log : log.createChild({ sessionId: options.id }));
    this.rpc = options.rpc;
    this.hookEngine = new HookEngine(options.hooks, {
      cwd: options.kaos.getcwd(),
      sessionId: options.id,
    });
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    this.skills = new SkillRegistry({ sessionId: options.id });
    this.mcp = new McpConnectionManager({
      oauthService: new McpOAuthService({ kimiHomeDir: options.kimiHomeDir }),
      log: this.log,
    });
    this.mcp.onStatusChange((entry) => {
      this.onMcpServerStatusChange(entry);
    });
    this.skillsReady = this.loadSkills()
      .catch((error: unknown) => {
        this.log.error('skills load failed', error);
      })
      .then(() => {
        this.refreshAgentBuiltinTools();
      });
    void this.loadMcpServers().catch((error: unknown) => {
      this.emitInitialMcpLoadError(error);
    });
  }

  async createMain() {
    const { agent } = await this.createAgent({ type: 'main' }, DEFAULT_AGENT_PROFILES['agent']);
    await this.triggerSessionStart('startup');
    return agent;
  }

  async resume(): Promise<{ warning?: string }> {
    await this.skillsReady;
    const { agents } = await this.readMetadata();
    this.agents.clear();
    let warning: string | undefined;
    const resumeTasks = Object.keys(agents).map(async (id) => {
      const agent = this.ensureResumeAgentInstantiated(id, agents);
      const result = await agent.resume();
      if (result.warning !== undefined && warning === undefined) {
        warning = result.warning;
      }
    });
    await Promise.all(resumeTasks);
    const resumeWarning = warning;
    // A session migrated from an external tool ships a wire without the
    // `config.update` bootstrap events a natively-created agent writes, so the
    // main agent comes back with an empty system prompt and no tools. Apply the
    // default profile so the resumed session is usable. Native sessions always
    // replay a non-empty system prompt and never enter this branch.
    const main = this.agents.get('main');
    const profile = DEFAULT_AGENT_PROFILES['agent'];
    if (main !== undefined && profile !== undefined && main.config.systemPrompt === '') {
      await this.bootstrapAgentProfile(main, profile);
    }
    await this.triggerSessionStart('resume');
    return { warning: resumeWarning };
  }

  async close(): Promise<void> {
    try {
      await Promise.allSettled(
        Array.from(this.agents.values(), async (agent) => agent.cron?.stop()),
      );
      await this.stopBackgroundTasksOnExit();
      await this.flushMetadata();
      await this.triggerSessionEnd('exit');
    } finally {
      try {
        await this.mcp.shutdown();
      } finally {
        await this.logHandle?.close();
      }
    }
  }

  private async stopBackgroundTasksOnExit(): Promise<void> {
    const keepAliveOnExit = resolveConfigValue({
      env: process.env,
      envKey: BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV,
      configValue: this.options.background?.keepAliveOnExit,
      defaultValue: true,
      parseEnv: parseBooleanEnv,
    });
    if (keepAliveOnExit) return;
    await Promise.all(
      Array.from(this.agents.values(), (agent) =>
        agent.background.stopAll('Session closed'),
      ),
    );
  }

  async createAgent(
    config: Partial<AgentOptions>,
    profile?: ResolvedAgentProfile,
    parentAgentId?: string | undefined,
  ): Promise<{ readonly id: string; readonly agent: Agent }> {
    await this.skillsReady;
    const type = config.type ?? 'main';
    const id = type === 'main' ? 'main' : this.nextGeneratedAgentId();
    const homedir = config.homedir ?? join(this.options.homedir, 'agents', id);
    const agent = this.instantiateAgent(id, homedir, type, config, parentAgentId ?? null);
    if (profile) {
      await this.bootstrapAgentProfile(agent, profile);
    }

    this.agents.set(id, agent);
    this.metadata.agents[id] = {
      homedir,
      type,
      parentAgentId: parentAgentId ?? null,
    };
    void this.writeMetadata();

    return { id, agent };
  }

  /**
   * Applies a profile's derived config — cwd, system prompt, active tools — to
   * an agent. Fresh creation and resume-of-an-incomplete-wire both route
   * through here so the two paths cannot drift apart.
   */
  private async bootstrapAgentProfile(
    agent: Agent,
    profile: ResolvedAgentProfile,
  ): Promise<void> {
    const context = await prepareSystemPromptContext(agent.kaos);
    agent.useProfile(profile, context);
  }

  async generateAgentsMd(): Promise<void> {
    await this.skillsReady;
    const mainAgent = this.requireMainAgent();

    try {
      const handle = await mainAgent.subagentHost!.spawn('coder', {
        parentToolCallId: 'generate-agents-md',
        prompt: DEFAULT_INIT_PROMPT,
        description: 'Initialize AGENTS.md',
        runInBackground: false,
        origin: { kind: 'system_trigger', name: 'init' },
        signal: new AbortController().signal,
      });
      await handle.completion;

      const agentsMd = await loadAgentsMd(mainAgent.kaos);
      mainAgent.context.appendSystemReminder(initCompletionReminder(agentsMd), {
        kind: 'injection',
        variant: 'init',
      });
      await mainAgent.records.flush();
    } catch (error) {
      throw new KimiError(
        ErrorCodes.SESSION_INIT_FAILED,
        error instanceof Error ? error.message : 'Init failed',
        { cause: error },
      );
    }
  }

  get hasActiveTurn(): boolean {
    for (const agent of this.agents.values()) {
      if (agent.turn.hasActiveTurn) return true;
    }
    return false;
  }

  protected get metadataPath() {
    return join(this.options.homedir, 'state.json');
  }

  writeMetadata() {
    const text = JSON.stringify(this.metadata, null, 2);
    const write = async () => {
      await this.options.kaos.mkdir(this.options.homedir, { parents: true, existOk: true });
      await this.options.kaos.writeText(this.metadataPath, text);
    };
    this.writeMetadataPromise = this.writeMetadataPromise.then(write, write);
    return this.writeMetadataPromise;
  }

  async readMetadata() {
    const text = await this.options.kaos.readText(this.metadataPath);
    this.metadata = JSON.parse(text);
    return this.metadata;
  }

  async flushMetadata() {
    await this.skillsReady;
    await this.writeMetadataPromise;
    await Promise.all(Array.from(this.agents.values()).map((agent) => agent.records.flush()));
  }

  async listSkills(): Promise<readonly SkillSummary[]> {
    await this.skillsReady;
    return this.skills.listSkills().map(summarizeSkill);
  }

  /**
   * Hot-apply a plugin runtime snapshot to this live session. Additive only:
   * newly enabled plugin skills are loaded and the main agent's system prompt
   * is re-rendered so the model sees them; the `Skill` builtin tool is
   * refreshed so it appears when skills first become available; and newly
   * enabled plugin MCP servers are connected (their tools register via the MCP
   * status subscription and are picked up on the next turn). Disabled/removed
   * capabilities are NOT torn down and sessionStart skills are NOT injected
   * mid-conversation — those are reported via `needsNewSession`.
   */
  async applyPluginRuntimeSnapshot(
    snapshot: PluginRuntimeSnapshot,
  ): Promise<PluginRuntimeApplyResult> {
    await this.skillsReady;

    // Skills: re-resolve roots with the snapshot's plugin roots and merge them
    // in. loadRoots skips already-loaded roots, so only new ones are scanned.
    const before = new Set(this.skills.listSkills().map((skill) => skill.name));
    const roots = await resolveSkillRoots({
      paths: {
        userHomeDir: this.options.skills?.userHomeDir ?? homedir(),
        workDir: this.options.kaos.getcwd(),
      },
      explicitDirs: this.options.skills?.explicitDirs,
      extraDirs: this.options.skills?.extraDirs,
      pluginSkillRoots: snapshot.pluginSkillRoots,
      mergeAllAvailableSkills: this.options.skills?.mergeAllAvailableSkills,
      builtinDir: this.options.skills?.builtinDir,
    });
    await this.skills.loadRoots(roots);
    this.rememberLoadedPluginSkills(snapshot.pluginSkillRoots);
    const addedSkills = this.skills
      .listSkills()
      .map((skill) => skill.name)
      .filter((name) => !before.has(name));

    // Builtin tools: rebuild so the `Skill` tool appears once skills exist.
    this.refreshAgentBuiltinTools();

    // System prompt: re-render the main agent's prompt so the model sees the
    // new skills. Active tools are intentionally left untouched.
    const main = this.agents.get('main');
    const profile = DEFAULT_AGENT_PROFILES['agent'];
    if (main !== undefined && profile !== undefined) {
      const context = await prepareSystemPromptContext(main.kaos);
      main.rerenderSystemPrompt(profile, context);
    }

    // MCP: connect only servers not already present; never reconnect existing.
    const existingServers = new Set(this.mcp.list().map((entry) => entry.name));
    const newServers = Object.fromEntries(
      Object.entries(snapshot.mcpServers).filter(([name]) => !existingServers.has(name)),
    );
    const newServerNames = Object.keys(newServers);
    if (newServerNames.length > 0) {
      await this.mcp.connect(newServers);
    }
    // Report only servers that actually came online. connect() awaits each
    // spawn, so by now every entry has settled; a failed / needs-auth server
    // must not be announced as "now active".
    const addedMcpServers = newServerNames.filter(
      (name) => this.mcp.get(name)?.status === 'connected',
    );

    return {
      addedSkills,
      addedMcpServers,
      needsNewSession: this.pluginRuntimeNeedsNewSession(snapshot, main),
    };
  }

  /**
   * Whether the live session still differs from the snapshot in a way only a
   * new session can reconcile: skills from a now-disabled/removed plugin still
   * loaded in the registry, a plugin MCP server still connected but no longer
   * enabled (disable/remove can't be cleanly torn down), or a drift between the
   * desired and currently-active sessionStart injections.
   */
  private pluginRuntimeNeedsNewSession(
    snapshot: PluginRuntimeSnapshot,
    main: Agent | undefined,
  ): boolean {
    // Skills: loadRoots is additive, so a plugin whose skills are still in the
    // registry but is no longer in the snapshot leaves stale skills behind.
    const desiredSkillPlugins = new Set(
      snapshot.pluginSkillRoots
        .map((root) => root.plugin?.id)
        .filter((id): id is string => id !== undefined),
    );
    const stalePluginSkills = [...this.loadedPluginSkillIds].some(
      (id) => !desiredSkillPlugins.has(id),
    );
    if (stalePluginSkills) return true;

    const desiredServers = new Set(Object.keys(snapshot.mcpServers));
    const stalePluginServer = this.mcp
      .list()
      .some((entry) => entry.name.startsWith('plugin-') && !desiredServers.has(entry.name));
    if (stalePluginServer) return true;

    const activeStarts = new Set(
      (main?.pluginSessionStarts ?? []).map((start) => `${start.pluginId}:${start.skillName}`),
    );
    const desiredStarts = snapshot.sessionStarts.map(
      (start) => `${start.pluginId}:${start.skillName}`,
    );
    if (desiredStarts.length !== activeStarts.size) return true;
    return desiredStarts.some((key) => !activeStarts.has(key));
  }

  private async loadSkills(): Promise<void> {
    const roots = await resolveSkillRoots({
      paths: {
        userHomeDir: this.options.skills?.userHomeDir ?? homedir(),
        workDir: this.options.kaos.getcwd(),
      },
      explicitDirs: this.options.skills?.explicitDirs,
      extraDirs: this.options.skills?.extraDirs,
      pluginSkillRoots: this.options.skills?.pluginSkillRoots,
      mergeAllAvailableSkills: this.options.skills?.mergeAllAvailableSkills,
      builtinDir: this.options.skills?.builtinDir,
    });
    await this.skills.loadRoots(roots);
    registerBuiltinSkills(this.skills);
    this.rememberLoadedPluginSkills(this.options.skills?.pluginSkillRoots);
  }

  private rememberLoadedPluginSkills(roots: readonly SkillRoot[] | undefined): void {
    for (const root of roots ?? []) {
      if (root.plugin?.id !== undefined) this.loadedPluginSkillIds.add(root.plugin.id);
    }
  }

  private async loadMcpServers(): Promise<void> {
    const servers = this.options.mcpConfig?.servers;
    if (servers === undefined || Object.keys(servers).length === 0) return;
    await this.mcp.connectAll(servers);
    const entries = this.mcp.list().filter((entry) => entry.status !== 'disabled');
    const totalCount = entries.length;
    if (totalCount === 0) return;

    const connectedCount = entries.filter((entry) => entry.status === 'connected').length;
    if (connectedCount > 0) {
      this.telemetry.track('mcp_connected', {
        server_count: connectedCount,
        total_count: totalCount,
      });
    }

    const failedCount = entries.filter((entry) => entry.status === 'failed').length;
    if (failedCount > 0) {
      this.telemetry.track('mcp_failed', {
        failed_count: failedCount,
        total_count: totalCount,
      });
    }
  }

  private emitInitialMcpLoadError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.log.error('mcp initial load failed', error);
    void this.rpc.emitEvent({
      type: 'error',
      agentId: 'main',
      ...makeErrorPayload(ErrorCodes.MCP_STARTUP_FAILED, message),
    });
  }

  private onMcpServerStatusChange(entry: McpServerEntry): void {
    // Always surface server-level status changes to clients so the TUI/SDK
    // can keep its dashboard in sync, even before the main agent exists.
    void this.rpc.emitEvent({
      type: 'mcp.server.status',
      agentId: 'main',
      server: {
        name: entry.name,
        transport: entry.transport,
        status: entry.status,
        toolCount: entry.toolCount,
        error: entry.error,
      },
    });
  }

  private backgroundTaskTimeoutMs(): number | undefined {
    const timeoutS = this.options.background?.agentTaskTimeoutS;
    return timeoutS === undefined ? undefined : timeoutS * 1000;
  }

  private refreshAgentBuiltinTools(): void {
    for (const agent of this.agents.values()) {
      if (!agent.config.hasProvider) continue;
      agent.tools.initializeBuiltinTools();
    }
  }

  private instantiateAgent(
    id: string,
    homedir: string,
    type: AgentType,
    config: Partial<AgentOptions> = {},
    parentAgentId: string | null = null,
  ): Agent {
    const parentAgent = parentAgentId !== null ? this.agents.get(parentAgentId) : undefined;
    const cwd = parentAgent?.config.cwd ?? this.options.kaos.getcwd();
    return new Agent({
      ...config,
      type,
      kaos: this.options.kaos.withCwd(cwd),
      toolServices: this.options.toolServices,
      config: this.options.config,
      homedir,
      skills: this.skills,
      rpc: proxyWithExtraPayload(this.rpc, { agentId: id }),
      modelProvider: this.options.providerManager,
      hookEngine: config.hookEngine ?? this.hookEngine,
      subagentHost:
        config.subagentHost ?? new SessionSubagentHost(this, id, this.backgroundTaskTimeoutMs()),
      mcp: this.mcp,
      permission: this.permissionOptions(parentAgentId, config.permission),
      telemetry: this.telemetry,
      log: this.log.createChild({ agentId: id }),
      pluginSessionStarts: type === 'main' ? this.options.pluginSessionStarts : undefined,
    });
  }

  private permissionOptions(
    parentAgentId: string | null,
    input?: PermissionManagerOptions | undefined,
  ): PermissionManagerOptions {
    if (parentAgentId === null) {
      return {
        ...input,
        initialRules: input?.initialRules ?? this.options.permissionRules,
      };
    }
    return {
      ...input,
      parent: input?.parent ?? this.agents.get(parentAgentId)?.permission,
    };
  }

  private ensureResumeAgentInstantiated(
    id: string,
    agents: Record<string, AgentMeta>,
    stack: readonly string[] = [],
  ): Agent {
    const existing = this.agents.get(id);
    if (existing !== undefined) return existing;
    if (stack.includes(id)) {
      throw new KimiError(
        ErrorCodes.SESSION_STATE_INVALID,
        `Session agent parent chain contains a cycle: ${[...stack, id].join(' -> ')}`,
      );
    }

    const meta = agents[id];
    if (meta === undefined) {
      throw new KimiError(ErrorCodes.SESSION_STATE_INVALID, `Session agent "${id}" is missing`);
    }

    const parentAgentId = meta.parentAgentId ?? null;
    if (parentAgentId !== null) {
      this.ensureResumeAgentInstantiated(parentAgentId, agents, [...stack, id]);
    }

    const agent = this.instantiateAgent(id, meta.homedir, meta.type, {}, parentAgentId);
    this.agents.set(id, agent);
    return agent;
  }

  private nextGeneratedAgentId(): string {
    while (true) {
      const id = `agent-${this.agentIdCounter++}`;
      if (this.agents.has(id)) continue;
      if (this.metadata.agents[id] !== undefined) continue;
      return id;
    }
  }

  private requireMainAgent(): Agent {
    const agent = this.agents.get('main');
    if (agent === undefined) {
      throw new KimiError(ErrorCodes.AGENT_NOT_FOUND, 'Main agent was not found');
    }
    return agent;
  }

  private async triggerSessionStart(source: 'startup' | 'resume'): Promise<void> {
    await this.hookEngine.trigger('SessionStart', {
      matcherValue: source,
      inputData: { source },
    });
  }

  private async triggerSessionEnd(reason: 'exit'): Promise<void> {
    await this.hookEngine.trigger('SessionEnd', {
      matcherValue: reason,
      inputData: { reason },
    });
  }
}

export * from './subagent-host';

function initCompletionReminder(agentsMd: string): string {
  const latest =
    agentsMd.trim().length === 0
      ? 'No AGENTS.md content was found after `/init` completed.'
      : agentsMd;
  return [
    'The user just ran `/init` slash command.',
    'The system has analyzed the codebase and generated an `AGENTS.md` file.',
    '',
    'Latest AGENTS.md file content:',
    latest,
  ].join('\n');
}
