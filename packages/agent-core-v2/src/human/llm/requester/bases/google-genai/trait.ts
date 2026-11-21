import type { ToolDescription } from '#/llm/message';
import type { TraitContext } from '#/llm/protocol/base';
import type { ThinkingStrategy } from '@moonshot-ai/core/llm/thinking';

import type { GoogleContent } from '@moonshot-ai/core/llm/builtin/protocol/google-genai/contract';

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
