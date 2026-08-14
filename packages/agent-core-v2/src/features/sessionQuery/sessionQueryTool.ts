/**
 * `sessionQuery` domain — the `session_query` agent tool.
 *
 * Model-facing wrapper over `ISessionQueryService`: cross-session full-text
 * search (scoped to the caller's workspace cwd), within-session event
 * search, and lineage tracing. Ported from deepseek-harness
 * `tool-session-query` (MIT), trimmed to the operations the query service
 * provides (upstream event-trace/event-read are deferred).
 *
 * Bound at Agent scope for the main agent only.
 */

import { toInputJsonSchema } from '#/tool/input-schema';
import { Error2 } from '#/errors';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { t } from '@moonshot-ai/kimi-i18n';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { ISessionQueryService } from './sessionQueryService';
import type { SessionResultFilter } from './types';
import {
  buildEventFilters,
  buildSessionFilters,
  eventSearchInputSchema,
  normalizeQuery,
  sessionSearchInputSchema,
  sessionTraceInputSchema,
  type EventSearchInput,
  type SessionSearchInput,
} from './toolInput';
import { formatEventSearch, formatSessionSearch, formatSessionTrace } from './toolPresentation';
import { ISessionQueryTool, SessionQueryToolInput } from './toolContract';
import DESCRIPTION from './session-query.md?raw';

const MAX_SEARCH_RESULTS = 20;

export class SessionQueryTool implements ISessionQueryTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'session_query' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SessionQueryToolInput);

  constructor(
    @ISessionQueryService private readonly query: ISessionQueryService,
    @ISessionContext private readonly session: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  resolveExecution(args: SessionQueryToolInput): ToolExecution {
    return {
      description: `Session query: ${args.operation}`,
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: SessionQueryToolInput,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    if (this.scopeContext.agentId !== 'main') {
      return { isError: true, output: t('toolsV2.sessionQuery.mainAgentOnly') };
    }
    try {
      switch (args.operation) {
        case 'session_search':
          return await this.sessionSearch(args.operationArgs ?? {});
        case 'event_search':
          return await this.eventSearch(args.operationArgs ?? {});
        case 'session_trace':
          return await this.sessionTrace(args.operationArgs ?? {});
        default:
          return { isError: true, output: t('toolsV2.sessionQuery.unknownOperation') };
      }
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      if (error instanceof Error2) {
        return { isError: true, output: error.message };
      }
      throw error;
    }
  }

  private async sessionSearch(rawArgs: unknown): Promise<ExecutableToolResult> {
    const parsed = sessionSearchInputSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return { isError: true, output: formatValidationError(parsed.error.message) };
    }
    const args = parsed.data as SessionSearchInput;
    const cwd = this.session.cwd;
    const query = normalizeQuery(args.query);
    const sessionFilters: SessionResultFilter[] = [
      ...buildSessionFilters(args),
      // The caller may only search its own workspace.
      { kind: 'cwd', values: [cwd ?? null] },
    ];
    const eventFilters = buildEventFilters({
      seqFrom: args.event_seq_from,
      seqTo: args.event_seq_to,
      timeFrom: args.event_time_from,
      timeTo: args.event_time_to,
      eventTypes: args.event_types,
    });
    const { items, nextCursor } = await this.query.searchSessions({
      query,
      sessionFilters,
      eventFilters,
      limit: MAX_SEARCH_RESULTS,
    });
    const capped = nextCursor !== undefined;
    return { isError: false, output: formatSessionSearch(items, capped) };
  }

  private async eventSearch(rawArgs: unknown): Promise<ExecutableToolResult> {
    const parsed = eventSearchInputSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return { isError: true, output: formatValidationError(parsed.error.message) };
    }
    const args = parsed.data as EventSearchInput;
    const sessionId = args.session_id ?? this.session.sessionId;
    const query = normalizeQuery(args.query);
    const filters = buildEventFilters({
      seqFrom: args.seq_from,
      seqTo: args.seq_to,
      timeFrom: args.time_from,
      timeTo: args.time_to,
      eventTypes: args.event_types,
    });
    const { items, nextCursor } = await this.query.searchEvents({
      sessionId,
      query,
      filters,
      limit: MAX_SEARCH_RESULTS,
    });
    const capped = nextCursor !== undefined;
    return { isError: false, output: formatEventSearch(sessionId, items, capped) };
  }

  private async sessionTrace(rawArgs: unknown): Promise<ExecutableToolResult> {
    const parsed = sessionTraceInputSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return { isError: true, output: formatValidationError(parsed.error.message) };
    }
    const sessionId =
      (parsed.data as { session_id?: string }).session_id ?? this.session.sessionId;
    const trace = await this.query.traceLineage(sessionId);
    return { isError: false, output: formatSessionTrace(trace) };
  }
}

function formatValidationError(message: string): string {
  return `Invalid arguments: ${message}`;
}

registerAgentToolService(ISessionQueryTool, SessionQueryTool, {
  name: 'session_query',
  domain: 'sessionQuery',
  when: (accessor) => accessor.get(IAgentScopeContext).agentId === 'main',
});
