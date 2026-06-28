/**
 * `session-metadata` domain (L6) — typed session metadata.
 *
 * Defines the `SessionMeta` model and the `ISessionMetadata` used by upper
 * layers to read and update the session's durable metadata (title, timestamps,
 * archived flag, fork provenance). Owns the in-memory copy, persists it as a
 * single atomic document through `storage`, and notifies changes via
 * `onDidChange`. Session-scoped — one instance per session. The initial
 * document is materialized when the session is created.
 */

import type { Event } from '#/_base/event';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface SessionMeta {
  readonly id: string;
  readonly title?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly forkedFrom?: string;
}

export type SessionMetaPatch = Partial<Omit<SessionMeta, 'id' | 'createdAt'>>;

export interface ISessionMetadata {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  readonly onDidChange: Event<void>;
  read(): Promise<SessionMeta>;
  update(patch: SessionMetaPatch): Promise<void>;
  setTitle(title: string): Promise<void>;
  setArchived(archived: boolean): Promise<void>;
}

export const ISessionMetadata: ServiceIdentifier<ISessionMetadata> =
  createDecorator<ISessionMetadata>('sessionMetadata');
