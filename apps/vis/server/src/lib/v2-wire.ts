/**
 * Local type/value copies from `@moonshot-ai/agent-core-v2` — the wire
 * protocol contract only (v2 persistent records + migration chain).
 *
 * The v2 engine was removed from the repo (P157-P162), but vis replays
 * session files (wire.jsonl) that the engine wrote. Those files are
 * versioned by the wire protocol, so a local copy stays in sync by
 * definition — same rationale as ./v1-compat.ts for the v1 records.
 *
 * Only the subset used by vis is included.
 */

import type {
  ContentPart,
  FinishReason,
  TokenUsage,
} from '@moonshot-ai/kosong';
import type { KimiErrorPayload } from '@moonshot-ai/protocol';

import type {
  ContextMessage,
  LoopRecordedEvent,
  PromptOrigin,
} from './v1-compat';

// ════════════════════════════════════════════════════════════════════════════
// Wire protocol version
// ════════════════════════════════════════════════════════════════════════════

export const WIRE_PROTOCOL_VERSION = '1.5';

export interface WireMigrationRecord {
  readonly type: string;
  readonly time?: number;
  [key: string]: unknown;
}

export interface WireMigration {
  readonly sourceVersion: string;
  readonly targetVersion: string;
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord;
}

// ════════════════════════════════════════════════════════════════════════════
// Agent task records
// ════════════════════════════════════════════════════════════════════════════

export type AgentTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'killed'
  | 'lost';

export interface AgentTaskInfoBase {
  readonly taskId: string;
  readonly description: string;
  readonly status: AgentTaskStatus;
  readonly detached?: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly stopReason?: string;
  readonly terminalNotificationSuppressed?: boolean;
  readonly resumeReminded?: boolean;
  readonly timeoutMs?: number;
}

export interface ProcessTaskInfo extends AgentTaskInfoBase {
  readonly kind: 'process';
  readonly command: string;
  readonly pid: number;
  readonly exitCode: number | null;
  readonly parentToolCallId?: string;
}

export interface SubagentTaskInfo extends AgentTaskInfoBase {
  readonly kind: 'agent';
  readonly agentId?: string;
  readonly subagentType?: string;
  readonly parentToolCallId?: string;
  readonly model?: string;
  readonly thinkingEffort?: string;
}

export interface QuestionTaskInfo extends AgentTaskInfoBase {
  readonly kind: 'question';
  readonly questionCount: number;
  readonly toolCallId?: string;
}

export type AgentTaskInfo = ProcessTaskInfo | SubagentTaskInfo | QuestionTaskInfo;
export type AgentTaskInfoByKind = {
  readonly process: ProcessTaskInfo;
  readonly agent: SubagentTaskInfo;
  readonly question: QuestionTaskInfo;
};
export type AgentTaskKind = Extract<keyof AgentTaskInfoByKind, string>;

// ════════════════════════════════════════════════════════════════════════════
// Cron records
// ════════════════════════════════════════════════════════════════════════════

export interface CronTask {
  readonly id: string;
  readonly cron: string;
  readonly prompt: string;
  readonly createdAt: number;
  readonly recurring?: boolean;
  readonly lastFiredAt?: number;
  readonly tags?: Readonly<Record<string, string>>;
}

export interface CronAddPayload {
  readonly task: CronTask;
}

export interface CronDeletePayload {
  readonly ids: readonly string[];
}

export interface CronCursorPayload {
  readonly id: string;
  readonly lastFiredAt: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Goal records
// ════════════════════════════════════════════════════════════════════════════

export type GoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'complete'
  | 'budget_limited'
  | 'usage_limited';

export type GoalActor = 'user' | 'model' | 'runtime' | 'system';

export interface GoalBudgetLimits {
  readonly tokenBudget?: number;
  readonly turnBudget?: number;
  readonly wallClockBudgetMs?: number;
}

export interface GoalCreate {
  readonly agentId: string;
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly wallClockResumedAt?: number;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly status?: GoalStatus;
  readonly actor?: GoalActor;
  readonly budgetLimits?: GoalBudgetLimits;
}

export interface GoalUpdate {
  readonly agentId: string;
  readonly goalId?: string;
  readonly status?: GoalStatus;
  readonly reason?: string;
  readonly turnsUsed?: number;
  readonly tokensUsed?: number;
  readonly wallClockMs?: number;
  readonly wallClockResumedAt?: number;
  readonly inputTokensUsed?: number;
  readonly outputTokensUsed?: number;
  readonly updatedAt?: number;
  readonly budgetLimits?: GoalBudgetLimits;
  readonly actor?: GoalActor;
}

export interface GoalClear {
  readonly agentId: string;
}

export interface GoalForked {
  readonly agentId: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Compaction records
// ════════════════════════════════════════════════════════════════════════════

export type CompactionSource = 'manual' | 'auto';

export interface CompactionBeginData {
  readonly instruction?: string;
  readonly source: CompactionSource;
}

export interface CompactionResult {
  readonly summary: string;
  readonly contextSummary?: string;
  readonly compactedCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly keptUserMessageCount?: number;
  readonly keptHeadUserMessageCount?: number;
  readonly droppedCount?: number;
}

export interface FullCompactionBegin extends CompactionBeginData {
  readonly agentId: string;
}

export interface FullCompactionCancel {
  readonly agentId: string;
}

export interface FullCompactionComplete {
  readonly agentId: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Interaction records
// ════════════════════════════════════════════════════════════════════════════

export type InteractionKind = 'approval' | 'question' | 'user_tool';

export interface InteractionRequestEvent {
  readonly agentId: string;
  readonly id: string;
  readonly kind: InteractionKind;
  readonly toolCallId?: string;
  readonly request: unknown;
}

export interface InteractionResolvedEvent {
  readonly agentId: string;
  readonly id: string;
  readonly response: unknown;
}

// ════════════════════════════════════════════════════════════════════════════
// Interruption reminder records
// ════════════════════════════════════════════════════════════════════════════

export interface InterruptionReminderRecorded {
  readonly agentId: string;
  readonly turnId: number;
}

// ════════════════════════════════════════════════════════════════════════════
// LLM request records
// ════════════════════════════════════════════════════════════════════════════

export interface LlmRequestToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface LlmToolsSnapshot {
  readonly agentId: string;
  readonly hash: string;
  readonly tools: readonly LlmRequestToolSchema[];
}

export interface LlmRequest {
  readonly agentId: string;
  readonly kind: 'loop' | 'compaction';
  readonly provider: string;
  readonly model: string;
  readonly modelAlias?: string;
  readonly thinkingEffort?: string;
  readonly thinkingKeep?: string;
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxTokens?: number;
  readonly betaApi?: boolean;
  readonly toolSelect: boolean;
  readonly systemPromptHash: string;
  readonly systemPrompt?: string;
  readonly toolsHash: string;
  readonly messageCount: number;
  readonly turnStep?: string;
  readonly attempt?: string;
  readonly projection?:
    | 'strict'
    | 'media-degraded'
    | 'media-stripped'
    | 'strict-media-degraded'
    | 'strict-media-stripped';
  readonly droppedCount?: number;
}

// ════════════════════════════════════════════════════════════════════════════
// MCP discovery records
// ════════════════════════════════════════════════════════════════════════════

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface McpToolCollision {
  readonly qualified: string;
  readonly toolName: string;
  readonly collidesWith:
    | { readonly kind: 'same_server'; readonly toolName: string }
    | { readonly kind: 'other_server'; readonly serverName: string };
}

export interface McpToolsDiscovered {
  readonly agentId: string;
  readonly serverName: string;
  readonly hash: string;
  readonly tools: readonly MCPToolDefinition[];
  readonly enabledNames: readonly string[];
  readonly collisions?: readonly McpToolCollision[];
}

// ════════════════════════════════════════════════════════════════════════════
// Permission records
// ════════════════════════════════════════════════════════════════════════════

export interface ApprovalResponse {
  readonly decision: 'approved' | 'denied' | 'blocked' | 'cancelled';
  readonly scope?: 'session';
  readonly feedback?: string;
  readonly selectedLabel?: string;
}

export interface PermissionApprovalResultRecord {
  readonly turnId: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly sessionApprovalRule?: string;
  readonly result: ApprovalResponse;
}

export interface PermissionSetMode {
  readonly agentId: string;
  readonly mode: 'manual' | 'yolo' | 'auto';
}

export interface PermissionRecordApprovalResult extends PermissionApprovalResultRecord {
  readonly agentId: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Plan records
// ════════════════════════════════════════════════════════════════════════════

export interface PlanModeEnter {
  readonly agentId: string;
  readonly id: string;
}

export interface PlanModeCancel {
  readonly agentId: string;
  readonly id?: string;
}

export interface PlanModeExit {
  readonly agentId: string;
  readonly id?: string;
}

export interface PlanRevision {
  readonly agentId: string;
  readonly id: string;
  readonly version: number;
  readonly key: string;
  readonly sha256: string;
  readonly bytes: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Plugin records
// ════════════════════════════════════════════════════════════════════════════

export interface PluginSessionStartEvent {
  readonly agentId: string;
  readonly content: string | null;
}

// ════════════════════════════════════════════════════════════════════════════
// Profile records
// ════════════════════════════════════════════════════════════════════════════

export interface EnvironmentDisclosureSnapshot {
  readonly cwd: string;
}

export interface ProfileBind {
  readonly agentId: string;
  readonly modelAlias?: string;
  readonly profileName?: string;
  readonly thinkingEffort: string;
  readonly systemPrompt: string;
  readonly environmentDisclosure?: EnvironmentDisclosureSnapshot;
  readonly renderGeneration?: number;
  readonly agentsMdPaths?: readonly string[];
  readonly activeToolNames?: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly subagents?: readonly string[];
}

export interface ConfigUpdate {
  readonly agentId: string;
  readonly modelAlias?: string;
  readonly profileName?: string;
  readonly thinkingEffort?: string;
  readonly thinkingLevel?: string;
  readonly systemPrompt?: string;
  readonly environmentDisclosure?: EnvironmentDisclosureSnapshot;
  readonly renderGeneration?: number;
  readonly agentsMdPaths?: readonly string[];
  readonly disallowedTools?: readonly string[];
}

export interface ToolsSetActiveTools {
  readonly agentId: string;
  readonly names: readonly string[];
}

export interface ToolsResetActiveTools {
  readonly agentId: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Prompt records
// ════════════════════════════════════════════════════════════════════════════

export interface PromptAccepted {
  readonly agentId: string;
  readonly promptId: string;
  readonly content?: unknown;
}

export interface PromptCompleted {
  readonly agentId: string;
  readonly promptId: string;
  readonly finishedAt: string;
  readonly reason: 'completed' | 'failed' | 'blocked';
}

export interface PromptAborted {
  readonly agentId: string;
  readonly promptId: string;
  readonly abortedAt: string;
}

export interface PromptSteered {
  readonly agentId: string;
  readonly activePromptId: string;
  readonly promptIds: string[];
  readonly content: ContentPart[];
  readonly steeredAt: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Runtime binding records
// ════════════════════════════════════════════════════════════════════════════

export interface RuntimeSetBinding {
  readonly agentId: string;
  readonly workspaceId: string;
  readonly runtimeId: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Stale guard records
// ════════════════════════════════════════════════════════════════════════════

export interface StaleGuardRecorded {
  readonly path: string;
  readonly mtimeMs: number;
}

export interface StaleGuardCleared {}

// ════════════════════════════════════════════════════════════════════════════
// Swarm / Tower / Task / Todo records
// ════════════════════════════════════════════════════════════════════════════

export type SwarmModeTrigger = 'manual' | 'task' | 'tool';

export interface SwarmModeEnter {
  readonly agentId: string;
  readonly trigger: SwarmModeTrigger;
}

export interface SwarmModeExit {
  readonly agentId: string;
}

export interface TowerModeEnter {
  readonly agentId: string;
  readonly sessionId?: string;
  readonly base?: string;
}

export interface TowerModeExit {
  readonly agentId: string;
}

export interface TaskStarted {
  readonly agentId: string;
  readonly info: AgentTaskInfo;
}

export interface TaskTerminated {
  readonly agentId: string;
  readonly info: AgentTaskInfo;
  readonly outputTail?: string;
}

export interface TaskWaitDelivered {
  readonly agentId: string;
  readonly keys: string[];
}

export interface ToolsUpdateStore {
  readonly agentId: string;
  readonly key: string;
  readonly value: unknown;
}

// ════════════════════════════════════════════════════════════════════════════
// Token counting records
// ════════════════════════════════════════════════════════════════════════════

export interface TokenCountingMeasured {
  readonly agentId: string;
  readonly length: number;
  readonly tokens: number;
}

export interface TokenCountingTruncated {
  readonly agentId: string;
  readonly length: number;
  readonly tokens: number;
}

export interface TokenCountingRebased {
  readonly agentId: string;
  readonly length: number;
  readonly tokens: number;
  readonly measured: boolean;
}

export interface TokenCountingTurnRecorded {
  readonly agentId: string;
  readonly length: number;
  readonly tokens: number;
  readonly turnId: number;
}

// ════════════════════════════════════════════════════════════════════════════
// User tool records
// ════════════════════════════════════════════════════════════════════════════

export interface UserToolRegistration {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly disclosure?: unknown;
}

export interface ToolsRegisterUserTool extends UserToolRegistration {
  readonly agentId: string;
}

export interface ToolsUnregisterUserTool {
  readonly agentId: string;
  readonly name: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Usage records
// ════════════════════════════════════════════════════════════════════════════

export type UsageRecordScope = 'session' | 'turn';

export interface UsageRecord {
  readonly agentId: string;
  readonly model: string;
  readonly usage: TokenUsage;
  readonly usageScope?: UsageRecordScope;
}

// ════════════════════════════════════════════════════════════════════════════
// Turn records
// ════════════════════════════════════════════════════════════════════════════

export interface TurnPrompt {
  readonly agentId: string;
  readonly input: readonly ContentPart[];
  readonly origin: PromptOrigin;
  readonly promptId?: string;
}

export interface TurnSteer {
  readonly agentId: string;
  readonly input: readonly ContentPart[];
  readonly origin: PromptOrigin;
}

export interface TurnCancel {
  readonly agentId: string;
  readonly turnId?: number;
  readonly target?: 'active' | 'queued';
  readonly reason?: 'user_cancelled' | 'aborted';
}

export type TurnEndReason = 'completed' | 'cancelled' | 'failed' | 'blocked';

export type TurnInterruptReason =
  | 'user_cancelled'
  | 'aborted'
  | 'max_steps'
  | 'error'
  | 'filtered'
  | 'blocked';

export interface TurnEnded {
  readonly agentId: string;
  readonly turnId: number;
  readonly reason: TurnEndReason;
  readonly error?: KimiErrorPayload;
  readonly durationMs?: number;
  readonly interruptReason?: TurnInterruptReason;
}

export interface TurnStepInterrupted {
  readonly agentId: string;
  readonly turnId: number;
  readonly step: number;
  readonly stepId?: string;
  readonly reason: string;
  readonly message?: string;
}

export interface TurnStepRetrying {
  readonly agentId: string;
  readonly turnId: number;
  readonly step: number;
  readonly stepId?: string;
  readonly failedAttempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

export interface TurnStepCompleted {
  readonly agentId: string;
  readonly turnId: number;
  readonly step: number;
  readonly stepId?: string;
  readonly usage?: TokenUsage;
  readonly finishReason?: string;
  readonly llmFirstTokenLatencyMs?: number;
  readonly llmStreamDurationMs?: number;
  readonly llmRequestBuildMs?: number;
  readonly llmServerFirstTokenMs?: number;
  readonly llmServerDecodeMs?: number;
  readonly llmClientConsumeMs?: number;
  readonly providerFinishReason?: FinishReason;
  readonly rawFinishReason?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Context records
// ════════════════════════════════════════════════════════════════════════════

export interface ContextAppendMessage {
  readonly agentId: string;
  readonly message: ContextMessage;
}

export interface ContextAppendLoopEvent {
  readonly agentId: string;
  readonly event: LoopRecordedEvent;
}

export interface ContextClear {
  readonly agentId: string;
}

export type ContextApplyCompactionPayload =
  | {
      readonly agentId: string;
      readonly tokensBefore?: number;
      readonly tokensAfter?: number;
      readonly summaryOutputTokens?: number;
      readonly keptUserMessageCount?: number;
      readonly keptHeadUserMessageCount?: number;
      readonly droppedCount?: number;
      readonly legacyTail?: boolean;
      readonly summary: string;
      readonly compactedCount: number;
      readonly contextSummary?: string;
    }
  | {
      readonly agentId: string;
      readonly tokensBefore?: number;
      readonly tokensAfter?: number;
      readonly summaryOutputTokens?: number;
      readonly keptUserMessageCount?: number;
      readonly keptHeadUserMessageCount?: number;
      readonly droppedCount?: number;
      readonly legacyTail?: boolean;
      readonly contextSummary: string;
      readonly compactedCount: number;
      readonly summary?: string;
    }
  | {
      readonly agentId: string;
      readonly tokensBefore?: number;
      readonly tokensAfter?: number;
      readonly summaryOutputTokens?: number;
      readonly keptUserMessageCount?: number;
      readonly keptHeadUserMessageCount?: number;
      readonly droppedCount?: number;
      readonly legacyTail?: boolean;
      readonly summary: ContextMessage;
      readonly count: number;
      readonly compactedCount?: number;
    };

export interface ContextUndo {
  readonly agentId: string;
  readonly count: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Wire record type map — every durable record type (v2 protocol 1.5)
// ════════════════════════════════════════════════════════════════════════════

export interface WireRecordEvents {
  'config.update': ConfigUpdate;
  'context.append_loop_event': ContextAppendLoopEvent;
  'context.append_message': ContextAppendMessage;
  'context.apply_compaction': ContextApplyCompactionPayload;
  'context.clear': ContextClear;
  'context.undo': ContextUndo;
  'cron.add': CronAddPayload;
  'cron.cursor': CronCursorPayload;
  'cron.delete': CronDeletePayload;
  forked: GoalForked;
  'full_compaction.begin': FullCompactionBegin;
  'full_compaction.cancel': FullCompactionCancel;
  'full_compaction.complete': FullCompactionComplete;
  'goal.clear': GoalClear;
  'goal.create': GoalCreate;
  'goal.update': GoalUpdate;
  'interaction.request': InteractionRequestEvent;
  'interaction.resolved': InteractionResolvedEvent;
  'interruptionReminder.recorded': InterruptionReminderRecorded;
  'llm.request': LlmRequest;
  'llm.tools_snapshot': LlmToolsSnapshot;
  'mcp.tools_discovered': McpToolsDiscovered;
  'permission.record_approval_result': PermissionRecordApprovalResult;
  'permission.set_mode': PermissionSetMode;
  'plan_mode.cancel': PlanModeCancel;
  'plan_mode.enter': PlanModeEnter;
  'plan_mode.exit': PlanModeExit;
  'plan.revision': PlanRevision;
  'plugin.session_start': PluginSessionStartEvent;
  'profile.bind': ProfileBind;
  'prompt.aborted': PromptAborted;
  'prompt.accepted': PromptAccepted;
  'prompt.completed': PromptCompleted;
  'prompt.steered': PromptSteered;
  'runtime.set_binding': RuntimeSetBinding;
  'staleGuard.cleared': StaleGuardCleared;
  'staleGuard.recorded': StaleGuardRecorded;
  'swarm_mode.enter': SwarmModeEnter;
  'swarm_mode.exit': SwarmModeExit;
  'task.started': TaskStarted;
  'task.terminated': TaskTerminated;
  'task.waitDelivered': TaskWaitDelivered;
  'token_counting.measured': TokenCountingMeasured;
  'token_counting.rebased': TokenCountingRebased;
  'token_counting.truncated': TokenCountingTruncated;
  'token_counting.turn_recorded': TokenCountingTurnRecorded;
  'tools.register_user_tool': ToolsRegisterUserTool;
  'tools.reset_active_tools': ToolsResetActiveTools;
  'tools.set_active_tools': ToolsSetActiveTools;
  'tools.unregister_user_tool': ToolsUnregisterUserTool;
  'tools.update_store': ToolsUpdateStore;
  'tower_mode.enter': TowerModeEnter;
  'tower_mode.exit': TowerModeExit;
  'turn.cancel': TurnCancel;
  'turn.ended': TurnEnded;
  'turn.prompt': TurnPrompt;
  'turn.steer': TurnSteer;
  'turn.step.interrupted': TurnStepInterrupted;
  'turn.step.retrying': TurnStepRetrying;
  'usage.record': UsageRecord;
}

export type WireRecordOf<K extends keyof WireRecordEvents> = WireRecordEvents[K];

// ════════════════════════════════════════════════════════════════════════════
// Migration chain: 1.0 → 1.5 (v2-era chains identical to v1 up to 1.4; the
// step to 1.5 backfills wallClockResumedAt on active goal records)
// ════════════════════════════════════════════════════════════════════════════

function compareWireVersions(a: string, b: string): number {
  const partsA = a.split('.');
  const partsB = b.split('.');
  const maxLength = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < maxLength; i++) {
    const diff = Number(partsA[i] ?? '0') - Number(partsB[i] ?? '0');
    if (diff !== 0) return diff;
  }
  return 0;
}

const migrateV1_0ToV1_1: WireMigration = {
  sourceVersion: '1.0',
  targetVersion: '1.1',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    if (record.type !== 'context.append_message') return record;
    const msg = record['message'] as Record<string, unknown> | undefined;
    if (msg === undefined) return record;
    const toolCalls = msg['toolCalls'];
    if (!Array.isArray(toolCalls)) return record;
    return {
      ...record,
      message: {
        ...msg,
        toolCalls: toolCalls.map((tc: Record<string, unknown>) => {
          const fn = tc['function'] as Record<string, unknown> | undefined;
          if (fn === undefined) return tc;
          const { function: _fn, ...rest } = tc;
          return { ...rest, name: fn['name'], arguments: fn['arguments'] };
        }),
      },
    };
  },
};

const migrateV1_1ToV1_2: WireMigration = {
  sourceVersion: '1.1',
  targetVersion: '1.2',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    return record;
  },
};

const migrateV1_2ToV1_3: WireMigration = {
  sourceVersion: '1.2',
  targetVersion: '1.3',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    return record;
  },
};

const migrateV1_3ToV1_4: WireMigration = {
  sourceVersion: '1.3',
  targetVersion: '1.4',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    switch (record.type) {
      case 'goal.create':
        return {
          type: 'goal.create',
          agentId: record['agentId'],
          goalId: record['goalId'],
          objective: record['objective'],
          completionCriterion: record['completionCriterion'],
          status: record['status'],
          actor: record['actor'],
          budgetLimits: record['budgetLimits'],
          time: record['time'],
        } as WireMigrationRecord;
      case 'goal.update':
        return {
          type: 'goal.update',
          agentId: record['agentId'],
          goalId: record['goalId'],
          status: record['status'],
          reason: record['reason'],
          turnsUsed: record['turnsUsed'],
          tokensUsed: record['tokensUsed'],
          wallClockMs: record['wallClockMs'],
          inputTokensUsed: record['inputTokensUsed'],
          outputTokensUsed: record['outputTokensUsed'],
          actor: record['actor'],
          time: record['time'],
        } as WireMigrationRecord;
      case 'goal.clear':
        return { type: 'goal.clear', agentId: record['agentId'], time: record['time'] } as WireMigrationRecord;
      case 'goal.account_usage':
        return {
          type: 'goal.update',
          agentId: record['agentId'],
          tokensUsed: record['tokensUsed'],
          wallClockMs: record['wallClockMs'],
          time: record['time'],
        } as WireMigrationRecord;
      case 'goal.continuation':
        return {
          type: 'goal.update',
          agentId: record['agentId'],
          turnsUsed: record['turnsUsed'],
          time: record['time'],
        } as WireMigrationRecord;
      default:
        return record;
    }
  },
};

const migrateV1_4ToV1_5: WireMigration = {
  sourceVersion: '1.4',
  targetVersion: '1.5',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    if (!advancesActiveInterval(record)) return record;
    if (record['wallClockResumedAt'] !== undefined) return record;
    if (typeof record['time'] !== 'number') return record;
    return { ...record, wallClockResumedAt: record['time'] };
  },
};

function advancesActiveInterval(record: WireMigrationRecord): boolean {
  return (
    record.type === 'goal.create' ||
    (record.type === 'goal.update' &&
      (record['status'] === 'active' ||
        (record['status'] === undefined && typeof record['wallClockMs'] === 'number')))
  );
}

const MIGRATIONS: readonly WireMigration[] = [
  migrateV1_0ToV1_1,
  migrateV1_1ToV1_2,
  migrateV1_2ToV1_3,
  migrateV1_3ToV1_4,
  migrateV1_4ToV1_5,
];

export function isNewerWireVersion(readVersion: string): boolean {
  return compareWireVersions(readVersion, WIRE_PROTOCOL_VERSION) > 0;
}

export function resolveWireMigrations(readVersion: string): readonly WireMigration[] {
  if (compareWireVersions(readVersion, WIRE_PROTOCOL_VERSION) >= 0) {
    return [];
  }
  const migrations: WireMigration[] = [];
  let version = readVersion;
  while (compareWireVersions(version, WIRE_PROTOCOL_VERSION) < 0) {
    const migration = MIGRATIONS.find((m) => m.sourceVersion === version);
    if (migration === undefined) {
      throw new Error(`Missing wire migration for version ${version}`);
    }
    migrations.push(migration);
    version = migration.targetVersion;
  }
  return migrations;
}

export function migrateWireRecord(
  record: WireMigrationRecord,
  migrations: readonly WireMigration[],
): WireMigrationRecord {
  return migrations.reduce((current, migration) => migration.migrateRecord(current), record);
}

export function migrateWireRecords(
  records: readonly WireMigrationRecord[],
  readVersion: string | undefined,
): WireMigrationRecord[] {
  const migrations =
    readVersion === undefined ? MIGRATIONS : resolveWireMigrations(readVersion);
  return records.map((record) => migrateWireRecord(record, migrations));
}