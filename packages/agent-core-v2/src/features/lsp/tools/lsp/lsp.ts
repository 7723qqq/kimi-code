/**
 * `lsp` domain — `ILspTool` contract (the `lsp` tool).
 *
 * Model-facing semantic navigation tool: runs one of four LSP operations
 * (go-to-definition, find-references, go-to-implementation, hover) at a
 * position in a file. Positions are one-based UTF-16 on the wire (matching
 * how editors display them); the tool converts to the zero-based protocol
 * positions before querying. Bound at Agent scope.
 */

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
    file_path: z
      .string()
      .describe('Absolute path of the file to query.'),
    line: z
      .number()
      .int()
      .min(1)
      .describe('One-based line number of the position to query.'),
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
