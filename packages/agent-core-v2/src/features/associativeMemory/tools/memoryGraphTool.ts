import { t } from '@moonshot-ai/kimi-i18n';
import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IFlagService } from '#/app/flag/flag';
import { toInputJsonSchema } from '#/tool/input-schema';
import {
  RepoMutations,
  type AgentTool,
  type ToolExecution,
  ToolSideEffects,
} from '#/tool/toolContract';

import { ASSOCIATIVE_MEMORY_FLAG_ID } from '../flag';
import { ASSOCIATIVE_MEMORY_PARAMS } from '../params';
import { IAssociativeMemoryService } from '../service';

import DESCRIPTION from './memoryGraph.md?raw';

export const MEMORY_GRAPH_TOOL_NAME = 'MemoryGraph';

export const MemoryGraphInputSchema = z
  .object({
    action: z
      .enum([
        'write',
        'recall',
        'pin',
        'forget',
        'list',
        'export',
        'replay',
        'propose',
        'approve',
        'label',
        'reconsolidate',
        'audit',
        'stats',
        'explain',
        'rebuild',
      ])
      .describe('The memory graph operation to perform.'),
    text: z.string().optional().describe('Note text (for `write`).'),
    query: z.string().optional().describe('Search cue (for `recall`).'),
    id: z.string().optional().describe('Atom or concept id (for `pin`, `forget`).'),
    kind: z.enum(['atom', 'concept', 'procedure']).optional().describe('Which kind to list (for `list`).'),
    rule: z.string().optional().describe('A JSON rule object (for `propose`).'),
    index: z.number().optional().describe('Proposal index to approve (for `approve`).'),
    label: z.string().optional().describe('Human-readable label (for `label`).'),
    scope: z
      .enum(['project', 'global', 'all'])
      .optional()
      .describe('Which memory scope to use. Defaults to `project` for writes, `all` for reads.'),
    limit: z.number().optional().describe('Maximum results (for `recall`, `list`).'),
  })
  .strict();

export type MemoryGraphInput = z.infer<typeof MemoryGraphInputSchema>;

export interface IMemoryGraphTool extends AgentTool<MemoryGraphInput> {
  readonly _serviceBrand: undefined;
}

export const IMemoryGraphTool = createDecorator<IMemoryGraphTool>('memoryGraphTool');

export class MemoryGraphTool implements IMemoryGraphTool {
  declare readonly _serviceBrand: undefined;
  readonly name = MEMORY_GRAPH_TOOL_NAME;
  readonly sideEffect = ToolSideEffects.write;
  readonly repoMutation = RepoMutations.none;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MemoryGraphInputSchema);

  constructor(
    @IAssociativeMemoryService private readonly memory: IAssociativeMemoryService,
  ) {}

  resolveExecution(args: MemoryGraphInput): ToolExecution {
    return {
      description: t('toolsV2.memoryGraph.action', { action: args.action }),
      approvalRule: this.name,
      execute: async () => {
        switch (args.action) {
          case 'write':
            return this.handleWrite(args);
          case 'recall':
            return this.handleRecall(args);
          case 'pin':
            return this.handlePin(args);
          case 'forget':
            return this.handleForget(args);
          case 'list':
            return this.handleList(args);
          case 'export':
            return this.handleExport(args);
          case 'replay':
            return this.handleReplay(args);
          case 'propose':
            return this.handlePropose(args);
          case 'approve':
            return this.handleApprove(args);
          case 'label':
            return this.handleLabel(args);
          case 'reconsolidate':
            return this.handleReconsolidate(args);
          case 'audit':
            return this.handleAudit(args);
          case 'stats':
            return this.handleStats(args);
          case 'explain':
            return this.handleExplain(args);
          case 'rebuild':
            return this.handleRebuild(args);
          default:
            return {
              output: t('toolsV2.memoryGraph.unknownAction', { action: args.action }),
              isError: true,
            };
        }
      },
    };
  }

  private async handleWrite(args: MemoryGraphInput) {
    if (args.text === undefined || args.text.trim().length === 0) {
      return { output: t('toolsV2.memoryGraph.writeRequired'), isError: true };
    }
    if (args.scope === 'all') {
      return { output: t('toolsV2.memoryGraph.scopeAllNotWritable'), isError: true };
    }
    const result = await this.memory.writeNote(
      args.text,
      args.scope === 'global' ? 'global' : 'project',
      'tool',
    );
    if (result.blockedByCode) return { output: t('toolsV2.memoryGraph.blockedByCode') };
    if (result.decision === 'noop') {
      return { output: t('toolsV2.memoryGraph.alreadyRecorded') };
    }
    return { output: t('toolsV2.memoryGraph.wrote', { count: String(result.atomIds.length) }) };
  }

  private async handleRecall(args: MemoryGraphInput) {
    if (args.query === undefined || args.query.trim().length === 0) {
      return { output: t('toolsV2.memoryGraph.queryRequired'), isError: true };
    }
    const result = await this.memory.recall({
      cue: args.query,
      limit: args.limit,
      maxTokens: ASSOCIATIVE_MEMORY_PARAMS.injectionMaxTokens,
      includeHistory: false,
      scope: args.scope,
      reinforce: true,
    });
    if (result.items.length === 0) {
      return { output: t('toolsV2.memoryGraph.noResults') };
    }
    const lines = result.items.map(
      (item) => `- ${item.text} (${item.score.toFixed(3)}) [${item.id}]`,
    );
    return { output: lines.join('\n') };
  }

  private async handlePin(args: MemoryGraphInput) {
    if (args.id === undefined) return { output: t('toolsV2.memoryGraph.idRequired'), isError: true };
    await this.memory.pin(args.id);
    return { output: t('toolsV2.memoryGraph.pinned') };
  }

  private async handleForget(args: MemoryGraphInput) {
    if (args.id === undefined) return { output: t('toolsV2.memoryGraph.idRequired'), isError: true };
    await this.memory.forget(args.id);
    return { output: t('toolsV2.memoryGraph.forgot') };
  }

  private async handleReplay(args: MemoryGraphInput) {
    const result = await this.memory.replay(args.limit ?? 10);
    return { output: t('toolsV2.memoryGraph.replayed', { count: String(result.replayed) }) };
  }

  private async handlePropose(args: MemoryGraphInput) {
    if (args.rule === undefined) {
      return { output: t('toolsV2.memoryGraph.ruleRequired'), isError: true };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(args.rule) as unknown;
    } catch {
      return { output: t('toolsV2.memoryGraph.invalidRule'), isError: true };
    }
    await this.memory.proposeRule(parsed);
    return { output: t('toolsV2.memoryGraph.proposed') };
  }

  private async handleReconsolidate(args: MemoryGraphInput) {
    if (args.text === undefined || args.text.trim().length === 0) {
      return { output: t('toolsV2.memoryGraph.reconsolidateTextRequired'), isError: true };
    }
    const result = await this.memory.reconsolidate(args.id, args.text);
    return {
      output: t('toolsV2.memoryGraph.reconsolidated', {
        count: String(result.atomIds.length),
        superseded: result.superseded ? 'yes' : 'no',
      }),
    };
  }

  private async handleAudit(args: MemoryGraphInput) {
    const entries = await this.memory.audit(args.limit ?? 20);
    if (entries.length === 0) return { output: t('toolsV2.memoryGraph.noAuditEntries') };
    const lines = entries.map(
      (entry) => `${new Date(entry.at).toISOString()} ${entry.kind} ${JSON.stringify(entry.detail)}`,
    );
    return { output: lines.join('\n') };
  }

  private async handleStats(args: MemoryGraphInput) {
    const stats = await this.memory.stats(args.scope);
    return {
      output: t('toolsV2.memoryGraph.statsLine', {
        atoms: String(stats.atoms),
        concepts: String(stats.concepts),
        procedures: String(stats.procedures),
        edges: String(stats.edges),
        notes: String(stats.notes),
        pinned: String(stats.pinned),
        suppressed: String(stats.suppressed),
      }),
    };
  }

  private async handleExplain(args: MemoryGraphInput) {
    if (args.query === undefined || args.query.trim().length === 0) {
      return { output: t('toolsV2.memoryGraph.queryRequired'), isError: true };
    }
    const explained = await this.memory.explain({
      cue: args.query,
      limit: undefined,
      maxTokens: undefined,
      includeHistory: false,
      scope: args.scope,
      reinforce: true,
    });
    if (explained.trace.length === 0 && explained.dropped.length === 0) {
      return { output: t('toolsV2.memoryGraph.noTrace') };
    }
    const lines = explained.trace.map(
      (node) => `${node.kind} ${node.id} ${node.score.toFixed(3)}`,
    );
    for (const drop of explained.dropped) {
      lines.push(`- dropped ${drop.id} by rule ${drop.rule}`);
    }
    return { output: lines.join('\n') };
  }

  private async handleRebuild(args: MemoryGraphInput) {
    await this.memory.rebuild(args.scope ?? 'all');
    return { output: t('toolsV2.memoryGraph.rebuilt') };
  }

  private async handleLabel(args: MemoryGraphInput) {
    if (args.id === undefined || args.label === undefined) {
      return { output: t('toolsV2.memoryGraph.labelRequired'), isError: true };
    }
    await this.memory.labelConcept(args.id, args.label);
    return { output: t('toolsV2.memoryGraph.labeled') };
  }

  private async handleApprove(args: MemoryGraphInput) {
    if (args.index === undefined) {
      return { output: t('toolsV2.memoryGraph.indexRequired'), isError: true };
    }
    try {
      await this.memory.approveProposal(args.index);
      return { output: t('toolsV2.memoryGraph.approved') };
    } catch {
      return { output: t('toolsV2.memoryGraph.approveFailed'), isError: true };
    }
  }

  private async handleExport(args: MemoryGraphInput) {
    const result = await this.memory.export(args.scope);
    if (result.path.length === 0) return { output: t('toolsV2.memoryGraph.noMemories') };
    return {
      output: t('toolsV2.memoryGraph.exported', {
        path: result.path,
        atoms: String(result.atoms),
        concepts: String(result.concepts),
        notes: String(result.notes),
      }),
    };
  }

  private async handleList(args: MemoryGraphInput) {
    const result = await this.memory.list({ kind: args.kind, limit: args.limit, scope: args.scope });
    if (result.atoms.length === 0 && result.concepts.length === 0 && result.procedures.length === 0) {
      return { output: t('toolsV2.memoryGraph.noMemories') };
    }
    const lines: string[] = [];
    if (result.atoms.length > 0) {
      lines.push(
        t('toolsV2.memoryGraph.listAtomsHeader', { count: String(result.atoms.length) }),
      );
      for (const atom of result.atoms) lines.push(`- [${atom.id}] ${atom.text}`);
    }
    if (result.concepts.length > 0) {
      lines.push(
        t('toolsV2.memoryGraph.listConceptsHeader', { count: String(result.concepts.length) }),
      );
      for (const concept of result.concepts) lines.push(`- [${concept.id}] ${concept.label}`);
    }
    if (result.procedures.length > 0) {
      lines.push(
        t('toolsV2.memoryGraph.listProceduresHeader', { count: String(result.procedures.length) }),
      );
      for (const procedure of result.procedures) {
        lines.push(`- [${procedure.id}] ${procedure.label}`);
      }
    }
    return { output: lines.join('\n') };
  }
}

registerAgentToolService(IMemoryGraphTool, MemoryGraphTool, {
  name: MEMORY_GRAPH_TOOL_NAME,
  domain: 'associativeMemory',
  when: (accessor) => accessor.get(IFlagService).enabled(ASSOCIATIVE_MEMORY_FLAG_ID),
});
