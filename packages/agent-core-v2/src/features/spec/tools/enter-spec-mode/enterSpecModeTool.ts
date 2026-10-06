import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentSpecService, SPEC_REQUIRED_FILES } from '#/features/spec/spec';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import type { IEnterSpecModeTool } from './enter-spec-mode';
import { EnterSpecModeInputSchema, type EnterSpecModeInput } from './enter-spec-mode';
import DESCRIPTION from './enter-spec-mode.md?raw';

export class EnterSpecModeTool implements IEnterSpecModeTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'EnterSpecMode' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(EnterSpecModeInputSchema);

  constructor(
    @IAgentSpecService private readonly spec: IAgentSpecService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {}

  resolveExecution(_args: EnterSpecModeInput): ToolExecution {
    return {
      description: 'Requesting to enter spec mode',
      approvalRule: this.name,
      execute: async () => {
        const before = await this.spec.status();
        if (before !== null) {
          return {
            isError: true,
            output: 'Spec mode is already active. Use ExitSpecMode when the spec is ready.',
          };
        }

        try {
          await this.spec.enter();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to enter spec mode.';
          return { isError: true, output: `Failed to enter spec mode: ${message}` };
        }

        this.telemetry.track2('spec_enter_resolved', { outcome: 'accepted' });
        const after = await this.spec.status();
        return { output: enteredSpecModeMessage(after?.dir ?? null) };
      },
    };
  }
}

function enteredSpecModeMessage(specDir: string | null): string {
  if (specDir === null) {
    return [
      'Spec mode is now active.',
      '',
      'Write the requirements, design and tasks documents, then call ExitSpecMode for approval.',
      'No spec directory path is available in this host, so writes cannot be authorised.',
    ].join('\n');
  }

  return [
    'Spec mode is now active. Your workflow:',
    '',
    `Spec directory: ${specDir}`,
    '',
    '1. Investigate with read-only tools (Read, Grep, Glob). Use Bash only when needed.',
    '2. Write the requirements document — what to build, and what is out of scope.',
    '3. Write the design document — how to build it, and which alternatives you rejected.',
    '4. Write the tasks document — each task with acceptance criteria that can be checked.',
    '5. Call ExitSpecMode for approval.',
    '',
    `Only these files may be written: ${SPEC_REQUIRED_FILES.join(', ')}.`,
    'Every other write is rejected until the user approves the spec.',
  ].join('\n');
}
