import { registerSingleton, SyncDescriptor } from '../../../di';
import {
  renderUserPromptHookBlockResult,
  renderUserPromptHookResult,
} from '../../../session/hooks';
import {
  IExternalHooksService,
  type ExternalHooksServiceOptions,
  type UserPromptHookDecision,
} from './externalHooks';

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
}

registerSingleton(
  IExternalHooksService,
  new SyncDescriptor(ExternalHooksService, [{}], true),
);
