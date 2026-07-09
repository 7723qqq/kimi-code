import { createDecorator } from "#/_base/di/instantiation";
import type { ContextMessage } from "#/agent/contextMemory/types";
import type { Turn } from "#/agent/turn/turn";
import type { Hooks } from '#/hooks';

export interface PromptSubmitContext {
  readonly promptMessage: ContextMessage;
  readonly isSteer: boolean;
  block: boolean;
}

export interface PromptSteerHandle {
  removeFromQueue(): void;
  readonly launched: Promise<Turn | undefined>;
}

export interface IAgentPromptService {
  readonly _serviceBrand: undefined;

  prompt(message: ContextMessage): Promise<Turn | undefined>;
  steer(message: ContextMessage): PromptSteerHandle;
  retry(): Turn | undefined;
  /**
   * Remove the trailing `count` real-user prompts and the exchange that follows
   * them. Returns the number of prompts removed. Throws
   * `session.undo_unavailable` (with a structured `reason` of `empty` /
   * `compaction_boundary` / `insufficient`) when fewer than `count` prompts can
   * be undone — no state is removed in that case.
   */
  undo(count: number): number;
  clear(): void;

  readonly hooks: Hooks<{
    onWillSubmitPrompt: PromptSubmitContext;
  }>;
}

export const IAgentPromptService = createDecorator<IAgentPromptService>('agentPromptService');
