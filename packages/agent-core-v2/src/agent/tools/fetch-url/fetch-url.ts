import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const FetchURLInputSchema = z.object({
  url: z.string().describe('The URL to fetch content from.'),
  query: z
    .string()
    .optional()
    .describe(
      'Optional query or topic to extract only the highest-ranked relevant passages from large pages.',
    ),
  maxChars: z
    .number()
    .int()
    .min(500)
    .max(200_000)
    .optional()
    .describe('Optional maximum output character budget (500-200000).'),
  bypassCache: z
    .boolean()
    .optional()
    .describe('Skip cached content and re-fetch directly from the origin URL.'),
});

export type FetchURLInput = z.infer<typeof FetchURLInputSchema>;

export interface IFetchURLTool extends AgentTool<FetchURLInput> {
  readonly _serviceBrand: undefined;
}
export const IFetchURLTool = createDecorator<IFetchURLTool>('fetchURLTool');
