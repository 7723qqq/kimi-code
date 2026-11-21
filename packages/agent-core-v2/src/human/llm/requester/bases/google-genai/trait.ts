import type { ToolDescription } from '#human/message';
import type { TraitContext } from '#human/llm/protocol/base';
import type { ThinkingStrategy } from '#human/llm/protocol/thinking';

import type { GoogleContent } from './contract';

export interface GoogleGenAITrait {
  readonly thinking?: ThinkingStrategy;

  encodeMaxCompletionTokens?(
    maxCompletionTokens: number,
    ctx: TraitContext,
  ): Record<string, unknown> | undefined;

  convertTool?(tool: ToolDescription, ctx: TraitContext): Record<string, unknown> | undefined;

  mergeHistory?(contents: readonly GoogleContent[], ctx: TraitContext): GoogleContent[] | undefined;

  buildParams?(
    params: Record<string, unknown>,
    ctx: TraitContext,
  ): Record<string, unknown> | undefined;
}
