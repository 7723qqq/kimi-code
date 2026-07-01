/**
 * `agentTool` domain (L5) — runs a child agent (an ordinary Agent scope) to completion.
 *
 * Stateless helper module (plain functions, not a class, not a DI service).
 * Each function takes the parent `agent-lifecycle`, `parentAgentId`, and optional
 * `session-metadata` explicitly, creates or resumes a child agent, mirrors the
 * way the main agent runs a turn (`prompt` → await the turn result → collect the
 * summary + usage), and emits `subagent.*` facts on the parent's event sink.
 * Active-child tracking lives in a module-level map keyed by parent agent id so
 * `cancelAllChildren` / `markChildDetached` can reach every run. Owns no scoped
 * state itself — all durable state lives in the child agent scope. Bound to no
 * scope; borrows `event`, `externalHooks`, `telemetry`, `profile`, `prompt`,
 * `contextMemory`, `usage`, and `agentTool` through the parent/child accessors.
 */

import {
  APIProviderRateLimitError,
  isProviderRateLimitError,
  type TokenUsage,
} from '@moonshot-ai/kosong';

import { linkAbortSignal, userCancellationReason } from '#/_base/utils/abort';
import { IAgentLifecycleService } from '#/session/agent-lifecycle';
import type { IScopeHandle } from '#/_base/di/scope';
import {
  IAgentContextMemoryService,
  type ContextMessage,
  type PromptOrigin,
} from '#/agent/contextMemory';
import { ErrorCodes, toKimiErrorPayload, type KimiErrorPayload } from '#/errors';
import { IAgentEventSinkService } from '#/agent/eventSink';
import { IAgentExternalHooksService } from '#/agent/externalHooks';
import { isAbortError } from '#/agent/loop/errors';
import { IAgentProfileService } from '#/agent/profile';
import { ISessionMetadata } from '#/session/session-metadata';
import { ITelemetryService } from '#/app/telemetry';
import { IAgentPromptService } from '#/agent/prompt';
import { IAgentUsageService } from '#/agent/usage';
import type { Turn } from '#/agent/turn';

import { IAgentToolService } from './agentToolServiceToken';
import { DEFAULT_AGENT_SUBAGENT_PROFILES, EXPLORE_ROLE_ADDITIONAL } from './profiles';
import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  DEFAULT_SUBAGENT_TIMEOUT_DESCRIPTION,
  type RunSubagentOptions,
  type SpawnSubagentOptions,
  type SubagentHandle,
} from './types';
import SUMMARY_CONTINUATION_PROMPT from './summary-continuation.md?raw';

const SUBAGENT_PROMPT_ORIGIN: PromptOrigin = { kind: 'system_trigger', name: 'subagent' };
const SUMMARY_MIN_LENGTH = 200;
const SUMMARY_CONTINUATION_ATTEMPTS = 1;
const HOOK_TEXT_PREVIEW_LENGTH = 500;

export type RunContext = {
  readonly lifecycle: IAgentLifecycleService;
  readonly parentAgentId: string;
  readonly metadata?: ISessionMetadata;
};

export type SpawnChildAgentArgs = RunContext & SpawnSubagentOptions;
export type ResumeChildAgentArgs = RunContext & { readonly agentId: string } & RunSubagentOptions;
export type RetryChildAgentArgs = RunContext & { readonly agentId: string } & RunSubagentOptions;
export type GetChildProfileNameArgs = RunContext & { readonly agentId: string };
export type MarkChildDetachedArgs = { readonly parentAgentId: string; readonly agentId: string };

export type AgentToolRunOverride = {
  spawn(args: SpawnChildAgentArgs): Promise<SubagentHandle>;
  resume(args: ResumeChildAgentArgs): Promise<SubagentHandle>;
  retry(args: RetryChildAgentArgs): Promise<SubagentHandle>;
  getProfileName(args: GetChildProfileNameArgs): Promise<string | undefined>;
  markDetached(args: MarkChildDetachedArgs): void;
};

type ActiveChild = {
  readonly controller: AbortController;
  runInBackground: boolean;
};

const activeChildrenByParent = new Map<string, Map<string, ActiveChild>>();

function childrenOf(parentAgentId: string): Map<string, ActiveChild> {
  let children = activeChildrenByParent.get(parentAgentId);
  if (children === undefined) {
    children = new Map();
    activeChildrenByParent.set(parentAgentId, children);
  }
  return children;
}

export async function spawnChildAgent(args: SpawnChildAgentArgs): Promise<SubagentHandle> {
  const { lifecycle, parentAgentId, metadata: _metadata, ...options } = args;
  options.signal.throwIfAborted();
  const parent = await ensureParent(lifecycle, parentAgentId);
  const child = await lifecycle.create({
    parentAgentId,
    cwd: parent.accessor.get(IAgentProfileService).data().cwd,
    type: 'sub',
    swarmItem: options.swarmItem,
  });
  configureChild(parent, child, options.profileName);
  ensureAgentTool(child);
  emitSpawned(parent, parentAgentId, child.id, options.profileName, options);
  const completion = runWithActiveChild(
    parentAgentId,
    child,
    options,
    parent,
    options.profileName,
    (turnRef, controller) => runPromptTurn(child, parent, options, options.profileName, turnRef, controller),
  );
  return { agentId: child.id, profileName: options.profileName, resumed: false, completion };
}

export async function resumeChildAgent(args: ResumeChildAgentArgs): Promise<SubagentHandle> {
  const { lifecycle, parentAgentId, metadata, agentId, ...options } = args;
  options.signal.throwIfAborted();
  const parent = await ensureParent(lifecycle, parentAgentId);
  const child = await requireChild(lifecycle, parentAgentId, metadata, agentId);
  const profileName = child.accessor.get(IAgentProfileService).data().profileName ?? 'subagent';
  emitSpawned(parent, parentAgentId, child.id, profileName, options);
  const completion = runWithActiveChild(
    parentAgentId,
    child,
    options,
    parent,
    profileName,
    (turnRef, controller) => runPromptTurn(child, parent, options, profileName, turnRef, controller),
  );
  return { agentId, profileName, resumed: true, completion };
}

export async function retryChildAgent(args: RetryChildAgentArgs): Promise<SubagentHandle> {
  const { lifecycle, parentAgentId, metadata, agentId, ...options } = args;
  options.signal.throwIfAborted();
  const parent = await ensureParent(lifecycle, parentAgentId);
  const child = await requireChild(lifecycle, parentAgentId, metadata, agentId);
  const profileName = child.accessor.get(IAgentProfileService).data().profileName ?? 'subagent';
  emitSpawned(parent, parentAgentId, child.id, profileName, options);
  const completion = runWithActiveChild(
    parentAgentId,
    child,
    options,
    parent,
    profileName,
    (turnRef, controller) => runRetryTurn(child, parent, options, profileName, turnRef, controller),
  );
  return { agentId, profileName, resumed: true, completion };
}

export async function getChildProfileName(
  args: GetChildProfileNameArgs,
): Promise<string | undefined> {
  const { lifecycle, parentAgentId, metadata, agentId } = args;
  if (metadata !== undefined) {
    const meta = (await metadata.read()).agents?.[agentId];
    if (meta?.type !== 'sub' || meta.parentAgentId !== parentAgentId) return undefined;
  }
  const child = lifecycle.getHandle(agentId);
  if (child === undefined) return undefined;
  return child.accessor.get(IAgentProfileService).data().profileName;
}

export function markChildDetached({ parentAgentId, agentId }: MarkChildDetachedArgs): void {
  const child = activeChildrenByParent.get(parentAgentId)?.get(agentId);
  if (child !== undefined) child.runInBackground = true;
}

export function cancelAllChildren(
  parentAgentId: string,
  reason: unknown = userCancellationReason(),
): void {
  const children = activeChildrenByParent.get(parentAgentId);
  if (children === undefined) return;
  for (const [, child] of children) {
    if (child.runInBackground) continue;
    child.controller.abort(reason);
  }
}

async function ensureParent(
  lifecycle: IAgentLifecycleService,
  parentAgentId: string,
): Promise<IScopeHandle> {
  const existing = lifecycle.getHandle(parentAgentId);
  if (existing !== undefined) return existing;
  throw new Error(`Parent agent "${parentAgentId}" does not exist`);
}

async function requireChild(
  lifecycle: IAgentLifecycleService,
  parentAgentId: string,
  metadata: ISessionMetadata | undefined,
  agentId: string,
): Promise<IScopeHandle> {
  if (metadata !== undefined) {
    const meta = (await metadata.read()).agents?.[agentId];
    if (meta === undefined) throw new Error(`Agent instance "${agentId}" does not exist`);
    if (meta.type !== 'sub') throw new Error(`Agent instance "${agentId}" is not a subagent`);
    if (meta.parentAgentId !== parentAgentId) {
      throw new Error(`Agent instance "${agentId}" does not belong to this parent agent`);
    }
  }
  const child = lifecycle.getHandle(agentId);
  if (child === undefined) throw new Error(`Agent instance "${agentId}" does not exist`);
  if (activeChildrenByParent.get(parentAgentId)?.has(agentId) === true) {
    throw new Error(`Agent instance "${agentId}" is already running`);
  }
  ensureAgentTool(child);
  return child;
}

function ensureAgentTool(child: IScopeHandle): void {
  // Force-instantiate the child agent's `Agent` tool registrar so its `Agent`
  // tool is registered before the child's first turn builds its tool list.
  child.accessor.get(IAgentToolService);
}

function configureChild(parent: IScopeHandle, child: IScopeHandle, profileName: string): void {
  const parentProfile = parent.accessor.get(IAgentProfileService);
  const childProfile = child.accessor.get(IAgentProfileService);
  const parentData = parentProfile.data();
  const profile = DEFAULT_AGENT_SUBAGENT_PROFILES[profileName];
  const activeToolNames =
    profileName === 'coder'
      ? (parentData.activeToolNames ?? profile?.tools)
      : profile?.tools;
  childProfile.update({
    cwd: parentData.cwd,
    modelAlias: parentData.modelAlias,
    thinkingLevel: parentData.thinkingLevel,
    profileName,
    systemPrompt:
      profileName === 'explore'
        ? `${parentData.systemPrompt}\n\n${EXPLORE_ROLE_ADDITIONAL}`
        : parentData.systemPrompt,
    activeToolNames,
  });
}

function emitSpawned(
  parent: IScopeHandle,
  parentAgentId: string,
  subagentId: string,
  profileName: string,
  options: RunSubagentOptions,
): void {
  parent.accessor.get(IAgentEventSinkService)?.emit({
    type: 'subagent.spawned',
    subagentId,
    subagentName: profileName,
    parentToolCallId: options.parentToolCallId,
    parentToolCallUuid: options.parentToolCallUuid,
    parentAgentId,
    description: options.description,
    swarmIndex: options.swarmIndex,
    runInBackground: options.runInBackground,
  });
  parent.accessor.get(ITelemetryService)?.track('subagent_created', {
    subagent_name: profileName,
    run_in_background: options.runInBackground,
  });
}

function emitStarted(parent: IScopeHandle, subagentId: string): void {
  parent.accessor.get(IAgentEventSinkService)?.emit({ type: 'subagent.started', subagentId });
}

function emitCompleted(
  parent: IScopeHandle,
  subagentId: string,
  resultSummary: string,
  usage?: TokenUsage,
): void {
  parent.accessor.get(IAgentEventSinkService)?.emit({
    type: 'subagent.completed',
    subagentId,
    resultSummary,
    usage,
  });
}

function emitFailed(
  parent: IScopeHandle,
  subagentId: string,
  error: unknown,
  options: RunSubagentOptions,
): void {
  if (isAbortError(error)) return;
  if (shouldSuppressQueuedAttemptFailureEvent(options, error)) return;
  parent.accessor.get(IAgentEventSinkService)?.emit({
    type: 'subagent.failed',
    subagentId,
    error: errorMessage(error),
  });
}


async function triggerSubagentStart(
  parent: IScopeHandle,
  profileName: string,
  prompt: string,
  signal: AbortSignal,
): Promise<void> {
  await parent.accessor.get(IAgentExternalHooksService)?.triggerSubagentStart(
    {
      agentName: profileName,
      prompt: prompt.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
    },
    signal,
  );
}

function triggerSubagentStop(parent: IScopeHandle, profileName: string, result: string): void {
  parent.accessor.get(IAgentExternalHooksService)?.triggerSubagentStop({
    agentName: profileName,
    response: result.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
  });
}

function observeFirstRequest(turn: Turn, options: RunSubagentOptions): void {
  if (options.onReady === undefined) return;
  void turn.ready.then(() => options.onReady?.()).catch(() => {});
}

async function runWithActiveChild(
  parentAgentId: string,
  child: IScopeHandle,
  options: RunSubagentOptions,
  parent: IScopeHandle,
  profileName: string,
  run: (
    turn: { current?: Turn },
    controller: AbortController,
  ) => Promise<{ result: string; usage?: TokenUsage }>,
): Promise<{ result: string; usage?: TokenUsage }> {
  const controller = new AbortController();
  childrenOf(parentAgentId).set(child.id, { controller, runInBackground: options.runInBackground });
  const unlink = linkAbortSignal(options.signal, controller);
  const turnRef: { current?: Turn } = {};
  emitStarted(parent, child.id);
  try {
    const result = await run(turnRef, controller);
    emitCompleted(parent, child.id, result.result, result.usage);
    triggerSubagentStop(parent, profileName, result.result);
    return result;
  } catch (error) {
    emitFailed(parent, child.id, error, options);
    throw error;
  } finally {
    unlink();
    if (controller.signal.aborted) {
      turnRef.current?.abortController.abort(controller.signal.reason);
    }
    childrenOf(parentAgentId).delete(child.id);
  }
}

async function runPromptTurn(
  child: IScopeHandle,
  parent: IScopeHandle,
  options: RunSubagentOptions,
  profileName: string,
  turnRef: { current?: Turn },
  controller: AbortController,
): Promise<{ result: string; usage?: TokenUsage }> {
  options.signal.throwIfAborted();
  await triggerSubagentStart(parent, profileName, options.prompt, options.signal);
  options.signal.throwIfAborted();

  const turn = child.accessor.get(IAgentPromptService).prompt({
    role: 'user',
    content: [{ type: 'text', text: options.prompt }],
    toolCalls: [],
    origin: SUBAGENT_PROMPT_ORIGIN,
  });
  if (turn === undefined) {
    throw new Error('Subagent turn could not be started');
  }
  turnRef.current = turn;
  observeFirstRequest(turn, options);
  const result = await awaitTurn(turn, controller);
  classifyTurnResult(result);
  const summary = await completeSummary(child, controller, turnRef);
  const usage = child.accessor.get(IAgentUsageService)?.status().total;
  return { result: summary, usage };
}

async function runRetryTurn(
  child: IScopeHandle,
  parent: IScopeHandle,
  options: RunSubagentOptions,
  profileName: string,
  turnRef: { current?: Turn },
  controller: AbortController,
): Promise<{ result: string; usage?: TokenUsage }> {
  options.signal.throwIfAborted();
  await triggerSubagentStart(parent, profileName, options.prompt, options.signal);
  options.signal.throwIfAborted();

  const turn = child.accessor.get(IAgentPromptService).retry('agent-host');
  if (turn === undefined) {
    throw new Error(`Agent instance "${child.id}" could not start a retry turn`);
  }
  turnRef.current = turn;
  observeFirstRequest(turn, options);
  const result = await awaitTurn(turn, controller);
  classifyTurnResult(result);
  const summary = await completeSummary(child, controller, turnRef);
  const usage = child.accessor.get(IAgentUsageService)?.status().total;
  return { result: summary, usage };
}

async function awaitTurn(
  turn: Turn,
  controller: AbortController,
): Promise<{ reason: string; error?: unknown }> {
  const onAbort = (): void => {
    turn.abortController.abort(controller.signal.reason);
  };
  controller.signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([turn.result, abortPromise(controller.signal)]);
  } finally {
    controller.signal.removeEventListener('abort', onAbort);
  }
}

async function completeSummary(
  child: IScopeHandle,
  controller: AbortController,
  turnRef: { current?: Turn },
): Promise<string> {
  let summary = latestAssistantText(child.accessor.get(IAgentContextMemoryService).get());
  if (summary.trim().length >= SUMMARY_MIN_LENGTH) return summary;

  for (let attempt = 0; attempt < SUMMARY_CONTINUATION_ATTEMPTS; attempt++) {
    const turn = child.accessor.get(IAgentPromptService).prompt({
      role: 'user',
      content: [{ type: 'text', text: SUMMARY_CONTINUATION_PROMPT }],
      toolCalls: [],
      origin: SUBAGENT_PROMPT_ORIGIN,
    });
    if (turn === undefined) break;
    turnRef.current = turn;
    const result = await awaitTurn(turn, controller);
    if (result.reason !== 'completed') break;
    const continued = latestAssistantText(child.accessor.get(IAgentContextMemoryService).get());
    if (continued.trim().length > 0) summary = continued;
    if (summary.trim().length >= SUMMARY_MIN_LENGTH) break;
  }
  return summary;
}

function classifyTurnResult(result: { reason: string; error?: unknown }): void {
  if (result.reason === 'filtered') {
    throw new Error('Subagent turn blocked by provider safety policy');
  }
  if (result.reason === 'failed') {
    const error = result.error;
    if (isProviderRateLimitError(error)) throw error;
    const payload = toKimiErrorPayload(error);
    if (payload.code === ErrorCodes.PROVIDER_RATE_LIMIT) {
      throw providerRateLimitErrorFromPayload(payload);
    }
    throw error instanceof Error ? error : new Error(String(error ?? 'Subagent turn failed'));
  }
  if (result.reason === 'cancelled') {
    throw userCancellationReason();
  }
}

function shouldSuppressQueuedAttemptFailureEvent(
  options: RunSubagentOptions,
  error: unknown,
): boolean {
  if (options.suppressRateLimitFailureEvent !== true) return false;
  if (isProviderRateLimitError(error)) return true;
  return isAbortError(error) || options.signal.aborted;
}

function providerRateLimitErrorFromPayload(error: KimiErrorPayload): APIProviderRateLimitError {
  const requestId =
    typeof error.details?.['requestId'] === 'string' ? error.details['requestId'] : null;
  return new APIProviderRateLimitError(error.message, requestId);
}

function abortPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? userCancellationReason());
  }
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason ?? userCancellationReason()), {
      once: true,
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function latestAssistantText(messages: readonly ContextMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'assistant') continue;
    return contentText(message.content);
  }
  return '';
}

function contentText(content: ContextMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is Extract<(typeof content)[number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}
