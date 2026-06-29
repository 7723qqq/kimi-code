/**
 * `interaction` domain (L6) — blocking human-in-the-loop request kernel.
 *
 * Defines the `Interaction` model and the `IInteractionService` kernel that
 * owns the session's pending interaction set: a unified, blocking request /
 * response primitive (`request` → `respond`) with change notification
 * (`onDidChange`), a non-blocking enqueue (`enqueue`) for callers that observe
 * the outcome through the `onDidResolve` stream, and a `listPending` view.
 * `approval` and `question` are typed specializations layered on top of this
 * kernel; the kernel itself is domain-agnostic. Session-scoped — the pending
 * set is keyed by session and dies with it.
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

/** Emitted by {@link IInteractionService.onDidResolve} when a request is responded to. */
export interface InteractionResolution {
  readonly id: string;
  readonly response: unknown;
}

export interface IInteractionService {
  readonly _serviceBrand: undefined;
  request<TPayload, TResponse>(req: InteractionRequest<TPayload>): Promise<TResponse>;
  /**
   * Park a request without blocking on its response. Returns the created
   * `Interaction` (with its resolved `id`) immediately; the outcome is
   * delivered through {@link onDidResolve}. Used by edge callers that stream
   * the response rather than awaiting a Promise.
   */
  enqueue<TPayload>(req: InteractionRequest<TPayload>): Interaction;
  respond(id: string, response: unknown): void;
  listPending(kind?: InteractionKind): readonly Interaction[];
  readonly onDidChange: Event<void>;
  /** Fires when a pending request is responded to, carrying its id and response. */
  readonly onDidResolve: Event<InteractionResolution>;
}

export const IInteractionService: ServiceIdentifier<IInteractionService> =
  createDecorator<IInteractionService>('interactionService');
