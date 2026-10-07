import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { SpecSubmittedEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentSpecService, SPEC_REQUIRED_FILES, type SpecData } from '#/features/spec/spec';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ExecutableToolResult, ToolExecution } from '#/tool/toolContract';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

import type { IExitSpecModeTool } from './exit-spec-mode';
import { ExitSpecModeInputSchema, type ExitSpecModeInput } from './exit-spec-mode';
import DESCRIPTION from './exit-spec-mode.md?raw';

export class ExitSpecModeTool implements IExitSpecModeTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'ExitSpecMode' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ExitSpecModeInputSchema);

  constructor(
    @IAgentSpecService private readonly spec: IAgentSpecService,
    @IAgentPermissionModeService private readonly permissionMode: IAgentPermissionModeService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {}

  async resolveExecution(args: ExitSpecModeInput): Promise<ToolExecution> {
    return {
      description: 'Presenting spec and exiting spec mode',
      display: await this.resolveSpecReviewDisplay(args),
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private async resolveSpecReviewDisplay(
    args: ExitSpecModeInput,
  ): Promise<ToolInputDisplay | undefined> {
    let data: SpecData | null;
    try {
      data = await this.spec.status();
    } catch {
      return undefined;
    }
    if (data === null || !data.complete) return undefined;
    try {
      await this.spec.recordRevision(data);
    } catch {}
    const display: ToolInputDisplay = {
      kind: 'spec_review',
      dir: data.dir,
      documents: SPEC_REQUIRED_FILES.map((name) => ({
        name,
        content: data.files[name] ?? '',
      })),
    };
    if (args.options !== undefined && args.options.length >= 2) {
      display.options = args.options;
    }
    return display;
  }

  private async execution(_args: ExitSpecModeInput): Promise<ExecutableToolResult> {
    const status = await this.spec.status();
    if (status === null) {
      return {
        isError: true,
        output:
          'ExitSpecMode can only be called while spec mode is active. Use EnterSpecMode (or /spec) first.',
      };
    }

    if (!status.complete) {
      return {
        isError: true,
        output: `The spec is incomplete. Write ${status.missing.join(', ')} in ${status.dir} before calling ExitSpecMode.`,
      };
    }

    this.telemetry.track2('spec_submitted', {
      file_count: SPEC_REQUIRED_FILES.filter((name) => (status.files[name] ?? '').trim().length > 0)
        .length,
    } as SpecSubmittedEvent);

    const failed = this.exitSpecMode();
    if (failed !== undefined) return failed;

    if (this.permissionMode.mode === 'auto') {
      this.telemetry.track2('spec_resolved', { outcome: 'approved_without_review' });
      return {
        isError: false,
        output: `Exited spec mode. Spec saved to: ${status.dir} — work through ${status.dir}/tasks.md, recording progress in ${status.dir}/progress.md as you go.\nNote: this spec was auto-approved without user review — the user has NOT explicitly approved it. Follow the user's original instructions on whether to proceed with execution; if they asked you to stop, wait, or only summarize, do not start executing.`,
      };
    }

    this.telemetry.track2('spec_resolved', { outcome: 'approved' });
    return {
      isError: false,
      output: `Exited spec mode. Spec saved to: ${status.dir}\n\nWork through ${status.dir}/tasks.md, recording progress in ${status.dir}/progress.md as you go.`,
    };
  }

  private exitSpecMode(): ExecutableToolResult | undefined {
    try {
      this.spec.exit();
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to exit spec mode.';
      return { isError: true, output: `Failed to exit spec mode: ${message}` };
    }
  }
}
