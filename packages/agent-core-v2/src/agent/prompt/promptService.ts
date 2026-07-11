/**
 * `prompt` domain (L4) — `IAgentPromptService` implementation.
 *
 * Ingests user input and turns it into `StepRequest`s on the `loop` queue
 * instead of holding any queue of its own: `prompt` seeds a fresh turn with a
 * `PromptStepRequest`, `steer` enqueues a mergeable `SteerStepRequest` into
 * the active turn (or delegates to `prompt` when no turn is active), and
 * `retry` seeds a message-less `RetryStepRequest`. Image-compression captions
 * are rerouted into hidden `systemReminder` injections when the request
 * materializes. `undo` / `clear` mutate `contextMemory` directly without any
 * request, and input arriving while a full compaction holds an idle agent is
 * deferred and replayed through `fullCompaction`'s finish hook. Consumes
 * tool-declared `delivery: steer` results from `toolExecutor`. Bound at Agent
 * scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { extractImageCompressionCaptions } from '#/_base/tools/support/image-compress';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { formatUndoUnavailableMessage, precheckUndo } from '#/agent/contextMemory/contextOps';
import { USER_PROMPT_ORIGIN, type ContextMessage } from '#/agent/contextMemory/types';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import type { ExecutableToolResult } from '#/agent/tool/toolContract';
import type { ToolDidExecuteContext } from '#/agent/tool/toolHooks';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentTurnService, type Turn } from '#/agent/turn/turn';
import type { ContentPart } from '#/app/llmProtocol/message';
import { ErrorCodes, KimiError } from '#/errors';
import { OrderedHookSlot } from '#/hooks';

import { IAgentPromptService, type PromptSubmitContext, type PromptSteerHandle } from './prompt';
import { PromptStepRequest, RetryStepRequest, SteerStepRequest } from './promptStepRequests';

export class AgentPromptService implements IAgentPromptService {
  declare readonly _serviceBrand: undefined;
  private readonly compactionDeferred: ContextMessage[] = [];
  private readonly pendingSteers = new Set<SteerStepRequest>();
  private fullCompactionService: IAgentFullCompactionService | undefined;

  readonly hooks = {
    onWillSubmitPrompt: new OrderedHookSlot<PromptSubmitContext>(),
  };

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentTurnService private readonly turnService: IAgentTurnService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
  ) {
    toolExecutor.hooks.onDidExecuteTool.register('prompt-service-delivery', async (ctx, next) => {
      await this.deliverToolResult(ctx);
      await next();
    });
  }

  async prompt(message: ContextMessage): Promise<Turn | undefined> {
    if (this.deferWhileCompacting(message)) return undefined;
    const { message: rerouted, captions } = this.extractCompressionCaptions(message);
    if (await this.blockedByHook(rerouted, false)) {
      this.appendPrompt(rerouted, captions);
      return undefined;
    }
    const request = new PromptStepRequest(rerouted, captions, this.reminders);
    this.loop.enqueue(request);
    try {
      return this.turnService.launch({ input: rerouted.content, origin: rerouted.origin });
    } catch (error) {
      request.abort();
      throw error;
    }
  }

  steer(message: ContextMessage): PromptSteerHandle {
    const activeTurn = this.turnService.getActiveTurn();
    if (activeTurn === undefined) {
      return {
        removeFromQueue: () => {
          throw steerAlreadyEmittedError();
        },
        launched: this.prompt(message),
      };
    }

    const { message: rerouted, captions } = this.extractCompressionCaptions(message);
    const request = new SteerStepRequest(
      rerouted,
      captions,
      this.reminders,
      (materialized) => this.turnService.recordSteer(materialized.content, materialized.origin),
      (settled) => this.pendingSteers.delete(settled),
    );
    return {
      removeFromQueue: () => {
        if (!request.abort()) throw steerAlreadyEmittedError();
      },
      launched: this.enqueueSteer(activeTurn, request, message),
    };
  }

  private async deliverToolResult(ctx: ToolDidExecuteContext): Promise<void> {
    const delivery = ctx.result.delivery;
    if (delivery === undefined) return;

    // Consume the side channel: strip it from the result so it never reaches the
    // loop / persistence, then perform the declared delivery here on the agent
    // (L4) side where `steer` lives (the L3 executor only threads it through).
    const { delivery: _consumed, ...rest } = ctx.result;
    ctx.result = rest as ExecutableToolResult;

    switch (delivery.kind) {
      case 'steer':
        // The tool built a full user `ContextMessage`; the L3 contract carries it
        // as an opaque `ToolDeliveryMessage`, so restore the type at the L4 edge.
        await this.steer(delivery.message as ContextMessage).launched;
        return;
      default: {
        const _exhaustive: never = delivery.kind;
        void _exhaustive;
      }
    }
  }

  retry(): Turn | undefined {
    const retryMessage: ContextMessage = {
      role: 'user',
      content: [],
      toolCalls: [],
      origin: { kind: 'retry' },
    };
    if (this.deferWhileCompacting(retryMessage)) return undefined;
    const request = new RetryStepRequest();
    this.loop.enqueue(request);
    try {
      return this.turnService.launch({ input: [], origin: { kind: 'retry' } });
    } catch (error) {
      request.abort();
      throw error;
    }
  }

  undo(count: number): number {
    if (count <= 0) return 0;

    // Precheck on the live history so a request that cannot be fully satisfied
    // fails with `session.undo_unavailable` (and a structured reason) BEFORE any
    // state is removed. `context.undo` is a no-op when the cut is short, but
    // surfacing *why* (`empty` / `compaction_boundary` / `insufficient`) is the
    // caller's signal — mirrors v1's `canUndoHistory` gate.
    const precheck = precheckUndo(this.context.get(), count);
    if (!precheck.ok) {
      throw new KimiError(
        ErrorCodes.SESSION_UNDO_UNAVAILABLE,
        formatUndoUnavailableMessage(precheck),
        {
          details: {
            reason: precheck.reason,
            requestedCount: count,
            undoableCount: precheck.undoable,
          },
        },
      );
    }
    return this.context.undo(count).removedCount;
  }

  clear(): void {
    // abort() settles each request, which unregisters it from this set;
    // Set iteration tolerates removing the element currently being visited.
    for (const request of this.pendingSteers) {
      request.abort();
    }
    this.context.clear();
  }

  private append(...messages: ContextMessage[]): void {
    this.context.append(...messages);
  }

  private async blockedByHook(promptMessage: ContextMessage, isSteer: boolean): Promise<boolean> {
    const hookContext: PromptSubmitContext = {
      promptMessage,
      isSteer,
      block: false,
    };
    await this.hooks.onWillSubmitPrompt.run(hookContext);
    return hookContext.block;
  }

  /**
   * While a full compaction holds the context and no turn is active, defer the
   * input instead of launching: a turn started now would append assistant/tool
   * output and force the in-flight compaction to cancel. The buffer replays
   * from the compaction's `onDidFinishCompaction` hook — on completion,
   * cancellation, and failure — so deferred input is never lost.
   */
  private deferWhileCompacting(message: ContextMessage): boolean {
    if (this.fullCompaction.compacting === null) return false;
    if (this.turnService.getActiveTurn() !== undefined) return false;
    this.compactionDeferred.push(message);
    return true;
  }

  /**
   * Resolved lazily (not constructor-injected): prompt is constructed early in
   * agent setup, and pulling the whole compaction subtree (context size, LLM
   * requester, profile, tool registry/select, todo, …) in from this
   * constructor would reorder eager service startup for every agent. The
   * registered `onDidFinishCompaction` hook replays input deferred by
   * `deferWhileCompacting`.
   */
  private get fullCompaction(): IAgentFullCompactionService {
    if (this.fullCompactionService === undefined) {
      this.fullCompactionService = this.instantiation.invokeFunction((accessor) =>
        accessor.get(IAgentFullCompactionService),
      );
      this.fullCompactionService.hooks.onDidFinishCompaction.register(
        'prompt-service-compaction-replay',
        async (_ctx, next) => {
          await this.replayCompactionDeferred();
          await next();
        },
      );
    }
    return this.fullCompactionService;
  }

  private async replayCompactionDeferred(): Promise<void> {
    const deferred = this.compactionDeferred.splice(0);
    for (const message of deferred) {
      await this.steer(message).launched;
    }
  }

  /**
   * Split inline image-compression captions out of a user message so they can
   * be delivered through the built-in system-reminder injection instead.
   *
   * Prompt ingestion (server upload/base64 route, TUI paste, ACP) annotates a
   * compressed image with an inline `<system>` caption next to the image. Left
   * inside the user message, that raw markup is user-visible in every history
   * projection (TUI replay, vis, export). The reminder's `injection` origin is
   * hidden by every UI, while the model still receives the full note.
   */
  private extractCompressionCaptions(message: ContextMessage): {
    message: ContextMessage;
    captions: readonly string[];
  } {
    if ((message.origin ?? USER_PROMPT_ORIGIN).kind !== 'user') {
      return { message, captions: [] };
    }
    const { captions, parts } = splitImageCompressionCaptions(message.content);
    if (captions.length === 0) {
      return { message, captions };
    }
    return { message: { ...message, content: parts }, captions };
  }

  /**
   * Append a prompt message preceded by its rerouted caption reminders. A
   * message whose content was caption-only is dropped entirely rather than
   * appended empty. Used for input that never enters the step queue (blocked
   * by a submit hook); queued input goes through `StepRequest`
   * materialization, which applies the same ordering.
   */
  private appendPrompt(message: ContextMessage, captions: readonly string[]): void {
    for (const caption of captions) {
      this.reminders.appendSystemReminder(caption, {
        kind: 'injection',
        variant: 'image_compression',
      });
    }
    if (message.content.length > 0) this.append(message);
  }

  private async enqueueSteer(
    activeTurn: Turn,
    request: SteerStepRequest,
    originalMessage: ContextMessage,
  ): Promise<Turn | undefined> {
    if (await this.blockedByHook(originalMessage, true)) return undefined;
    if (request.aborted) return undefined;

    this.pendingSteers.add(request);
    this.loop.enqueue(request);
    return activeTurn;
  }
}

function steerAlreadyEmittedError(): KimiError {
  return new KimiError(
    ErrorCodes.REQUEST_INVALID,
    'Cannot remove a steer after it has been emitted',
    { details: { reason: 'steer_already_emitted' } },
  );
}

// Split inline image-compression captions (see buildImageCompressionCaption)
// out of user prompt content. A caption may be a standalone text part (server
// route, ACP) or merged into an adjacent text segment (TUI paste), so each
// text part is scanned rather than matched whole. Text left empty once its
// captions are removed is dropped entirely.
function splitImageCompressionCaptions(content: readonly ContentPart[]): {
  captions: string[];
  parts: ContentPart[];
} {
  const captions: string[] = [];
  const parts: ContentPart[] = [];
  for (const part of content) {
    if (part.type !== 'text') {
      parts.push(part);
      continue;
    }
    const extracted = extractImageCompressionCaptions(part.text);
    if (extracted.captions.length === 0) {
      parts.push(part);
      continue;
    }
    captions.push(...extracted.captions);
    if (extracted.text.trim().length > 0) {
      parts.push({ type: 'text', text: extracted.text });
    }
  }
  return { captions, parts };
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPromptService,
  AgentPromptService,
  InstantiationType.Delayed,
  'prompt',
);
