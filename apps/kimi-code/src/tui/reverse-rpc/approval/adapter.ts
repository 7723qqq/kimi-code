import type {
  ApprovalRequest,
  ApprovalResponse,
  ToolInputDisplay,
} from '@moonshot-ai/kimi-code-sdk';
import { ReviewDecision } from '@moonshot-ai/agent-core-v2';

import { t } from '#/i18n';
import type { ApprovalPanelResponse } from '#/tui/components/dialogs/approval-panel';
import { goalStartOptions } from '#/tui/components/dialogs/goal-start-permission-prompt';
import type { ApprovalPanelChoice, ApprovalPanelData, DisplayBlock } from '#/tui/reverse-rpc/types';

function getDefaultApprovalChoices(): ApprovalPanelChoice[] {
  return [
    { label: t('tui.approvalLabels.approveOnce'), response: 'approved' },
    { label: t('tui.approvalLabels.approveForSession'), response: 'approved_for_session' },
    { label: t('tui.approvalLabels.reject'), response: 'rejected' },
    {
      label: t('tui.approvalLabels.rejectWithFeedback'),
      response: 'rejected',
      requires_feedback: true,
    },
  ];
}

function getPlanRejectChoices(): ApprovalPanelChoice[] {
  return [
    {
      label: t('tui.approvalLabels.reject'),
      response: 'rejected',
      selected_label: ReviewDecision.REJECT,
    },
    {
      label: t('tui.approvalLabels.revise'),
      response: 'rejected',
      selected_label: ReviewDecision.REVISE,
      requires_feedback: true,
    },
  ];
}

export function adaptApprovalRequest(event: ApprovalRequest): ApprovalPanelData {
  const resolved = resolveDisplay(event.toolName, event.display, event.action);
  return {
    id: event.toolCallId,
    tool_call_id: event.toolCallId,
    tool_name: event.toolName,
    action: event.action,
    description: resolved.description,
    display: resolved.blocks,
    choices: adaptChoices(event.toolName, event.display),
  };
}

interface ResolvedDisplay {
  blocks: DisplayBlock[];
  description: string;
}

function resolveDisplay(
  toolName: string,
  display: ToolInputDisplay,
  action: string,
): ResolvedDisplay {
  if (display.kind === 'generic' && isRecord(display.detail)) {
    const extracted = extractFromArgs(toolName, display.detail);
    if (extracted !== null) return extracted;
  }
  return {
    blocks: adaptDisplay(display),
    description: describeApproval(display, action),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(detail: Record<string, unknown>, key: string): string | undefined {
  const value = detail[key];
  return typeof value === 'string' ? value : undefined;
}

function extractFromArgs(
  toolName: string,
  detail: Record<string, unknown>,
): ResolvedDisplay | null {
  // Only the builtin shell family gets shell styling and danger scanning.
  // The generic fallback carries raw args for every tool without its own
  // display, and MCP tools can legitimately own a `command` field — rendering
  // it as a shell command would mislead, so those fall through to the generic
  // previews below.
  const command = toolName === 'Bash' ? stringField(detail, 'command') : undefined;
  if (command !== undefined) {
    const cwd = stringField(detail, 'cwd');
    const toolDescription = stringField(detail, 'description');
    const danger = detectDanger(command);
    const language = stringField(detail, 'language') ?? 'bash';
    return {
      blocks: [
        {
          type: 'shell',
          language,
          command,
          cwd,
          description: toolDescription,
          danger,
        },
      ],
      description: toolDescription ?? '',
    };
  }

  const oldString = stringField(detail, 'old_string');
  const newString = stringField(detail, 'new_string');
  if (oldString !== undefined && newString !== undefined) {
    const path = stringField(detail, 'file_path') ?? stringField(detail, 'path') ?? '';
    // Diff block carries its own `+N -M path` header — no separate
    // file_op title row needed.
    return {
      blocks: [{ type: 'diff', path, old_text: oldString, new_text: newString }],
      description: '',
    };
  }

  const filePath = stringField(detail, 'file_path') ?? stringField(detail, 'path');
  const content = stringField(detail, 'content');
  if (filePath !== undefined && content !== undefined) {
    // Write is a brand-new file: render the content as a syntax-
    // highlighted code block, not a diff full of `+` markers.
    return {
      blocks: [{ type: 'file_content', path: filePath, content }],
      description: '',
    };
  }

  const url = stringField(detail, 'url');
  if (url !== undefined) {
    const method = stringField(detail, 'method');
    return {
      blocks: [{ type: 'url_fetch', url, method }],
      description: '',
    };
  }

  const query = stringField(detail, 'query');
  if (query !== undefined) {
    return {
      blocks: [{ type: 'search', query }],
      description: '',
    };
  }

  const pattern = stringField(detail, 'pattern');
  if (pattern !== undefined) {
    const scope = stringField(detail, 'path');
    return {
      blocks: [{ type: 'search', query: pattern, scope }],
      description: '',
    };
  }

  if (filePath !== undefined) {
    const operation = inferFileOp(toolName);
    return {
      blocks: [{ type: 'file_op', operation, path: filePath }],
      description: '',
    };
  }

  return null;
}

function inferFileOp(toolName: string): 'read' | 'write' | 'edit' | 'glob' | 'grep' {
  const lower = toolName.toLowerCase();
  if (lower.includes('glob')) return 'glob';
  if (lower.includes('grep')) return 'grep';
  if (lower.includes('edit')) return 'edit';
  if (lower.includes('write')) return 'write';
  return 'read';
}

export function adaptPanelResponse(response: ApprovalPanelResponse): ApprovalResponse {
  if (response.response === 'approved_for_session') {
    return {
      decision: 'approved',
      scope: 'session',
      feedback: response.feedback,
      selectedLabel: response.selected_label,
    };
  }
  return {
    decision:
      response.response === 'approved'
        ? 'approved'
        : response.response === 'rejected'
          ? 'rejected'
          : 'cancelled',
    feedback: response.feedback,
    selectedLabel: response.selected_label,
  };
}

function describeApproval(display: ToolInputDisplay, action: string): string {
  switch (display.kind) {
    case 'plan_review':
      return '';
    case 'spec_review':
      return '';
    case 'goal_start':
      return t('tui.approvalDescriptions.startGoal');
    case 'generic':
      if (typeof display.detail === 'string' && display.detail.length > 0) {
        return display.detail;
      }
      return display.summary ?? action;
    case 'command':
      return display.description ?? display.command ?? action;
    case 'diff':
      return t('tui.approvalDescriptions.editFile', { path: display.path ?? '' }).trim();
    case 'file_io':
      return t('tui.approvalDescriptions.fileOp', {
        operation: display.operation ?? 'file',
        path: display.path ?? '',
      }).trim();
    case 'task_stop':
      return t('tui.approvalDescriptions.stopTask', {
        description: display.task_description ?? display.task_id ?? '',
      }).trim();
    case 'agent_call':
      return t('tui.approvalDescriptions.spawnAgent', { name: display.agent_name ?? 'agent' });
    case 'skill_call':
      return t('tui.approvalDescriptions.invokeSkill', { name: display.skill_name ?? '' }).trim();
    case 'url_fetch':
      return t('tui.approvalDescriptions.fetchUrl', { url: display.url ?? '' }).trim();
    case 'search':
      return t('tui.approvalDescriptions.searchQuery', { query: display.query ?? '' }).trim();
    case 'todo_list':
      return t('tui.approvalDescriptions.updateTodoList', {
        count: String(display.items?.length ?? 0),
      });
    case 'task':
      return t('tui.approvalDescriptions.backgroundTask', {
        status: display.status ?? 'background',
        taskId: display.task_id ?? '',
        description: display.description ?? '',
      }).trim();
    default:
      return action;
  }
}

/**
 * Command shapes worth flagging in the approval panel.
 *
 * These are hints, not a security boundary — the panel asks the user to read the
 * command, and a determined evader defeats any regex. What each pattern buys is
 * that the *common* destructive spellings are named on screen instead of relying
 * on the reader to spot them.
 *
 * Two rules kept this list honest while it was extended. First, a pattern has to
 * be something the shell actually expands: an earlier version flagged
 * `$(curl …)` by looking for `curl` inside the substitution, which is just as
 * true of `$(which curl)` and would have made the label meaningless. It now
 * flags command substitution itself, which is the construct that hides a command
 * from the reader. Second, only irreversible or off-workspace effects qualify;
 * `git push --force` is recoverable through the reflog on the remote and is a
 * normal part of a force-push workflow, so it is deliberately absent.
 */
function getDangerPatterns(): Array<{ pattern: RegExp; label: string }> {
  return [
    {
      pattern: /\brm\s+(-[a-zA-Z]*[rRfF][a-zA-Z]*|--recursive|--force)/i,
      label: t('tui.dangerPatterns.recursiveDelete'),
    },
    { pattern: /\bsudo\b/i, label: t('tui.dangerPatterns.sudo') },
    {
      // `curl … | sh`, and the `bash -c "$(curl …)"` form that the pipe rule
      // cannot see because the shell never builds a literal pipe.
      pattern: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b|\b(ba|z|)sh\s+-c\s+["'][^"']*\$\(/i,
      label: t('tui.dangerPatterns.pipeToShell'),
    },
    {
      // Any command substitution at the start of a word: this is the construct
      // that lets a command run without appearing where the reader looks.
      pattern: /\$\([^)]*\)|`[^`]+`/,
      label: t('tui.dangerPatterns.commandSubstitution'),
    },
    { pattern: /\bdd\b[^|]*\bof=/i, label: t('tui.dangerPatterns.ddWrite') },
    { pattern: /\bmkfs\b/i, label: t('tui.dangerPatterns.mkfs') },
    { pattern: />\s*\/dev\/(sd|nvme|disk|hd)/i, label: t('tui.dangerPatterns.writeToRawDevice') },
    { pattern: /\bchmod\s+-R?\s*777\b/i, label: t('tui.dangerPatterns.chmod777') },
    { pattern: /:\(\)\s*\{\s*:\|:&\s*\}/i, label: t('tui.dangerPatterns.forkBomb') },
    // `find / -delete` and `xargs rm` delete a tree without ever spelling `rm -rf`.
    {
      pattern: /\bfind\b[^|]*\s-delete\b|\bxargs\b[^|]*\brm\s+-/i,
      label: t('tui.dangerPatterns.recursiveDelete'),
    },
    // `rsync --delete` mirrors a deletion onto the destination.
    {
      pattern: /\brsync\b[^|]*--delete/i,
      label: t('tui.dangerPatterns.recursiveDelete'),
    },
    // Writing to shell startup files or authorized_keys is persistence, not a
    // normal file write: it survives the session and runs on every future shell.
    {
      pattern: />\s*[^\s]*(\.(bashrc|zshrc|profile|bash_profile)|authorized_keys)/i,
      label: t('tui.dangerPatterns.massWriteToHome'),
    },
    // `git reset --hard` throws away uncommitted work with no recovery path.
    {
      pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*[fd])/i,
      label: t('tui.dangerPatterns.historyRewrite'),
    },
  ];
}

/**
 * Strip quoted and escaped regions before scanning.
 *
 * A pattern that matches inside a quoted literal is matching *data*, not a
 * command: `grep -r "rm -rf" docs/` searches for that string, and
 * `npm test -- --grep sudo` passes it to a filter. Both were reported as
 * dangerous before this ran, and both are ordinary things a coding agent does.
 *
 * The one quoted region that *is* a command is the argument of `sh -c`:
 * `bash -c 'curl … | sh'` runs what the quotes enclose. That argument is kept
 * (re-inserted unquoted) so the patterns underneath still see it, and its own
 * quotes are stripped on the way back through.
 */
function stripQuotedLiterals(command: string): string {
  const singleQuoted = /'(?:[^'\\]|\\.)*'/g;
  const withoutSingle = command.replaceAll(singleQuoted, ' ');
  const withoutDouble = withoutSingle.replaceAll(/"(?:[^"\\]|\\.)*"/g, (literal) => {
    // The shell does not expand `$(…)` inside single quotes, but it does inside
    // double quotes, so only the substitutions survive.
    const substitutions = literal.match(/\$\([^)]*\)|`[^`]*`/g);
    return substitutions === null ? ' ' : substitutions.join(' ');
  });

  // Re-inlay the body of any `sh -c '<script>'` so its commands stay visible.
  const shellScript = /\b(?:ba|z|)sh\s+-c\s+'((?:[^'\\]|\\.)*)'/gi;
  const bodies = [...command.matchAll(shellScript)].map((match) => match[1] ?? '');
  return bodies.length === 0 ? withoutDouble : `${withoutDouble} ${bodies.join(' ')}`;
}

/**
 * Whether a match is a command word rather than a flag value or a path segment.
 *
 * `sudo` is a real danger only when it begins a command, which in practice means
 * it follows the start of the line, a separator, or an option terminator. In
 * `npm test -- --grep sudo` it is the value of a grep filter.
 */
function appearsAsCommandWord(command: string, word: string): boolean {
  const asCommand = new RegExp(`(?:^|[;&|(\\n]|&&|\\|\\|)\\s*(?:\\S*/)?${word}\\b`, 'i');
  return asCommand.test(command);
}

function detectDanger(command: string): string | undefined {
  const scannable = stripQuotedLiterals(command);
  for (const { pattern, label } of getDangerPatterns()) {
    if (!pattern.test(scannable)) continue;
    // `sudo` is common enough as a bare word that the pattern alone is too
    // loose; every other pattern is specific enough to stand on its own.
    if (label === t('tui.dangerPatterns.sudo') && !appearsAsCommandWord(scannable, 'sudo')) {
      continue;
    }
    return label;
  }
  return undefined;
}

function adaptDisplay(display: ToolInputDisplay): DisplayBlock[] {
  switch (display.kind) {
    case 'command': {
      const command = display.command ?? '';
      const danger = detectDanger(command);
      return [
        {
          type: 'shell',
          language: display.language ?? 'bash',
          command,
          cwd: display.cwd,
          description: display.description,
          danger,
        },
      ];
    }
    case 'diff':
      return [
        {
          type: 'diff',
          path: display.path ?? '',
          old_text: display.before ?? '',
          new_text: display.after ?? '',
        },
      ];
    case 'file_io': {
      const path = display.path ?? '';
      // Write attaches the full file content — render it as a syntax-
      // highlighted code block so the approval panel can preview (and
      // ctrl+e expand) what is about to land on disk.
      if (display.operation === 'write' && typeof display.content === 'string') {
        return [{ type: 'file_content', path, content: display.content }];
      }
      // Edit attaches the old_string/new_string hunk as before/after — render
      // it as a diff block so ctrl+e expansion works on the change.
      if (
        display.operation === 'edit' &&
        typeof display.before === 'string' &&
        typeof display.after === 'string'
      ) {
        return [{ type: 'diff', path, old_text: display.before, new_text: display.after }];
      }
      return [
        {
          type: 'file_op',
          operation: display.operation,
          path,
          detail: display.detail,
        },
      ];
    }
    case 'url_fetch':
      return [
        {
          type: 'url_fetch',
          url: display.url ?? '',
          method: display.method,
        },
      ];
    case 'search':
      return [
        {
          type: 'search',
          query: display.query ?? '',
          scope: display.scope,
        },
      ];
    case 'agent_call':
      return [
        {
          type: 'invocation',
          kind: 'agent',
          name: display.agent_name ?? '',
          description: display.prompt,
        },
      ];
    case 'skill_call':
      return [
        {
          type: 'invocation',
          kind: 'skill',
          name: display.skill_name ?? '',
          description: display.args,
        },
      ];
    case 'task_stop':
      return [
        {
          type: 'brief',
          text: t('tui.approvalDescriptions.taskStopBrief', {
            taskId: display.task_id ?? '',
            description: display.task_description ?? '',
          }),
        },
      ];
    case 'plan_review':
      return [];
    case 'spec_review':
      return display.documents.map((document) => ({
        type: 'file_content' as const,
        path: document.name,
        content: document.content,
        language: 'markdown',
      }));
    case 'goal_start': {
      const lines = [
        t('tui.approvalDescriptions.goalStartBrief', { objective: display.objective }),
      ];
      if (
        typeof display.completionCriterion === 'string' &&
        display.completionCriterion.length > 0
      ) {
        lines.push(
          t('tui.approvalDescriptions.goalCompletionCriterion', {
            criterion: display.completionCriterion,
          }),
        );
      }
      return [{ type: 'brief', text: lines.join('\n') }];
    }
    case 'generic':
      return [];
    case 'todo_list':
      return [];
    case 'task':
      return [];
    default:
      return [];
  }
}

function adaptChoices(toolName: string, display: ToolInputDisplay): ApprovalPanelChoice[] {
  if (toolName === 'ExitPlanMode' || display.kind === 'plan_review') {
    return adaptPlanReviewChoices(display);
  }
  if (toolName === 'ExitSpecMode' || display.kind === 'spec_review') {
    return adaptSpecReviewChoices(display);
  }
  if (display.kind === 'goal_start') {
    return adaptGoalStartChoices(display);
  }

  return getDefaultApprovalChoices().map((choice) => cloneChoice(choice));
}

function adaptSpecReviewChoices(display: ToolInputDisplay): ApprovalPanelChoice[] {
  const optionChoices =
    display.kind === 'spec_review' && display.options !== undefined && display.options.length >= 2
      ? display.options.map((option) => ({
          label: option.label,
          response: 'approved' as const,
          selected_label: option.label,
          description: option.description,
        }))
      : [
          {
            label: t('tui.approvalLabels.approve'),
            response: 'approved' as const,
            selected_label: ReviewDecision.APPROVE,
          },
        ];
  return [...optionChoices, ...getPlanRejectChoices()].map((choice) => cloneChoice(choice));
}

function adaptGoalStartChoices(
  display: Extract<ToolInputDisplay, { kind: 'goal_start' }>,
): ApprovalPanelChoice[] {
  // Reuse the exact options the /goal start menu shows. Each mode option starts
  // the goal under that permission mode (the policy reads selected_label); "Do
  // not start" declines so no goal is created.
  return goalStartOptions(display.mode).map((option) =>
    option.value === 'cancel'
      ? {
          label: option.label,
          response: 'cancelled',
          selected_label: 'cancel',
          description: option.description,
        }
      : {
          label: option.label,
          response: 'approved',
          selected_label: option.value,
          description: option.description,
        },
  );
}

function adaptPlanReviewChoices(display: ToolInputDisplay): ApprovalPanelChoice[] {
  const optionChoices =
    display.kind === 'plan_review' && display.options !== undefined && display.options.length >= 2
      ? display.options.map((option) => ({
          label: option.label,
          response: 'approved' as const,
          selected_label: option.label,
          description: option.description,
        }))
      : [
          {
            label: t('tui.approvalLabels.approve'),
            response: 'approved' as const,
            selected_label: ReviewDecision.APPROVE,
          },
        ];
  return [...optionChoices, ...getPlanRejectChoices()].map((choice) => cloneChoice(choice));
}

function cloneChoice(choice: ApprovalPanelChoice): ApprovalPanelChoice {
  return { ...choice };
}
