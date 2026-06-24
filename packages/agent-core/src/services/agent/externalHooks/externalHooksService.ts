import { registerSingleton, SyncDescriptor } from '../../../di';
import {
  renderUserPromptHookBlockResult,
  renderUserPromptHookResult,
} from '../../../session/hooks';
import { toKimiErrorPayload } from '../../../errors';
import {
  IExternalHooksService,
  type ExternalHooksServiceOptions,
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

  async triggerPermissionRequest(
    payload: Parameters<IExternalHooksService['triggerPermissionRequest']>[0],
    signal: AbortSignal,
  ): Promise<void> {
    fireAndForget(this.options.hookEngine, 'PermissionRequest', payload, signal, payload.toolName);
  }

  async triggerPermissionResult(
    payload: Parameters<IExternalHooksService['triggerPermissionResult']>[0],
    signal: AbortSignal,
  ): Promise<void> {
    fireAndForget(this.options.hookEngine, 'PermissionResult', payload, signal, payload.toolName);
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
