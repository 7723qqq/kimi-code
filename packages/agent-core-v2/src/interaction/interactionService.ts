/**
 * `interaction` domain (L6) — `IInteractionService` implementation.
 *
 * Owns the pending interaction set and resolves requests when a response
 * arrives; announces add/remove through a typed `onDidChange`. Bound at
 * Session scope.
 */

import { Emitter, type Event } from '#/_base/event';
import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import {
  type Interaction,
  type InteractionKind,
  type InteractionOrigin,
  type InteractionRequest,
  type InteractionResolution,
  IInteractionService,
} from './interaction';

interface Pending {
  readonly interaction: Interaction;
  readonly resolve: (response: unknown) => void;
}

export class InteractionService extends Disposable implements IInteractionService {
  declare readonly _serviceBrand: undefined;

  private readonly pending = new Map<string, Pending>();
  private readonly _onDidChange = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this._onDidChange.event;
  private readonly _onDidResolve = this._register(new Emitter<InteractionResolution>());
  readonly onDidResolve: Event<InteractionResolution> = this._onDidResolve.event;
  private nextId = 0;

  request<TPayload, TResponse>(req: InteractionRequest<TPayload>): Promise<TResponse> {
    return new Promise<TResponse>((resolve) => {
      this.park(req, resolve as (response: unknown) => void);
    });
  }

  enqueue<TPayload>(req: InteractionRequest<TPayload>): Interaction {
    return this.park(req, () => {});
  }

  respond(id: string, response: unknown): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    entry.resolve(response);
    this._onDidChange.fire();
    this._onDidResolve.fire({ id, response });
  }

  listPending(kind?: InteractionKind): readonly Interaction[] {
    const all = [...this.pending.values()].map((p) => p.interaction);
    return kind === undefined ? all : all.filter((i) => i.kind === kind);
  }

  private park<TPayload>(
    req: InteractionRequest<TPayload>,
    resolve: (response: unknown) => void,
  ): Interaction {
    const id = req.id ?? this.generateId();
    const origin: InteractionOrigin = req.origin ?? {};
    const interaction: Interaction<TPayload> = {
      id,
      kind: req.kind,
      payload: req.payload,
      origin,
    };
    this.pending.set(id, { interaction, resolve });
    this._onDidChange.fire();
    return interaction;
  }

  private generateId(): string {
    return `interaction-${this.nextId++}`;
  }
}

registerScopedService(
  LifecycleScope.Session,
  IInteractionService,
  InteractionService,
  InstantiationType.Delayed,
  'interaction',
);
