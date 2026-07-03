/**
 * `externalHooks` domain (L5) — contract for configured external hook
 * commands.
 *
 * The service is intentionally observer-shaped: business domains expose their
 * own minimal hook contexts, and the L5 implementation listens to those hooks
 * to invoke configured external commands.
 */

import { createDecorator } from '#/_base/di';
import type { HookEngine } from './engine';

export interface RenderedExternalHookResult {
  readonly event: string;
  readonly message: string;
  readonly text: string;
}

export interface ExternalHooksServiceOptions {
  readonly hookEngine?:
    | Pick<HookEngine, 'trigger' | 'triggerBlock' | 'fireAndForgetTrigger'>
    | undefined;
}

export interface IAgentExternalHooksService {
  readonly _serviceBrand: undefined;
}

export const IAgentExternalHooksService =
  createDecorator<IAgentExternalHooksService>('agentExternalHooksService');
