/**
 * `knowledge` domain (L4) — Knowledge tool registration.
 *
 * Registers the `Knowledge` tool that lets the model actively interact
 * with the knowledge base: search, add, confirm, reject entries.
 * Only available to the main agent.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  AgentTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentKnowledgeService } from '../knowledge';

import TOOL_DESCRIPTION from './knowledge-tool.md?raw';

const KnowledgeInputSchema = z.object({
  action: z.enum(['search', 'add', 'confirm', 'reject']),
  query: z.string().optional(),
  scope: z.string().optional(),
  tags: z.string().optional(),
  id: z.string().optional(),
  title: z.string().optional(),
  category: z.enum(['coding-style', 'pitfall', 'architecture', 'workflow']).optional(),
  content: z.string().optional(),
});

type KnowledgeInput = z.infer<typeof KnowledgeInputSchema>;

export interface IKnowledgeTool extends AgentTool<KnowledgeInput> {
  readonly _serviceBrand: undefined;
}

export const IKnowledgeTool = createDecorator<IKnowledgeTool>('knowledgeTool');

export class KnowledgeTool implements IKnowledgeTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Knowledge' as const;
  readonly description: string = TOOL_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(KnowledgeInputSchema);

  constructor(@IAgentKnowledgeService private readonly knowledge: IAgentKnowledgeService) {}

  resolveExecution(input: KnowledgeInput): ToolExecution {
    return {
      description: `Knowledge: ${input.action}`,
      approvalRule: this.name,
      execute: async () => this.execute(input),
    };
  }

  private async execute(input: KnowledgeInput): Promise<ExecutableToolResult> {
    switch (input.action) {
      case 'search': {
        const query = input.query ?? '';
        const tags = input.tags?.split(',').filter(Boolean);
        const results = this.knowledge.search(query, input.scope, tags);
        if (results.length === 0) return { output: 'No matching knowledge entries found.' };
        return {
          output: results.map((r, i) =>
            `${i + 1}. [${r.entry.category}] ${r.entry.title} (confidence: ${r.entry.confidence})\n   ${r.entry.content.split('\n')[0]}`
          ).join('\n\n'),
        };
      }

      case 'add': {
        if (!input.title || !input.content || !input.category) {
          return { output: 'Error: title, content, and category are required for add action.', isError: true };
        }
        const entry = this.knowledge.add({
          title: input.title,
          category: input.category,
          content: input.content,
          tags: input.tags?.split(',').filter(Boolean),
          scope: input.scope,
          source: 'ai-learned',
          confidence: 0.7,
        });
        return {
          output: entry
            ? `Learned: [${entry.category}] ${entry.title} (id: ${entry.id}, confidence: 0.7)`
            : 'Failed to add knowledge entry.',
          isError: entry === null,
        };
      }

      case 'confirm': {
        if (!input.id) return { output: 'Error: id is required for confirm action.', isError: true };
        const ok = this.knowledge.confirm(input.id);
        return {
          output: ok ? `Confirmed entry ${input.id} (confidence → 1.0)` : `Entry ${input.id} not found.`,
          isError: !ok,
        };
      }

      case 'reject': {
        if (!input.id) return { output: 'Error: id is required for reject action.', isError: true };
        const ok = this.knowledge.remove(input.id);
        return {
          output: ok ? `Rejected and removed entry ${input.id}` : `Entry ${input.id} not found.`,
          isError: !ok,
        };
      }
    }
  }
}

registerAgentToolService(IKnowledgeTool, KnowledgeTool, {
  name: 'Knowledge',
  domain: 'knowledge',
  when: (accessor) => accessor.get(IAgentScopeContext).agentId === 'main',
});
