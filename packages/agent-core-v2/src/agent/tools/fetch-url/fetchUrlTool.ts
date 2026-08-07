/**
 * `tools` domain — `FetchURLTool` implementation.
 *
 * Receives the App-scope `IWebFetchService` via DI and resolves its
 * host-injected `UrlFetcher` per invocation — the service re-reads config and
 * login state on each `getUrlFetcher()` call, and composing the fetcher at
 * tool construction would both pin that state for the agent's lifetime and
 * race the identity freeze during a fast bootstrap. The default service falls
 * back to the built-in `LocalFetchURLProvider`, so `FetchURL` is always
 * available without OAuth. Bound at Agent scope; self-registers via
 * `registerAgentToolService(...)` at module load.
 */

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

import { IWebFetchService } from '#/app/web/web';
import { HttpFetchError } from '#/app/web/tools/fetch-url-types';
import { FetchURLInputSchema, IFetchURLTool, type FetchURLInput } from './fetch-url';
import { t } from '@moonshot-ai/kimi-i18n';
import DESCRIPTION from './fetch-url.md?raw';

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
      description: t('toolsV2.fetchUrl.fetching', { preview: preview }),
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
          output: t('toolsV2.fetchUrl.emptyBody'),
          isError: false,
        };
      }

      const builder = new ToolResultBuilder({ maxLineLength: null });
      const note =
        kind === 'passthrough'
          ? t('toolsV2.fetchUrl.passthroughNote')
          : t('toolsV2.fetchUrl.extractedNote');
      const citeReminder = t('toolsV2.fetchUrl.citeReminder');
      builder.write(`${note} ${citeReminder}\n\n${content}`);
      return builder.ok();
    } catch (error) {
      if (signal.aborted) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      if (error instanceof HttpFetchError) {
        return {
          isError: true,
          output: t('toolsV2.fetchUrl.failedHttp', { status: String(error.status), message: msg }),
        };
      }
      return {
        isError: true,
        output: t('toolsV2.fetchUrl.networkError', { url: args.url, message: msg }),
      };
    }
  }
}

registerAgentToolService(IFetchURLTool, FetchURLTool, { name: 'FetchURL', domain: 'web' });
