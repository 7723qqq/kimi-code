import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import {
  PromptAborted,
  PromptCompleted,
  PromptQueued,
  PromptStarted,
  PromptSubmitted,
} from '#/agent/prompt/promptEvents';
import type { IEventDispatcher } from '#/state/eventDispatcher';
import { stripBundledSkillBlocks } from '#human/agent/origin';

export interface PromptEventPublisherHost {
  readonly agentId: string;
  queueLength(): number;
}

export class PromptEventPublisher {
  constructor(
    private readonly dispatcher: IEventDispatcher,
    private readonly host: PromptEventPublisherHost,
  ) {}

  completed(promptId: string, reason: 'completed' | 'failed' | 'blocked'): void {
    void this.dispatcher.dispatch(
      new PromptCompleted({
        agentId: this.host.agentId,
        promptId,
        finishedAt: new Date().toISOString(),
        reason,
      }),
    );
  }

  queued(input: {
    readonly promptId: string;
    readonly origin: PromptOrigin;
    readonly message: ContextMessage;
  }): void {
    if (input.origin.kind !== 'user') return;
    void this.dispatcher.dispatch(
      new PromptQueued({
        agentId: this.host.agentId,
        promptId: input.promptId,
        content: stripBundledSkillBlocks(input.message),
        clientMetadata: input.origin.clientMetadata,
        queueLength: this.host.queueLength(),
      }),
    );
  }

  submitted(
    input: {
      readonly promptId: string;
      readonly origin: PromptOrigin;
      readonly userMessageId: string;
      readonly createdAt: string;
      readonly message: ContextMessage;
    },
    status: 'running' | 'queued',
  ): void {
    if (input.origin.kind !== 'user') return;
    void this.dispatcher.dispatch(
      new PromptSubmitted({
        agentId: this.host.agentId,
        promptId: input.promptId,
        userMessageId: input.userMessageId,
        status,
        content: stripBundledSkillBlocks(input.message),
        clientMetadata: input.origin.clientMetadata,
        createdAt: input.createdAt,
      }),
    );
  }

  started(promptId: string, origin: PromptOrigin): void {
    if (origin.kind !== 'user') return;
    void this.dispatcher.dispatch(
      new PromptStarted({
        agentId: this.host.agentId,
        promptId,
      }),
    );
  }

  aborted(promptId: string): void {
    void this.dispatcher.dispatch(
      new PromptAborted({
        agentId: this.host.agentId,
        promptId,
        abortedAt: new Date().toISOString(),
      }),
    );
  }
}
