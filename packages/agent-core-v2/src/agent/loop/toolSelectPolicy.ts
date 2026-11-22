import type { LlmResolver } from '@moonshot-ai/core/llm/policy/resolver';
import { withProtocolCapabilities } from '@moonshot-ai/core/llm/protocol/rules/model';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';

export function createToolSelectResolver(toolSelect: IAgentToolSelectService, dynamic = false): LlmResolver {
  return {
    id: 'tool-select',
    recoveryRequest: 'resolved',
    resolve: async (request, ctl) => {
      await toolSelect.prepareForRequest(ctl.signal);
      const capabilities =
        withProtocolCapabilities(request.model as never, request.protocol.base).capability ?? {};
      const disclosure = toolSelect.enabled(capabilities);
      const tools = toolSelect.requestTools(request.profile?.tools as never, disclosure as never, dynamic as never, request.content.messages as never);
      return {
        ...request,
        profile: {
          ...request.profile,
          tools,
        },
        content: {
          ...request.content,
          messages: toolSelect.shapeHistory(request.content.messages as never, disclosure, tools),
        },
      };
    },
  };
}
