/**
 * `interaction` domain (L6) — blocking human-in-the-loop request kernel.
 *
 * Defines the `Interaction` model and the `IInteractionService` kernel that
 * owns the session's pending interaction set: a unified, blocking request /
 * response primitive (`request` → `respond`) with change notification
 * (`onDidChange`) and a `listPending` view. `approval` and `question` are
 * typed specializations layered on top of this kernel; the kernel itself is
 * domain-agnostic. Session-scoped — the pending set is keyed by session and
 * dies with it.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

export type InteractionKind = 'approval' | 'question';

export interface InteractionOrigin {
  readonly agentId?: string;
  readonly turnId?: number;
}

export interface InteractionRequest<TPayload = unknown> {
  readonly id?: string;
  readonly kind: InteractionKind;
  readonly payload: TPayload;
  readonly origin?: InteractionOrigin;
}

export interface Interaction<TPayload = unknown> {
  readonly id: string;
  readonly kind: InteractionKind;
  readonly payload: TPayload;
  readonly origin: InteractionOrigin;
}

export interface IInteractionService {
  readonly _serviceBrand: undefined;
  request<TPayload, TResponse>(req: InteractionRequest<TPayload>): Promise<TResponse>;
  respond(id: string, response: unknown): void;
  listPending(kind?: InteractionKind): readonly Interaction[];
  readonly onDidChange: Event<void>;
}

export const IInteractionService: ServiceIdentifier<IInteractionService> =
  createDecorator<IInteractionService>('interactionService');
