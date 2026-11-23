import { anthropicProtocol } from '#/llm/builtin/protocol/anthropic/index';
import { createRequester } from '#/llm/requester';

export {
  BUDGET_THINKING_EFFORTS,
  matchKnownAnthropicModelProfile,
  matchUnknownClaudeProfile,
} from '#/llm/builtin/protocol/anthropic/legalize';

export const anthropicRequester = createRequester().with({
  protocol: { base: anthropicProtocol },
});
