import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export type SessionQueryOperation = 'session_search' | 'event_search' | 'session_trace';

export const SessionQueryToolInput = z
  .object({
    operation: z
      .enum(['session_search', 'event_search', 'session_trace'])
      .describe(
        'Which session-query operation to run: session_search (cross-session full-text search), event_search (within-session event search), or session_trace (fork lineage of one session).',
      ),
    operationArgs: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Operation-specific arguments (validated per operation).'),
  })
  .strict();

export type SessionQueryToolInput = z.infer<typeof SessionQueryToolInput>;

export interface ISessionQueryTool extends AgentTool<SessionQueryToolInput> {
  readonly _serviceBrand: undefined;
}

export const ISessionQueryTool = createDecorator<ISessionQueryTool>('sessionQueryTool');
