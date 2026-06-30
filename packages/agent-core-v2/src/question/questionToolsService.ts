/**
 * `question` domain (L7) — `IQuestionToolsService` implementation.
 *
 * Registers the built-in `AskUserQuestion` tool into the agent `IToolRegistry`
 * on construction, wiring it to the session `IQuestionService` (ask-user
 * broker), the agent `IBackgroundService` (background-question lifecycle) and
 * `ITelemetryService`. Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IBackgroundService } from '#/background';
import { ITelemetryService } from '#/telemetry';
import { IToolRegistry } from '#/toolRegistry';

import { IQuestionService } from './question';
import { IQuestionToolsService } from './questionTools';
import { AskUserQuestionTool } from './tools/ask-user';

export class QuestionToolsService implements IQuestionToolsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IToolRegistry toolRegistry: IToolRegistry,
    @IQuestionService question: IQuestionService,
    @IBackgroundService background: IBackgroundService,
    @ITelemetryService telemetry: ITelemetryService,
  ) {
    toolRegistry.register(new AskUserQuestionTool(question, background, telemetry));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IQuestionToolsService,
  QuestionToolsService,
  InstantiationType.Delayed,
  'questionTools',
);
