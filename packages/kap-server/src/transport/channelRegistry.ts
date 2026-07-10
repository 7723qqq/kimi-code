/**
 * `/api/v2` channel registry — the set of Services exposed over the wire.
 *
 * Replaces the per-method `actionMap` with VS Code's `registerChannel` model:
 * a Service is registered **once**, keyed by its decorator id (used as the
 * public channel name, e.g. `sessionIndex`), and from then on **all** of its
 * methods are reachable by reflection. There is no per-method allowlist, no
 * public renaming, and no aggregation across Services — the registered Service
 * *is* the public contract, shared as source with the client.
 *
 * The registry is the single exposure boundary (which Services are on the wire
 * at all); scope membership is still enforced downstream by `scope.accessor`.
 */

import {
  IAgentContextMemoryService,
  IAgentContextSizeService,
  IAgentGoalService,
  IAgentMcpService,
  IAgentPermissionModeService,
  IAgentPermissionRulesService,
  IAgentPlanService,
  IAgentProfileService,
  IAgentRPCService,
  IAgentSwarmService,
  IAgentTaskService,
  IAgentToolRegistryService,
  IAgentUsageService,
  IAuthSummaryService,
  IBootstrapService,
  IConfigService,
  IFlagService,
  IHostFolderBrowser,
  IOAuthService,
  IPluginService,
  IProviderService,
  ISessionActivity,
  ISessionApprovalService,
  ISessionFsService,
  ISessionIndex,
  ISessionInitService,
  ISessionInteractionService,
  ISessionLifecycleService,
  ISessionMetadata,
  ISessionQuestionService,
  ISessionWorkspaceCommandService,
  ISessionWorkspaceContext,
  IWorkspaceRegistry,
} from '@moonshot-ai/agent-core-v2';

import type { ServiceIdentifier } from '@moonshot-ai/agent-core-v2';

const channels = new Map<string, ServiceIdentifier<unknown>>();

/** Register one Service as a channel, named by its decorator id (`id.toString()`). */
export function registerChannel<T>(id: ServiceIdentifier<T>): void {
  channels.set(id.toString(), id as ServiceIdentifier<unknown>);
}

/** Resolve a channel name back to its `ServiceIdentifier`, or `undefined`. */
export function resolveChannel(name: string): ServiceIdentifier<unknown> | undefined {
  return channels.get(name);
}

/** Whether a channel name is registered. */
export function hasChannel(name: string): boolean {
  return channels.has(name);
}

/** All registered channel names (decorator ids), sorted — for introspection. */
export function registeredChannelNames(): readonly string[] {
  return Array.from(channels.keys()).toSorted();
}

// The exposed Services. Adding a method to any of these makes it callable over
// the wire with no further wiring; exposing a new Service is one `registerChannel`.
const EXPOSED_SERVICES: readonly ServiceIdentifier<unknown>[] = [
  // core
  ISessionIndex,
  IWorkspaceRegistry,
  IConfigService,
  IProviderService,
  IOAuthService,
  IAuthSummaryService,
  IFlagService,
  IPluginService,
  IHostFolderBrowser,
  IBootstrapService,
  // session
  ISessionMetadata,
  ISessionActivity,
  ISessionLifecycleService,
  ISessionInitService,
  ISessionApprovalService,
  ISessionQuestionService,
  ISessionInteractionService,
  ISessionWorkspaceContext,
  ISessionWorkspaceCommandService,
  ISessionFsService,
  // agent
  IAgentGoalService,
  IAgentPlanService,
  IAgentTaskService,
  IAgentUsageService,
  IAgentContextSizeService,
  IAgentSwarmService,
  IAgentPermissionModeService,
  IAgentPermissionRulesService,
  IAgentProfileService,
  IAgentContextMemoryService,
  IAgentMcpService,
  IAgentToolRegistryService,
  IAgentRPCService,
];

for (const id of EXPOSED_SERVICES) {
  registerChannel(id);
}
