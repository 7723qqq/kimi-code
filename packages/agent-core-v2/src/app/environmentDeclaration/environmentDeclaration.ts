import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event, IWaitUntil } from '#/_base/event';
import type { EnvironmentDeclarationSet } from '#/remote/declaration/remoteEnvironmentDeclaration';

export interface IEnvironmentDeclarationService {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<EnvironmentDeclarationSet & IWaitUntil>;
  declarations(): Promise<EnvironmentDeclarationSet>;
  registrationError(environmentId: string): Error | undefined;
  reportRegistration(environmentId: string, error?: Error): void;
}

export const IEnvironmentDeclarationService: ServiceIdentifier<IEnvironmentDeclarationService> =
  createDecorator<IEnvironmentDeclarationService>('environmentDeclarationService');
