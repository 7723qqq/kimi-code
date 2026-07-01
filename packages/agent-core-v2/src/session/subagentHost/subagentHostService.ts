import {
  APIProviderRateLimitError,
  isProviderRateLimitError,
  type TokenUsage,
} from '@moonshot-ai/kosong';

import { Disposable } from '#/_base/di';
import { InstantiationType } from '#/_base/di/extensions';
import {
  LifecycleScope,
  registerScopedService,
  type IScopeHandle,
} from '#/_base/di/scope';
import { linkAbortSignal, userCancellationReason } from '#/_base/utils/abort';
import { IKaos } from '#/app/kaos';
import { ILogService } from '#/app/log';
import { ITelemetryService } from '#/app/telemetry';
import { IAgentBackgroundService } from '#/agent/background';
import {
  IAgentContextMemoryService,
  type ContextMessage,
  type PromptOrigin,
} from '#/agent/contextMemory';
import { IAgentEventSinkService } from '#/agent/eventSink';
import { IAgentExternalHooksService } from '#/agent/externalHooks';
import { isAbortError } from '#/agent/loop/errors';
import {
  DenyAllPermissionPolicyService,
  IAgentPermissionPolicyService,
} from '#/agent/permissionPolicy';
import { IAgentProfileService } from '#/agent/profile';
import { IAgentPromptService } from '#/agent/prompt';
import { IAgentSystemReminderService } from '#/agent/systemReminder';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import type { Turn } from '#/agent/turn';
import { IAgentUsageService } from '#/agent/usage';
import { ErrorCodes, toKimiErrorPayload, type KimiErrorPayload } from '#/errors';
import { IAgentLifecycleService } from '#/session/agent-lifecycle';
import { ISessionProcessRunner } from '#/session/process';
import { ISessionMetadata } from '#/session/session-metadata';
import { AgentTool } from './agentTool';
import { DEFAULT_AGENT_SUBAGENT_PROFILES, EXPLORE_ROLE_ADDITIONAL } from './profiles';
import {
  resolveSwarmMaxConcurrency,
  SubagentBatch,
  type QueuedSubagentTask,
  type SubagentResult,
  type SubagentSuspendedEvent,
} from './subagent-batch';
import SUMMARY_CONTINUATION_PROMPT from './summary-continuation.md?raw';
import {
  ISessionSubagentHost,
  type RunSubagentOptions,
  type SpawnSubagentOptions,
  type SubagentHandle,
} from './subagentHost';

const SUBAGENT_PROMPT_ORIGIN: PromptOrigin = { kind: 'system_trigger', name: 'subagent' };
const SUMMARY_MIN_LENGTH = 200;
const SUMMARY_CONTINUATION_ATTEMPTS = 1;
const HOOK_TEXT_PREVIEW_LENGTH = 500;
const TOOL_CALL_DISABLED_MESSAGE =
  'Tool calls are disabled for side questions. Answer with text only.';
const SIDE_QUESTION_SYSTEM_REMINDER = `
This is a side-channel conversation with the user. You should answer user questions directly based on what you already know.

IMPORTANT:
- You are a separate, lightweight instance.
- The main agent continues independently; do not reference being interrupted.
- Do not call any tools. All tool calls are disabled and will be rejected.
  Even though tool definitions are visible in this request, they exist only
  for technical reasons (prompt cache). You must not use them.
- Respond only with text based on what you already know from the conversation
  and this side-channel conversation.
- Follow-up turns may happen in this side-channel conversation.
- If you do not know the answer, say so directly.
`;

export class SessionSubagentHostService extends Disposable implements ISessionSubagentHost {
  declare readonly _serviceBrand: undefined;

  private readonly activeChildren = new Map<
    string,
    { readonly controller: AbortController; runInBackground: boolean }
  >();
  private readonly swarmItems = new Map<string, string>();
  private readonly ownerAgentId = 'main';

  constructor(
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
    @ISessionMetadata private readonly metadata: ISessionMetadata | undefined,
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
    @IAgentBackgroundService background: IAgentBackgroundService,
    @IAgentProfileService profile: IAgentProfileService,
    @IKaos kaos: IKaos,
    @ISessionProcessRunner runner: ISessionProcessRunner,
    @ILogService log?: ILogService,
  ) {
    super();
    this._register(
      toolRegistry.register(
        new AgentTool(this, background, DEFAULT_AGENT_SUBAGENT_PROFILES, {
          log,
          gitContext: { cwd: kaos.cwd, runner },
          canRunInBackground: () => {
            return profile.isToolActive('TaskList') &&
              profile.isToolActive('TaskOutput') &&
              profile.isToolActive('TaskStop');
          },
        }),
      ),
    );
  }

  getSwarmItem(agentId: string): string | undefined {
    return this.swarmItems.get(agentId);
  }

  async startBtw(): Promise<string> {
    const parent = await this.ensureParent();
    const child = await this.agents.create({ parentAgentId: this.ownerAgentId, type: 'sub' });

    const parentProfile = parent.accessor.get(IAgentProfileService);
    const childProfile = child.accessor.get(IAgentProfileService);
    const parentData = parentProfile.data();
    // A side-question agent inherits the parent's model, thinking level, and
    // system prompt so it answers from the same posture.
    childProfile.update({
      modelAlias: parentData.modelAlias,
      thinkingLevel: parentData.thinkingLevel,
      systemPrompt: parentData.systemPrompt,
      // Keep the parent's loop tools visible (prompt-cache parity) even though
      // every call is denied below.
      activeToolNames: parentData.activeToolNames,
    });

    // Project the parent's history into the child so it can answer from what
    // the main agent already knows.
    const parentMessages = parent.accessor.get(IAgentContextMemoryService)?.get();
    if (parentMessages !== undefined && parentMessages.length > 0) {
      child.accessor.get(IAgentContextMemoryService)?.splice(0, 0, parentMessages);
    }

    child.accessor
      .get(IAgentSystemReminderService)
      ?.appendSystemReminder(SIDE_QUESTION_SYSTEM_REMINDER.trim(), {
        kind: 'system_trigger',
        name: 'btw',
      });

    // Disable every tool call: side questions are answered with text only.
    child.accessor
      .get(IAgentPermissionPolicyService)
      ?.registerPolicy(new DenyAllPermissionPolicyService(TOOL_CALL_DISABLED_MESSAGE));

    return child.id;
  }

  async generateAgentsMd(): Promise<void> {
    const handle = await this.spawn({
      profileName: 'coder',
      parentToolCallId: 'generate-agents-md',
      prompt: 'Initialize AGENTS.md for this workspace.',
      description: 'Initialize AGENTS.md',
      runInBackground: false,
      signal: new AbortController().signal,
    });
    await handle.completion;
  }

  async spawn(options: SpawnSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();
    const parent = await this.ensureParent();
    const child = await this.agents.create({
      parentAgentId: this.ownerAgentId,
      cwd: parent.accessor.get(IAgentProfileService).data().cwd,
      type: 'sub',
      swarmItem: options.swarmItem,
    });
    if (options.swarmItem !== undefined) this.swarmItems.set(child.id, options.swarmItem);
    this.configureChild(parent, child, options.profileName);
    this.emitSpawned(parent, child.id, options.profileName, options);
    const completion = this.runWithActiveChild(
      child,
      options,
      parent,
      options.profileName,
      (turnRef, controller) => this.runPromptTurn(child, parent, options, options.profileName, turnRef, controller),
    );
    return { agentId: child.id, profileName: options.profileName, resumed: false, completion };
  }

  async resume(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();
    const parent = await this.ensureParent();
    const child = await this.requireChild(agentId);
    const profileName = child.accessor.get(IAgentProfileService).data().profileName ?? 'subagent';
    this.emitSpawned(parent, child.id, profileName, options);
    const completion = this.runWithActiveChild(
      child,
      options,
      parent,
      profileName,
      (turnRef, controller) => this.runPromptTurn(child, parent, options, profileName, turnRef, controller),
    );
    return { agentId, profileName, resumed: true, completion };
  }

  async retry(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();
    const parent = await this.ensureParent();
    const child = await this.requireChild(agentId);
    const profileName = child.accessor.get(IAgentProfileService).data().profileName ?? 'subagent';
    this.emitSpawned(parent, child.id, profileName, options);
    const completion = this.runWithActiveChild(
      child,
      options,
      parent,
      profileName,
      (turnRef, controller) => this.runRetryTurn(child, parent, options, profileName, turnRef, controller),
    );
    return { agentId, profileName, resumed: true, completion };
  }

  async getProfileName(agentId: string): Promise<string | undefined> {
    if (this.metadata !== undefined) {
      const meta = (await this.metadata.read()).agents?.[agentId];
      if (meta?.type !== 'sub' || meta.parentAgentId !== this.ownerAgentId) return undefined;
    }
    const child = this.agents.getHandle(agentId);
    if (child === undefined) return undefined;
    return child.accessor.get(IAgentProfileService).data().profileName;
  }

  markActiveChildDetached(agentId: string): void {
    const child = this.activeChildren.get(agentId);
    if (child !== undefined) child.runInBackground = true;
  }

  async runQueued<T>(tasks: readonly QueuedSubagentTask<T>[]): Promise<Array<SubagentResult<T>>> {
    const maxConcurrency = resolveSwarmMaxConcurrency();
    return new SubagentBatch(this, tasks, { maxConcurrency }).run();
  }

  cancelAll(reason: unknown = userCancellationReason()): void {
    // v2 tracks every subagent (including descendants spawned by subagents) in
    // the single session-scoped host, so aborting the foreground children here
    // cancels the whole tree — there is no per-agent host to recurse into.
    for (const [, child] of this.activeChildren) {
      if (child.runInBackground) continue;
      child.controller.abort(reason);
    }
  }

  suspended(event: SubagentSuspendedEvent): void {
    const parent = this.agents.getHandle(this.ownerAgentId);
    parent?.accessor.get(IAgentEventSinkService)?.emit({
      type: 'subagent.suspended',
      subagentId: event.agentId,
      reason: event.reason,
    });
  }

  private async ensureParent(): Promise<IScopeHandle> {
    const existing = this.agents.getHandle(this.ownerAgentId);
    if (existing !== undefined) return existing;
    if (this.ownerAgentId === 'main') return this.agents.createMain();
    throw new Error(`Parent agent "${this.ownerAgentId}" does not exist`);
  }

  private async requireChild(agentId: string): Promise<IScopeHandle> {
    if (this.metadata !== undefined) {
      const meta = (await this.metadata.read()).agents?.[agentId];
      if (meta === undefined) throw new Error(`Agent instance "${agentId}" does not exist`);
      if (meta.type !== 'sub') throw new Error(`Agent instance "${agentId}" is not a subagent`);
      if (meta.parentAgentId !== this.ownerAgentId) {
        throw new Error(`Agent instance "${agentId}" does not belong to this parent agent`);
      }
    }
    const child = this.agents.getHandle(agentId);
    if (child === undefined) throw new Error(`Agent instance "${agentId}" does not exist`);
    if (this.activeChildren.has(agentId)) {
      throw new Error(`Agent instance "${agentId}" is already running`);
    }
    return child;
  }

  private configureChild(parent: IScopeHandle, child: IScopeHandle, profileName: string): void {
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
      // `explore` extends the parent (agent) prompt with its read-only
      // exploration role, mirroring v1's `explore.yaml` (`extends: agent` +
      // `roleAdditional`). Full profile resolution via `applyProfile` (AGENTS.md
      // context assembly) and v1's `inheritUserTools` are not yet wired in v2,
      // so the standard explore tool set is used directly.
      systemPrompt:
        profileName === 'explore'
          ? `${parentData.systemPrompt}\n\n${EXPLORE_ROLE_ADDITIONAL}`
          : parentData.systemPrompt,
      activeToolNames,
    });
  }

  private emitSpawned(
    parent: IScopeHandle,
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
      parentAgentId: this.ownerAgentId,
      description: options.description,
      swarmIndex: options.swarmIndex,
      runInBackground: options.runInBackground,
    });
    parent.accessor.get(ITelemetryService)?.track('subagent_created', {
      subagent_name: profileName,
      run_in_background: options.runInBackground,
    });
  }

  private emitStarted(parent: IScopeHandle, subagentId: string): void {
    parent.accessor.get(IAgentEventSinkService)?.emit({ type: 'subagent.started', subagentId });
  }

  private emitCompleted(
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

  private emitFailed(
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

  private async triggerSubagentStart(
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

  private triggerSubagentStop(parent: IScopeHandle, profileName: string, result: string): void {
    parent.accessor.get(IAgentExternalHooksService)?.triggerSubagentStop({
      agentName: profileName,
      response: result.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
    });
  }

  private observeFirstRequest(turn: Turn, options: RunSubagentOptions): void {
    if (options.onReady === undefined) return;
    void turn.ready.then(() => options.onReady?.()).catch(() => {});
  }

  private async runWithActiveChild(
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
    this.activeChildren.set(child.id, { controller, runInBackground: options.runInBackground });
    const unlink = linkAbortSignal(options.signal, controller);
    const turnRef: { current?: Turn } = {};
    this.emitStarted(parent, child.id);
    try {
      const result = await run(turnRef, controller);
      this.emitCompleted(parent, child.id, result.result, result.usage);
      this.triggerSubagentStop(parent, profileName, result.result);
      return result;
    } catch (error) {
      this.emitFailed(parent, child.id, error, options);
      throw error;
    } finally {
      unlink();
      if (controller.signal.aborted) {
        turnRef.current?.abortController.abort(controller.signal.reason);
      }
      this.activeChildren.delete(child.id);
    }
  }

  private async runPromptTurn(
    child: IScopeHandle,
    parent: IScopeHandle,
    options: RunSubagentOptions,
    profileName: string,
    turnRef: { current?: Turn },
    controller: AbortController,
  ): Promise<{ result: string; usage?: TokenUsage }> {
    options.signal.throwIfAborted();
    await this.triggerSubagentStart(parent, profileName, options.prompt, options.signal);
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
    this.observeFirstRequest(turn, options);
    const result = await this.awaitTurn(turn, controller);
    classifyTurnResult(result);
    const summary = await this.completeSummary(child, controller, turnRef);
    const usage = child.accessor.get(IAgentUsageService)?.status().total;
    return { result: summary, usage };
  }

  private async runRetryTurn(
    child: IScopeHandle,
    parent: IScopeHandle,
    options: RunSubagentOptions,
    profileName: string,
    turnRef: { current?: Turn },
    controller: AbortController,
  ): Promise<{ result: string; usage?: TokenUsage }> {
    options.signal.throwIfAborted();
    await this.triggerSubagentStart(parent, profileName, options.prompt, options.signal);
    options.signal.throwIfAborted();

    // Retry the existing turn in place (no new user message appended), mirroring
    // v1's `child.turn.retry('agent-host')`.
    const turn = child.accessor.get(IAgentPromptService).retry('agent-host');
    if (turn === undefined) {
      throw new Error(`Agent instance "${child.id}" could not start a retry turn`);
    }
    turnRef.current = turn;
    this.observeFirstRequest(turn, options);
    const result = await this.awaitTurn(turn, controller);
    classifyTurnResult(result);
    const summary = await this.completeSummary(child, controller, turnRef);
    const usage = child.accessor.get(IAgentUsageService)?.status().total;
    return { result: summary, usage };
  }

  private async awaitTurn(
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

  private async completeSummary(
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
      const result = await this.awaitTurn(turn, controller);
      if (result.reason !== 'completed') break;
      const continued = latestAssistantText(child.accessor.get(IAgentContextMemoryService).get());
      if (continued.trim().length > 0) summary = continued;
      if (summary.trim().length >= SUMMARY_MIN_LENGTH) break;
    }
    return summary;
  }
}

/**
 * Map a finished subagent turn to the v1 error taxonomy:
 *  - `filtered`            → provider safety policy block
 *  - provider rate limit   → `APIProviderRateLimitError` (so the swarm batch
 *                            requeues the attempt via `isProviderRateLimitError`)
 *  - `cancelled`           → user cancellation reason
 *
 * `max_tokens` is intentionally not classified here: v2's turn result collapses
 * every non-aborted/non-filtered stop into `completed`, so the subagent host
 * cannot observe a max_tokens stop. See the migration notes for this deliberate
 * drop.
 */
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

registerScopedService(
  LifecycleScope.Session,
  ISessionSubagentHost,
  SessionSubagentHostService,
  InstantiationType.Delayed,
  'subagentHost',
);
