import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import type { WatchChange } from '#human/utils/watch';

export interface WorkspaceInstructionsSnapshot {
  readonly agentsMd: string | undefined;
  readonly agentsMdWarning: string | undefined;
  readonly agentsMdPaths: readonly string[] | undefined;
}

export interface IWorkspaceInstructionsService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly snapshot: WorkspaceInstructionsSnapshot;
  readonly onDidChange: Event<readonly WatchChange[]>;
  reload(): Promise<void>;
  sessionProvider(): ISessionInstructionsProvider;
}

export const IWorkspaceInstructionsService: ServiceIdentifier<IWorkspaceInstructionsService> =
  createDecorator<IWorkspaceInstructionsService>('workspaceInstructionsService');
