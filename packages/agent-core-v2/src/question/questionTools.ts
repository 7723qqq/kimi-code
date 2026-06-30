/**
 * `question` domain (L7) — ask-user tool registration contract.
 *
 * `IQuestionToolsService` is a marker: its implementation registers the
 * built-in `AskUserQuestion` tool into the agent `IToolRegistry` on
 * construction. Bound at Agent scope (the tool needs the agent-scoped
 * `IToolRegistry` and `IBackgroundService`, plus the session-scoped
 * `IQuestionService`).
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IQuestionToolsService {
  readonly _serviceBrand: undefined;
}

export const IQuestionToolsService: ServiceIdentifier<IQuestionToolsService> =
  createDecorator<IQuestionToolsService>('questionToolsService');
