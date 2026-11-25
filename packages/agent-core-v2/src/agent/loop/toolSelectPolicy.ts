import type { LlmResolver } from '@moonshot-ai/core/llm/policy/resolver';
import type { ToolDescription } from '@moonshot-ai/core/llm/message';
import { withProtocolCapabilities } from '@moonshot-ai/core/llm/protocol/rules/model';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';

function shapeToolSelectRequest(
  toolSelect: IAgentToolSelectService,
  base: readonly ToolDescription[] | undefined,
  messages: readonly ContextMessage[],
  disclosure: boolean,
): { readonly tools: readonly ToolDescription[]; readonly messages: readonly ContextMessage[] } {
  const deferred = disclosure
    ? (base ?? []).filter((tool) => tool.deferred === true)
    : undefined;
  const tools = toolSelect.requestTools(base as never, disclosure) as unknown as readonly ToolDescription[];
  return {
    tools,
    messages: toolSelect.shapeHistory(
      messages as never,
      disclosure,
      tools as never,
      deferred as never,
    ) as unknown as readonly ContextMessage[],
  };
}

export function createToolSelectResolver(toolSelect: IAgentToolSelectService): LlmResolver {
  return {
    id: 'tool-select',
    recoveryRequest: 'resolved',
    resolve: async (request, ctl): Promise<any> => {
      await toolSelect.prepareForRequest(ctl.signal);
      const capabilities =
        withProtocolCapabilities(request.model.spec, request.protocol.base).capability ?? {};
      const disclosure = toolSelect.enabled(capabilities);
      const view = shapeToolSelectRequest(
        toolSelect,
        request.profile?.tools,
        request.content.messages as never,
        disclosure,
      );
      return {
        ...request,
        profile: {
          ...request.profile,
          tools: view.tools,
        },
        content: {
          ...request.content,
          messages: view.messages,
        },
      };
    },
  };
}
