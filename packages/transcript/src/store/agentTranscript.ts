import type { TranscriptAttachment } from '../model/attachment';
import type {
  AgentId,
  AttachmentId,
  InteractionId,
  PromptId,
  TaskId,
  TurnId,
} from '../model/ids';
import type { TranscriptInteraction } from '../model/interaction';
import type { TranscriptItem } from '../model/item';
import type { TranscriptPrompt } from '../model/prompt';
import type { TranscriptTask } from '../model/task';
import type { TranscriptTurn } from '../model/turn';
import { TranscriptDocument } from '../ops/apply';
import type {
  AgentTranscriptSnapshot,
  AppendTarget,
  AppliedOps,
  TranscriptChangeEvent,
  TranscriptOperation,
} from '../ops/operation';

export type TranscriptListener = (event: TranscriptChangeEvent) => void;

export interface Disposable {
  dispose(): void;
}

export class AgentTranscript {
  readonly #doc = new TranscriptDocument();
  readonly #listeners = new Set<TranscriptListener>();

  constructor(readonly agentId: AgentId) {}

  receive(ops: readonly TranscriptOperation[]): AppliedOps {
    return this.apply(ops);
  }

  apply(ops: readonly TranscriptOperation[]): AppliedOps {
    const accepted: TranscriptOperation[] = [];
    let gap: AppliedOps['gap'];
    for (const op of ops) {
      const result = this.#doc.apply(op);
      if (result.gap) {
        gap ??= { target: (op as { target: AppendTarget }).target, ...result.gap };
        continue;
      }
      if (!result.changed) continue;
      accepted.push(op);
    }
    if (accepted.length > 0) {
      const event: TranscriptChangeEvent = { agentId: this.agentId, ops: accepted };
      for (const listener of this.#listeners) listener(event);
    }
    return { accepted, gap };
  }

  onChange(listener: TranscriptListener): Disposable {
    this.#listeners.add(listener);
    return { dispose: () => void this.#listeners.delete(listener) };
  }

  getItems(): readonly TranscriptItem[] {
    return this.#doc.items;
  }

  getTurn(turnId: TurnId): TranscriptTurn | undefined {
    return this.#doc.getTurn(turnId);
  }

  getTasks(): ReadonlyMap<TaskId, TranscriptTask> {
    return this.#doc.tasks;
  }

  getTask(taskId: TaskId): TranscriptTask | undefined {
    return this.#doc.tasks.get(taskId);
  }

  getInteractions(): ReadonlyMap<InteractionId, TranscriptInteraction> {
    return this.#doc.interactions;
  }

  getInteraction(interactionId: InteractionId): TranscriptInteraction | undefined {
    return this.#doc.interactions.get(interactionId);
  }

  getAttachments(): ReadonlyMap<AttachmentId, TranscriptAttachment> {
    return this.#doc.attachments;
  }

  getAttachment(attachmentId: AttachmentId): TranscriptAttachment | undefined {
    return this.#doc.attachments.get(attachmentId);
  }

  getPrompts(): ReadonlyMap<PromptId, TranscriptPrompt> {
    return this.#doc.prompts;
  }

  getPrompt(promptId: PromptId): TranscriptPrompt | undefined {
    return this.#doc.prompts.get(promptId);
  }

  listPendingInteractions(): readonly InteractionId[] {
    return [...this.#doc.pendingInteractions];
  }

  get hasMoreOlder(): boolean {
    return this.#doc.hasMoreOlder;
  }

  snapshot(window?: { tailTurns: number }): AgentTranscriptSnapshot {
    return this.#doc.snapshot(window);
  }
}
