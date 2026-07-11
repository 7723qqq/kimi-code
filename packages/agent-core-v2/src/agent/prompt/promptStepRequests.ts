/**
 * `prompt` domain (L4) — the `StepRequest` types `AgentPromptService` sends.
 *
 * `PromptStepRequest` / `SteerStepRequest` carry an already-built user
 * `ContextMessage` (image-compression captions pre-split) and materialize it
 * at pop time — caption reminders first, message second, mirroring the old
 * `appendPrompt` ordering. `PromptStepRequest` is `nextTurn` (it starts a
 * fresh turn, seeding the `turn.prompt` record from its message);
 * `SteerStepRequest` is `tryInTurn`, mergeable (folds into the next step's
 * driver) and survives turn boundaries (drained by a later run); it records
 * the `turn.steer` wire op on materialization and unregisters itself from the
 * service's pending-steer set once settled. `RetryStepRequest` is `nextTurn`
 * too: it contributes no message and simply drives one more step over the
 * existing context. Constructed by the prompt service with its collaborators
 * captured — these are plain runtime objects, not DI services.
 */

import { USER_PROMPT_ORIGIN, type ContextMessage } from '#/agent/contextMemory/types';
import { StepRequest, type StepRequestOptions, type TurnSeed } from '#/agent/loop/stepRequest';
import type { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';

abstract class UserMessageStepRequest extends StepRequest {
  constructor(
    protected readonly message: ContextMessage,
    private readonly captions: readonly string[],
    private readonly reminders: IAgentSystemReminderService,
    options?: StepRequestOptions,
  ) {
    super(options);
  }

  override onWillMaterialize(): void {
    for (const caption of this.captions) {
      this.reminders.appendSystemReminder(caption, {
        kind: 'injection',
        variant: 'image_compression',
      });
    }
  }

  resolveContextMessages(): readonly ContextMessage[] {
    // A message whose content was caption-only is dropped entirely rather than
    // appended empty (the reminders still landed).
    return this.message.content.length > 0 ? [this.message] : [];
  }
}

export class PromptStepRequest extends UserMessageStepRequest {
  readonly kind = 'prompt';

  constructor(
    message: ContextMessage,
    captions: readonly string[],
    reminders: IAgentSystemReminderService,
  ) {
    super(message, captions, reminders, { priority: 'nextTurn' });
  }

  override get turnSeed(): TurnSeed {
    return { input: this.message.content, origin: this.message.origin ?? USER_PROMPT_ORIGIN };
  }
}

export class SteerStepRequest extends UserMessageStepRequest {
  readonly kind = 'steer';

  constructor(
    message: ContextMessage,
    captions: readonly string[],
    reminders: IAgentSystemReminderService,
    private readonly recordSteer: (message: ContextMessage) => void,
    private readonly forgetSteer: (request: SteerStepRequest) => void,
  ) {
    super(message, captions, reminders, { mergeable: true, turnScoped: false });
  }

  override onWillMaterialize(): void {
    this.recordSteer(this.message);
    super.onWillMaterialize();
  }

  protected override onSettled(): void {
    this.forgetSteer(this);
  }
}

export class RetryStepRequest extends StepRequest {
  readonly kind = 'retry';

  constructor() {
    super({ priority: 'nextTurn' });
  }

  override get turnSeed(): TurnSeed {
    return { input: [], origin: { kind: 'retry' } };
  }

  resolveContextMessages(): readonly ContextMessage[] {
    return [];
  }
}
