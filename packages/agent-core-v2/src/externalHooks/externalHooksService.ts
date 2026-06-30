import { toKimiErrorPayload } from "#/errors";
import { IConfigRegistry } from '#/config';
import {
  IAgentExternalHooksService,
  type ExternalHooksServiceOptions,
  type NotificationHookPayload,
  type PermissionRequestHookPayload,
  type PermissionResultHookPayload,
  type UserPromptHookDecision,
} from './externalHooks';
import { HOOKS_SECTION, HooksConfigSchema, hooksFromToml, hooksToToml } from './configSection';
import {
  renderUserPromptHookBlockResult,
  renderUserPromptHookResult,
} from './user-prompt';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { isPlainRecord } from '#/_base/utils/canonical-args';
import { IAgentToolExecutorService } from '#/toolExecutor';

function fireAndForget(
  engine: ExternalHooksServiceOptions['hookEngine'],
  event: string,
  inputData: Record<string, unknown>,
  signal: AbortSignal,
  matcherValue?: string,
): void {
  // Genuinely fire-and-forget: never throw on an already-aborted signal. A
  // cancelled tool still finalizes its result (e.g. the "manually interrupted"
  // output), and throwing here would clobber that with a finalize-abort error.
  // Matches legacy `fireAndForgetTrigger`, which fires unconditionally.
  void engine?.fireAndForgetTrigger(event, { matcherValue, signal, inputData });
}

export class AgentExternalHooksService implements IAgentExternalHooksService {
  declare readonly _serviceBrand: undefined;

  constructor(
    private readonly options: ExternalHooksServiceOptions = {},
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IConfigRegistry configRegistry: IConfigRegistry,
  ) {
    configRegistry.registerSection(HOOKS_SECTION, HooksConfigSchema, {
      fromToml: hooksFromToml,
      toToml: hooksToToml,
    });
    toolExecutor.hooks.onWillExecuteTool.register('externalHooks', async (ctx, next) => {
      const reason = await this.triggerPreToolUse(
        {
          toolCallId: ctx.toolCall.id,
          toolName: ctx.toolCall.name,
          toolInput: isPlainRecord(ctx.args) ? ctx.args : {},
        },
        ctx.signal,
      );
      if (reason !== undefined) {
        ctx.decision = { block: true, reason };
        return;
      }
      await next();
    });
    toolExecutor.hooks.onDidExecuteTool.register('externalHooks', async (ctx, next) => {
      await this.triggerPostToolUse(
        {
          toolCallId: ctx.toolCall.id,
          toolName: ctx.toolCall.name,
          toolInput: isPlainRecord(ctx.args) ? ctx.args : {},
          result: ctx.result,
        },
        ctx.signal,
      );
      await next();
    });
  }

  async triggerPreToolUse(
    payload: Parameters<IAgentExternalHooksService['triggerPreToolUse']>[0],
    signal: AbortSignal,
  ): Promise<string | undefined> {
    signal.throwIfAborted();
    const block = await this.options.hookEngine?.triggerBlock('PreToolUse', {
      matcherValue: payload.toolName,
      signal,
      inputData: {
        toolName: payload.toolName,
        toolInput: payload.toolInput,
        toolCallId: payload.toolCallId,
      },
    });
    signal.throwIfAborted();
    return block?.reason;
  }

  async triggerUserPromptSubmit(
    input: Parameters<IAgentExternalHooksService['triggerUserPromptSubmit']>[0],
    signal: AbortSignal,
  ): Promise<UserPromptHookDecision | undefined> {
    signal.throwIfAborted();
    const results = await this.options.hookEngine?.trigger('UserPromptSubmit', {
      matcherValue: input,
      signal,
      inputData: { prompt: input },
    });
    signal.throwIfAborted();

    const block = renderUserPromptHookBlockResult(results);
    if (block !== undefined) return { action: 'block', ...block };

    const append = renderUserPromptHookResult(results);
    return append === undefined ? undefined : { action: 'append', ...append };
  }

  async triggerStop(signal: AbortSignal, stopHookActive: boolean): Promise<string | undefined> {
    signal.throwIfAborted();
    const block = await this.options.hookEngine?.triggerBlock('Stop', {
      signal,
      inputData: { stopHookActive },
    });
    signal.throwIfAborted();
    return block?.reason;
  }

  async triggerPostToolUse(
    payload: Parameters<IAgentExternalHooksService['triggerPostToolUse']>[0],
    signal: AbortSignal,
  ): Promise<void> {
    const output = toolOutputText(payload.result.output);
    const isError = payload.result.isError === true;
    fireAndForget(
      this.options.hookEngine,
      isError ? 'PostToolUseFailure' : 'PostToolUse',
      {
        toolName: payload.toolName,
        toolInput: payload.toolInput,
        toolCallId: payload.toolCallId,
        error: isError ? toKimiErrorPayload(output) : undefined,
        toolOutput: isError ? undefined : output.slice(0, 2000),
      },
      signal,
      payload.toolName,
    );
  }

  triggerPermissionRequest(payload: PermissionRequestHookPayload): void {
    void this.options.hookEngine?.fireAndForgetTrigger('PermissionRequest', {
      matcherValue: payload.toolName,
      inputData: {
        turnId: payload.turnId,
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        action: payload.action,
        toolInput: payload.toolInput,
        display: payload.display,
      },
    });
  }

  triggerPermissionResult(payload: PermissionResultHookPayload): void {
    void this.options.hookEngine?.fireAndForgetTrigger('PermissionResult', {
      matcherValue: payload.toolName,
      inputData: permissionResultInputData(payload),
    });
  }

  triggerStopFailure(error: unknown, signal: AbortSignal): void {
    const payload = toKimiErrorPayload(error);
    fireAndForget(
      this.options.hookEngine,
      'StopFailure',
      {
        errorType: payload.name,
        errorMessage: payload.message,
      },
      signal,
      payload.name,
    );
  }

  triggerInterrupt(payload: Parameters<IAgentExternalHooksService['triggerInterrupt']>[0]): void {
    void this.options.hookEngine?.fireAndForgetTrigger('Interrupt', {
      inputData: payload,
    });
  }

  async triggerPreCompact(
    payload: Parameters<IAgentExternalHooksService['triggerPreCompact']>[0],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.options.hookEngine?.trigger('PreCompact', {
      matcherValue: payload.trigger,
      signal,
      inputData: {
        trigger: payload.trigger,
        tokenCount: payload.tokenCount,
      },
    });
    signal.throwIfAborted();
  }

  triggerPostCompact(payload: Parameters<IAgentExternalHooksService['triggerPostCompact']>[0]): void {
    void this.options.hookEngine?.fireAndForgetTrigger('PostCompact', {
      matcherValue: payload.trigger,
      inputData: {
        trigger: payload.trigger,
        estimatedTokenCount: payload.estimatedTokenCount,
      },
    });
  }

  triggerNotification(payload: NotificationHookPayload): void {
    const signal = new AbortController().signal;
    fireAndForget(
      this.options.hookEngine,
      'Notification',
      { sink: 'context', ...payload },
      signal,
      payload.notificationType,
    );
  }
}

function toolOutputText(
  output: Parameters<IAgentExternalHooksService['triggerPostToolUse']>[0]['result']['output'],
): string {
  if (typeof output === 'string') return output;
  return output
    .filter((part): part is Extract<(typeof output)[number], { type: 'text' }> => {
      return typeof part === 'object' && part !== null && part.type === 'text';
    })
    .map((part) => part.text)
    .join('');
}

function permissionResultInputData(payload: PermissionResultHookPayload): Record<string, unknown> {
  if (payload.decision === 'error') {
    return {
      turnId: payload.turnId,
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      action: payload.action,
      decision: payload.decision,
      error: payload.error,
    };
  }
  return {
    turnId: payload.turnId,
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    action: payload.action,
    decision: payload.decision,
    scope: payload.scope,
    feedback: payload.feedback,
    selectedLabel: payload.selectedLabel,
  };
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentExternalHooksService,
  AgentExternalHooksService,
  InstantiationType.Delayed,
  'externalHooks',
);
