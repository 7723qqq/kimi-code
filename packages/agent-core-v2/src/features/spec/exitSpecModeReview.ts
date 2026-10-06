import type {
  ApprovalResponse,
  PermissionPolicyResolution,
} from '#/agent/permissionPolicy/types';
import type { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import type { SpecResolvedEvent, SpecSubmittedEvent } from '#/app/telemetry/events';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

import type { IAgentSpecService } from './spec';

type SpecReviewDisplay = Extract<ToolInputDisplay, { kind: 'spec_review' }>;
type SpecReviewOption = NonNullable<SpecReviewDisplay['options']>[number];

export class ExitSpecModeReview {
  constructor(
    private readonly spec: IAgentSpecService,
    private readonly toolApproval: IAgentToolApprovalService,
    private readonly telemetry: ITelemetryService,
  ) {}

  async requestApproval(
    context: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined> {
    const display = context.execution.display;
    if (display?.kind !== 'spec_review') return undefined;
    if (display.documents.length === 0) return undefined;
    this.telemetry.track2('spec_submitted', {
      file_count: display.documents.length,
    } as SpecSubmittedEvent);
    return this.toolApproval.requestToolApproval(
      context,
      {
        kind: 'ask',
        reason: { has_options: display.options !== undefined },
        resolveApproval: (result) => this.approvalResult(result, display),
      },
      'exit-spec-mode-review-ask',
    );
  }

  private approvalResult(
    result: ApprovalResponse,
    display: SpecReviewDisplay,
  ): PermissionPolicyResolution | undefined {
    if (result.decision !== 'approved') {
      return this.rejectedApprovalResult(result);
    }

    const selected = selectedSpecOption(display.options, result.selectedLabel);
    this.spec.exit();

    this.telemetry.track2('spec_resolved', {
      outcome: 'approved',
    } as SpecResolvedEvent);

    const optionPrefix =
      selected === undefined
        ? ''
        : `Selected approach: ${selected.label}\nExecute ONLY the selected approach. Do not execute any unselected alternatives.\n\n`;
    return {
      kind: 'result',
      result: {
        isError: false,
        output: `Exited spec mode. ${optionPrefix}Spec saved to: ${display.dir}\n\nWork through ${display.dir}/tasks.md.`,
      },
    };
  }

  private rejectedApprovalResult(result: ApprovalResponse): PermissionPolicyResolution {
    this.trackRejected(result);

    if (result.decision === 'cancelled') {
      return {
        kind: 'result',
        result: {
          isError: false,
          output: 'Spec approval dismissed. Spec mode remains active.',
        },
      };
    }

    if (result.selectedLabel === 'Reject and Exit') {
      this.spec.exit();
      return {
        kind: 'result',
        result: {
          isError: true,
          stopTurn: true,
          output: 'Spec rejected by user. Spec mode deactivated.',
        },
      };
    }

    const feedback = result.feedback ?? '';
    if (result.selectedLabel === 'Revise' || feedback.length > 0) {
      return {
        kind: 'result',
        result: {
          isError: false,
          output:
            feedback.length > 0
              ? `User rejected the spec. Feedback:\n\n${feedback}`
              : 'User requested revisions. Spec mode remains active.',
        },
      };
    }

    return {
      kind: 'result',
      result: {
        isError: true,
        stopTurn: true,
        output: 'Spec rejected by user. Spec mode remains active.',
      },
    };
  }

  private trackRejected(result: ApprovalResponse): void {
    if (result.decision === 'cancelled') {
      this.telemetry.track2('spec_resolved', { outcome: 'dismissed' } as SpecResolvedEvent);
      return;
    }
    if (result.selectedLabel === 'Reject and Exit') {
      this.telemetry.track2('spec_resolved', {
        outcome: 'rejected_and_exited',
      } as SpecResolvedEvent);
      return;
    }
    const feedback = result.feedback ?? '';
    if (result.selectedLabel === 'Revise' || feedback.length > 0) {
      this.telemetry.track2('spec_resolved', {
        outcome: 'revise',
        has_feedback: feedback.length > 0,
      } as SpecResolvedEvent);
      return;
    }
    this.telemetry.track2('spec_resolved', { outcome: 'rejected' } as SpecResolvedEvent);
  }
}

function selectedSpecOption(
  options: readonly SpecReviewOption[] | undefined,
  label: string | undefined,
): SpecReviewOption | undefined {
  if (options === undefined || label === undefined) return undefined;
  return options.find((option) => option.label === label);
}
