/**
 * `contextOps` domain (L4) — `IAgentContextOpsService` implementation.
 *
 * Defines the standard operations against `contextMemory`'s operation
 * registry. `append` splices at the end (Infinity start) and mirrors each
 * message into the replay read model; `remove` splices out each resolved
 * target and drops the matching replay messages; `clear` drops the whole
 * history and cuts a new replay segment; `replace` swaps one message in
 * place and patches the replay copy by removing/re-pushing it. Message
 * content is offloaded to the blob store through each operation's blob
 * selector. Bound at Agent scope.
 */

import { Disposable } from "#/_base/di";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import {
  ensureMessageId,
  IAgentContextMemoryService,
  type ContextMessage,
  type ContextOperation,
  type ContextOperationBlobTarget,
} from '#/agent/contextMemory';

import {
  IAgentContextOpsService,
  type ContextAppendArgs,
  type ContextClearArgs,
  type ContextRemovalTarget,
  type ContextRemoveArgs,
  type ContextReplaceArgs,
} from './contextOps';

export function removalMessageIds(removals: readonly ContextRemovalTarget[]): Set<string> {
  const ids = new Set<string>();
  for (const removal of removals) {
    if (removal.messageId !== undefined) ids.add(removal.messageId);
  }
  return ids;
}

function normalizeAppendMessages(messages: readonly ContextMessage[]): readonly ContextMessage[] {
  const first = messages[0];
  if (messages.length === 1 && Array.isArray(first)) {
    return first as readonly ContextMessage[];
  }
  return messages;
}

function messageContentBlobTarget<T extends readonly unknown[]>(
  message: ContextMessage,
  rebuild: (args: T, message: ContextMessage) => T,
  read: (args: T) => ContextMessage,
): ContextOperationBlobTarget<T> {
  return {
    parts: message.content,
    replace: (args, parts) => {
      const current = read(args);
      return rebuild(args, { ...current, content: [...parts] });
    },
  };
}

export class AgentContextOpsService extends Disposable implements IAgentContextOpsService {
  declare readonly _serviceBrand: undefined;

  private readonly appendOperation: ContextOperation<ContextAppendArgs>;
  private readonly removeOperation: ContextOperation<ContextRemoveArgs>;
  private readonly clearOperation: ContextOperation<ContextClearArgs>;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
  ) {
    super();

    this.appendOperation = context.defineOperation<ContextAppendArgs>({
      type: 'append',
      apply: (splice, ...messages) => {
        splice(Number.POSITIVE_INFINITY, 0, normalizeAppendMessages(messages));
      },
      replay: (replay, ...messages) => {
        for (const message of normalizeAppendMessages(messages)) {
          replay.push({ type: 'message', message });
        }
      },
      blobs: (messages) =>
        normalizeAppendMessages(messages).map((message, index) =>
          messageContentBlobTarget<ContextAppendArgs>(
            message,
            (current, next) =>
              normalizeAppendMessages(current).map((item, itemIndex) =>
                itemIndex === index ? next : item,
              ),
            (current) => normalizeAppendMessages(current)[index]!,
          ),
        ),
    });

    this.removeOperation = context.defineOperation<ContextRemoveArgs>({
      type: 'remove',
      apply: (splice, removals) => {
        for (const removal of removals) {
          splice(removal.index, 1, []);
        }
      },
      replay: (replay, removals) => {
        replay.removeMessages(removalMessageIds(removals));
      },
    });

    this.clearOperation = context.defineOperation<ContextClearArgs>({
      type: 'clear',
      apply: (splice) => {
        splice(0, Number.POSITIVE_INFINITY, []);
      },
      replay: (replay) => {
        replay.cut();
      },
    });

    // Migration-only: the v1.5 migration rewrites incremental streaming
    // updates (v1.4 `update_message`) into in-place replaces. No live caller.
    context.defineOperation<ContextReplaceArgs>({
      type: 'replace',
      apply: (splice, index, message) => {
        splice(index, 1, [message]);
      },
      replay: (replay, _index, message) => {
        if (message.id !== undefined) {
          replay.removeMessages(new Set([message.id]));
        }
        replay.push({ type: 'message', message });
      },
      blobs: ([, message]) => [
        messageContentBlobTarget<ContextReplaceArgs>(
          message,
          ([index], next) => [index, next],
          ([, current]) => current,
        ),
      ],
    });
  }

  append(...messages: readonly ContextMessage[]): void {
    if (messages.length === 0) return;
    this.appendOperation(...messages.map(ensureMessageId));
  }

  remove(removals: readonly ContextRemovalTarget[]): void {
    if (removals.length === 0) return;
    this.removeOperation(removals);
  }

  clear(): void {
    if (this.context.get().length === 0) return;
    this.clearOperation();
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextOpsService,
  AgentContextOpsService,
  InstantiationType.Delayed,
  'contextOps',
);
