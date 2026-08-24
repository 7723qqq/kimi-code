import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '#/tool/rule-match';
import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { ToolResultBuilder } from '#/tool/result-builder';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { isProxyConfigured } from '#/_base/utils/proxy';

import { IWebFetchService } from '#/app/web/web';
import { HttpFetchError } from '#/app/web/tools/fetch-url-types';
import { FetchURLInputSchema, IFetchURLTool, type FetchURLInput } from './fetch-url';
import DESCRIPTION from './fetch-url.md?raw';

/**
 * Built-in web-fetching tool whose network errors stay diagnosable from the
 * output alone: undici reports every transport failure as a bare
 * `TypeError: fetch failed`, with the actionable detail (DNS, connect
 * timeout, TLS, reset) on the `cause` chain, which is flattened into the
 * returned error text.
 */
export class FetchURLTool implements IFetchURLTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'FetchURL' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(FetchURLInputSchema);

  constructor(@IWebFetchService private readonly webFetch: IWebFetchService) {}

  resolveExecution(args: FetchURLInput): ToolExecution {
    const preview = args.url.length > 50 ? `${args.url.slice(0, 50)}…` : args.url;
    return {
      accesses: ToolAccesses.none(),
      description: `Fetching: ${preview}`,
      display: { kind: 'url_fetch', url: args.url },
      approvalRule: literalRulePattern(this.name, args.url),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.url),
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: FetchURLInput,
    { toolCallId, signal }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const { content, kind } = await this.webFetch
        .getUrlFetcher()
        .fetch(args.url, { toolCallId, signal });

      if (!content) {
        return {
          output: 'The response body is empty.',
          isError: false,
        };
      }

      const builder = new ToolResultBuilder({ maxLineLength: null });
      const note =
        kind === 'passthrough'
          ? 'The returned content is the full response body, returned verbatim.'
          : 'The returned content is the main text extracted from the page.';
      const citeReminder =
        'If you use it in your answer, cite this page as a markdown link, e.g. [title](url).';
      builder.write(`${note} ${citeReminder}\n\n${content}`);
      return builder.ok();
    } catch (error) {
      if (signal.aborted) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      if (error instanceof HttpFetchError) {
        return {
          isError: true,
          output: `Failed to fetch URL. Status: ${String(error.status)}. ${msg}`,
        };
      }
      const causeText = describeErrorCause(error);
      const proxyHint = isProxyConfigured(process.env)
        ? ''
        : ' No HTTP(S)_PROXY is configured on this machine; if the site is unreachable by direct connection, set one and restart.';
      return {
        isError: true,
        output: `Failed to fetch URL due to network error: ${args.url}. ${msg}${causeText}${proxyHint}`,
      };
    }
  }
}

function describeErrorCause(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current === null || typeof current !== 'object') break;
    const candidate = current as { cause?: unknown };
    current = candidate.cause;
    if (current === undefined || current === null) break;
    if (current instanceof Error) {
      const code = (current as NodeJS.ErrnoException).code;
      parts.push(code === undefined ? current.message : `${current.message} (${String(code)})`);
    } else if (typeof current === 'string') {
      parts.push(current);
    } else {
      parts.push(JSON.stringify(current));
    }
  }
  return parts.length > 0 ? ` Cause: ${parts.join(' <- ')}.` : '';
}

registerAgentToolService(IFetchURLTool, FetchURLTool, { name: 'FetchURL', domain: 'web' });
