import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const LspInputSchema = z
  .object({
    operation: z
      .enum(['goToDefinition', 'findReferences', 'goToImplementation', 'hover'])
      .describe(
        'The semantic operation to run: goToDefinition (jump to the symbol definition), findReferences (all references to the symbol), goToImplementation (implementations of an interface/abstract member), hover (type and doc information at the position).',
      ),
    file_path: z.string().describe('Absolute path of the file to query.'),
    line: z.number().int().min(1).describe('One-based line number of the position to query.'),
    character: z
      .number()
      .int()
      .min(1)
      .describe('One-based character offset (in UTF-16 code units) of the position to query.'),
  })
  .strict();

export type LspInput = z.infer<typeof LspInputSchema>;

export interface ILspTool extends AgentTool<LspInput> {
  readonly _serviceBrand: undefined;
}
export const ILspTool = createDecorator<ILspTool>('lspTool');
