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
  private nextId = 0;

  request<TPayload, TResponse>(req: InteractionRequest<TPayload>): Promise<TResponse> {
    const id = req.id ?? this.generateId();
    const origin: InteractionOrigin = req.origin ?? {};
    return new Promise<TResponse>((resolve) => {
      const interaction: Interaction<TPayload> = {
        id,
        kind: req.kind,
        payload: req.payload,
        origin,
      };
      this.pending.set(id, { interaction, resolve: resolve as (response: unknown) => void });
      this._onDidChange.fire();
    });
  }

  respond(id: string, response: unknown): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    entry.resolve(response);
    this._onDidChange.fire();
  }

  listPending(kind?: InteractionKind): readonly Interaction[] {
    const all = [...this.pending.values()].map((p) => p.interaction);
    return kind === undefined ? all : all.filter((i) => i.kind === kind);
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
