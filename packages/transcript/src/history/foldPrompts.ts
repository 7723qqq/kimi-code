import { projectPromptContentParts, type PromptContentPart } from '../contract/promptContent';
import type { TranscriptPrompt, TranscriptPromptStatus } from '../model/prompt';
import type { HistoryWireRecord } from './foldFacts';
import {
  annotateBundledSkillParts,
  isSkillActivationPart,
  type BundledSkillActivation,
} from './groupTurns';

interface PromptOriginShape {
  readonly kind?: unknown;
  readonly clientMetadata?: unknown;
  readonly skillActivations?: unknown;
}

interface UndoAnchor {
  readonly order: number;
  readonly promptId?: string;
}

interface PendingPrompt {
  readonly order: number;
  readonly origin: PromptOriginShape | undefined;
  readonly input: unknown;
  readonly createdAt: string | undefined;
}

export interface PromptFactsProjector {
  add(record: HistoryWireRecord): void;
  result(): readonly TranscriptPrompt[];
}

export function foldPromptFacts(records: Iterable<HistoryWireRecord>): readonly TranscriptPrompt[] {
  const projector = createPromptFactsProjector();
  for (const record of records) projector.add(record);
  return projector.result();
}

export function createPromptFactsProjector(): PromptFactsProjector {
  const prompts = new Map<string, TranscriptPrompt>();
  const createdOrder = new Map<string, number>();
  const undoAnchors: UndoAnchor[] = [];
  const pendingPrompts = new Map<string, PendingPrompt>();
  let undoAnchorFloor = 0;
  let order = 0;

  const upsert = (prompt: TranscriptPrompt, createOrder?: number): void => {
    if (createOrder !== undefined) pendingPrompts.delete(prompt.promptId);
    prompts.set(prompt.promptId, prompt);
    if (createOrder !== undefined) createdOrder.set(prompt.promptId, createOrder);
  };

  const createTurnPrompt = (promptId: string, pending: PendingPrompt): void => {
    if (prompts.has(promptId)) return;
    upsert(
      {
        promptId,
        status: 'running',
        userMessageId: promptId,
        content: promptContentOf(pending.input, pending.origin),
        clientMetadata: clientMetadataOf(pending.origin),
        createdAt: pending.createdAt ?? '',
      },
      pending.order,
    );
  };

  const add = (record: HistoryWireRecord): void => {
    order += 1;
    switch (record.type) {
      case 'turn.prompt': {
        const origin = originOf(record);
        const promptId = record['promptId'];
        if (typeof promptId !== 'string' || promptId.length === 0) break;
        if (originKind(origin) !== 'user') break;
        if (prompts.has(promptId) || pendingPrompts.has(promptId)) break;
        pendingPrompts.set(promptId, {
          order,
          origin,
          input: record['input'],
          createdAt: recordTimeIso(record),
        });
        break;
      }
      case 'prompt.completed': {
        const promptId = record['promptId'];
        if (typeof promptId !== 'string' || promptId.length === 0) break;
        const reason = record['reason'];
        const status: TranscriptPromptStatus =
          reason === 'failed' || reason === 'blocked' ? reason : 'completed';
        const finishedAt = recordTimeIso(record);
        const prev = prompts.get(promptId);
        if (prev === undefined) {
          upsert({ promptId, status, createdAt: finishedAt ?? '', finishedAt }, order);
        } else {
          upsert({ ...prev, status, finishedAt: finishedAt ?? prev.finishedAt });
        }
        break;
      }
      case 'prompt.aborted': {
        const promptId = record['promptId'];
        if (typeof promptId !== 'string' || promptId.length === 0) break;
        const abortedAt = recordTimeIso(record);
        const prev = prompts.get(promptId);
        if (prev === undefined) {
          upsert(
            {
              promptId,
              status: 'aborted',
              createdAt: abortedAt ?? '',
              finishedAt: abortedAt,
            },
            order,
          );
        } else {
          upsert({ ...prev, status: 'aborted', finishedAt: abortedAt ?? prev.finishedAt });
        }
        break;
      }
      case 'prompt.steered': {
        const steeredAt = recordTimeIso(record);
        if (steeredAt === undefined) break;
        const activePromptId = record['activePromptId'];
        if (typeof activePromptId === 'string' && activePromptId.length > 0) {
          const prev = prompts.get(activePromptId);
          upsert(
            prev === undefined
              ? {
                  promptId: activePromptId,
                  status: 'running',
                  content: promptContentOf(record['content'], undefined),
                  createdAt: steeredAt,
                  steeredAt,
                }
              : { ...prev, steeredAt },
            prev === undefined ? order : undefined,
          );
        }
        const promptIds = record['promptIds'];
        if (!Array.isArray(promptIds)) break;
        for (const promptId of promptIds) {
          if (typeof promptId !== 'string' || promptId.length === 0) continue;
          const prev = prompts.get(promptId);
          upsert(
            prev === undefined
              ? {
                  promptId,
                  status: 'completed',
                  createdAt: steeredAt,
                  finishedAt: steeredAt,
                  steeredAt,
                }
              : { ...prev, status: 'completed', finishedAt: steeredAt, steeredAt },
            prev === undefined ? order : undefined,
          );
        }
        break;
      }
      case 'context.append_message': {
        const message = readUserMessage(record);
        if (message?.undoAnchor === true) {
          undoAnchors.push({ order, promptId: message.id });
        }
        if (message?.id !== undefined) {
          const pending = pendingPrompts.get(message.id);
          if (pending !== undefined) createTurnPrompt(message.id, pending);
        }
        break;
      }
      case 'context.undo': {
        const count = record['count'];
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) break;
        let removedFrom: number | undefined;
        const removedIds = new Set<string>();
        for (let i = 0; i < count && undoAnchors.length > undoAnchorFloor; i++) {
          const anchor = undoAnchors.pop();
          if (anchor === undefined) continue;
          if (removedFrom === undefined || anchor.order < removedFrom) {
            removedFrom = anchor.order;
          }
          if (anchor.promptId !== undefined) removedIds.add(anchor.promptId);
        }
        if (removedFrom === undefined) break;
        for (const [promptId, created] of createdOrder) {
          if (created < removedFrom && !removedIds.has(promptId)) continue;
          prompts.delete(promptId);
          createdOrder.delete(promptId);
        }
        break;
      }
      case 'context.clear': {
        undoAnchorFloor = undoAnchors.length;
        break;
      }
      default:
        break;
    }
  };

  return { add, result: () => [...prompts.values()] };
}

function originOf(record: HistoryWireRecord): PromptOriginShape | undefined {
  const origin = record['origin'];
  return typeof origin === 'object' && origin !== null ? (origin as PromptOriginShape) : undefined;
}

function readUserMessage(
  record: HistoryWireRecord,
): { readonly id?: string; readonly undoAnchor: boolean } | undefined {
  const raw = record['message'];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const message = raw as {
    readonly role?: unknown;
    readonly id?: unknown;
    readonly origin?: {
      readonly kind?: unknown;
      readonly trigger?: unknown;
      readonly inTurn?: unknown;
    };
  };
  if (message.role !== 'user') return undefined;
  const id = typeof message.id === 'string' && message.id.length > 0 ? message.id : undefined;
  const origin = message.origin;
  if (origin !== undefined && origin.inTurn === true) return { id, undoAnchor: false };
  const kind = origin?.kind;
  if (kind === undefined || kind === 'user') return { id, undoAnchor: true };
  const slash =
    (kind === 'skill_activation' || kind === 'plugin_command') && origin?.trigger === 'user-slash';
  return { id, undoAnchor: slash };
}

function originKind(origin: PromptOriginShape | undefined): string {
  return typeof origin?.kind === 'string' ? origin.kind : 'user';
}

function clientMetadataOf(
  origin: PromptOriginShape | undefined,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  if (!Array.isArray(origin?.clientMetadata)) return undefined;
  const metadata = origin.clientMetadata.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  );
  return metadata.length > 0 ? metadata : undefined;
}

function skillActivationsOf(
  origin: PromptOriginShape | undefined,
): readonly BundledSkillActivation[] {
  if (originKind(origin) !== 'user' || !Array.isArray(origin?.skillActivations)) return [];
  return origin.skillActivations.filter(
    (activation): activation is BundledSkillActivation =>
      typeof activation === 'object' &&
      activation !== null &&
      typeof (activation as { activationId?: unknown }).activationId === 'string' &&
      typeof (activation as { skillName?: unknown }).skillName === 'string',
  );
}

function promptContentOf(
  input: unknown,
  origin: PromptOriginShape | undefined,
): readonly PromptContentPart[] {
  if (!Array.isArray(input)) return [];
  const parts = input.filter(
    (part): part is { readonly type: string } =>
      typeof part === 'object' && part !== null && typeof (part as { type?: unknown }).type === 'string',
  );
  return projectPromptContentParts(
    annotateBundledSkillParts(parts, skillActivationsOf(origin)).filter(
      (part) => !isSkillActivationPart(part),
    ),
  );
}

function recordTimeIso(record: HistoryWireRecord): string | undefined {
  const time: unknown = record.time;
  if (typeof time === 'number' && Number.isFinite(time)) return new Date(time).toISOString();
  if (typeof time === 'string') return time;
  return undefined;
}
