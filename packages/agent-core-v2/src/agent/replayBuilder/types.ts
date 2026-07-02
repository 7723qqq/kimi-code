import type { BackgroundTaskInfo } from '#/agent/background';
import type { CompactionResult } from '#/agent/fullCompaction';
import type { AgentConfigData, AgentConfigUpdateData } from '#/agent/profile';
import type { AgentContextData, ContextMessage } from '#/agent/contextMemory';
import type { GoalChange, GoalSnapshot } from '#/agent/goal';
import type { PermissionApprovalResultRecord } from '#/agent/permissionRules';
import type { PermissionData, PermissionMode } from '#/agent/permissionPolicy';
import type { PlanData } from '#/agent/plan';
import type { ToolInfo } from '#/agent/tool';
import type { SessionSummary } from '#/agent/rpc/core-api';
import type { UsageStatus } from '@moonshot-ai/protocol';
import type { SessionMeta } from '#/session/sessionMetadata';

type AgentType = 'main' | 'sub';

export type AgentReplayRecordPayload =
  | { type: 'message'; message: ContextMessage }
  | { type: 'compaction'; result?: CompactionResult | 'cancelled'; instruction?: string }
  | {
      type: 'goal_updated';
      snapshot: GoalSnapshot;
      change: GoalChange | { readonly kind: 'created' };
    }
  | { type: 'plan_updated'; enabled: boolean }
  | { type: 'config_updated'; config: AgentConfigUpdateData }
  | { type: 'permission_updated'; mode: PermissionMode }
  | { type: 'approval_result'; record: PermissionApprovalResultRecord };

export type AgentReplayRecord = { readonly time: number } & AgentReplayRecordPayload;

export interface ResumedAgentState {
  readonly type: AgentType;
  readonly config: AgentConfigData;
  readonly context: AgentContextData;
  readonly replay: readonly AgentReplayRecord[];
  readonly permission: PermissionData;
  readonly plan: PlanData;
  readonly swarmMode?: boolean | undefined;
  readonly usage: UsageStatus;
  readonly tools: readonly ToolInfo[];
  readonly toolStore?: Readonly<Record<string, unknown>>;
  readonly background: readonly BackgroundTaskInfo[];
}

export interface ResumeSessionResult extends SessionSummary {
  readonly sessionMetadata: SessionMeta;
  readonly agents: Readonly<Record<string, ResumedAgentState>>;
  readonly warning?: string | undefined;
}
