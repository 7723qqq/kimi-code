import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

export interface WorkspaceTrustChange {
  readonly trusted: boolean;
}

export interface IProjectTrust {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  get(): Promise<boolean>;

  isTrusted(): boolean;

  trust(): Promise<void>;
  untrust(): Promise<void>;

  readonly onDidChange: Event<WorkspaceTrustChange>;
}

export const IProjectTrust: ServiceIdentifier<IProjectTrust> =
  createDecorator<IProjectTrust>('workspaceTrust');
