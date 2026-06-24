import { registerSingleton, SyncDescriptor } from '../../../di';
import {
  renderUserPromptHookBlockResult,
  renderUserPromptHookResult,
} from '../../../session/hooks';
import { toKimiErrorPayload } from '../../../errors';
import {
  IExternalHooksService,
  type ExternalHooksServiceOptions,
  type NotificationHookPayload,
  type UserPromptHookDecision,
} from './externalHooks';

function fireAndForget(
  engine: ExternalHooksServiceOptions['hookEngine'],
  event: string,
  inputData: Record<string, unknown>,
  signal: AbortSignal,
  matcherValue?: string,
): void {
  signal.throwIfAborted();
  void engine?.fireAndForgetTrigger(event, { matcherValue, signal, inputData });
}

export class ExternalHooksService implements IExternalHooksService {
  constructor(private readonly options: ExternalHooksServiceOptions = {}) {}

  async triggerPreToolUse(
    payload: Parameters<IExternalHooksService['triggerPreToolUse']>[0],
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
    input: Parameters<IExternalHooksService['triggerUserPromptSubmit']>[0],
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
    payload: Parameters<IExternalHooksService['triggerPostToolUse']>[0],
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

  triggerInterrupt(payload: Parameters<IExternalHooksService['triggerInterrupt']>[0]): void {
    void this.options.hookEngine?.fireAndForgetTrigger('Interrupt', {
      inputData: payload,
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
  output: Parameters<IExternalHooksService['triggerPostToolUse']>[0]['result']['output'],
): string {
  if (typeof output === 'string') return output;
  return output
    .filter((part): part is Extract<(typeof output)[number], { type: 'text' }> => {
      return typeof part === 'object' && part !== null && part.type === 'text';
    })
    .map((part) => part.text)
    .join('');
}

registerSingleton(
  IExternalHooksService,
  new SyncDescriptor(ExternalHooksService, [{}], true),
);
