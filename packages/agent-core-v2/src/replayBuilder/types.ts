import type { AgentType } from '#';
import type { BackgroundTaskInfo } from '#/background';
import type { CompactionResult } from '#/fullCompaction';
import type { AgentConfigData, AgentConfigUpdateData } from '#/config';
import type { AgentContextData, ContextMessage } from '#/contextMemory';
import type { GoalChange, GoalSnapshot } from '#/goal';
import type {
  PermissionApprovalResultRecord,
  PermissionData,
  PermissionMode,
} from '#/permission';
import type { PlanData } from '#/plan';
import type { ToolInfo } from '#/tool';
import type { SessionSummary } from '#/rpc/core-api';
import type { UsageStatus } from '#/rpc/events';
import type { SessionMeta } from '#/session';

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
