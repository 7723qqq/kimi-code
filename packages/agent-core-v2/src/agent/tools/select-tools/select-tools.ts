import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const SelectToolsInputSchema = z
  .object({
    names: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        'Exact tool names to load, taken from the latest announcement or a prior search result.',
      ),
    query: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Capability description to search for when the exact tool name is unknown; returns candidates without loading them.',
      ),
  })
  .strict()
  .refine((input) => input.names !== undefined || input.query !== undefined, {
    message: 'Provide names to load or a query to search.',
  });

export type SelectToolsInput = z.infer<typeof SelectToolsInputSchema>;

export interface ISelectToolsTool extends AgentTool<SelectToolsInput> {
  readonly _serviceBrand: undefined;
}
export const ISelectToolsTool = createDecorator<ISelectToolsTool>('selectToolsTool');
