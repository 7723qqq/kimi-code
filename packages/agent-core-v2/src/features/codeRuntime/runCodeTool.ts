import { t } from '@moonshot-ai/kimi-i18n';

import { IConfigService } from '#/app/config/config';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  ExecutableToolContext,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';
import { resolveSandboxPolicy } from '#/workspace/sandbox/sandbox';

import { runCodeInWorker } from './codeExecutor';
import type { IRunCodeTool } from './codeRuntime';
import { RunCodeInputSchema, type RunCodeInput } from './codeRuntime';
import DESCRIPTION from './tools/run_code/run_code.md?raw';

export class RunCodeTool implements IRunCodeTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'run_code' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown>;

  constructor(@IConfigService private readonly config: IConfigService) {
    this.description = DESCRIPTION;
    this.parameters = toInputJsonSchema(RunCodeInputSchema);
  }

  resolveExecution(args: RunCodeInput): ToolExecution {
    return {
      description: 'Running code in an isolated worker thread',
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private inputSchema(): typeof RunCodeInputSchema {
    return RunCodeInputSchema;
  }

  private async execution(
    args: RunCodeInput,
    { signal }: Pick<ExecutableToolContext, 'signal'>,
  ): Promise<ExecutableToolResult> {
    const policy = resolveSandboxPolicy(this.config, process.cwd());
    if (policy.mode !== 'off') {
      return {
        isError: true,
        output: t('toolsV2.sandbox.codeExecutionBlocked', { mode: policy.mode }),
      };
    }

    const outcome = await runCodeInWorker(args.code, {
      timeoutMs: args.timeout_ms,
      signal,
    });

    const parts: string[] = [];
    if (outcome.error !== undefined) {
      parts.push(`error (${outcome.error.kind}): ${outcome.error.message}`);
    } else {
      parts.push(
        outcome.value === undefined
          ? 'value: undefined'
          : `value: ${JSON.stringify(outcome.value)}`,
      );
    }
    if (outcome.logs.length > 0) {
      parts.push(`logs:\n${outcome.logs.join('\n')}`);
    }
    return {
      isError: outcome.error !== undefined,
      output: parts.join('\n'),
    };
  }
}
