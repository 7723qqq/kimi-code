import type { PermissionMode, SessionStatus } from '@moonshot-ai/kimi-code-sdk';
import { truncateToWidth, visibleWidth, type Component } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { currentTheme } from '#/tui/theme';

import {
  HelloWorldStartPermissionPromptComponent,
  type HelloWorldStartPermissionChoice,
} from '../components/dialogs/hello-world-start-permission-prompt';
import {
  HelloWorldModeMarkerComponent,
  type HelloWorldModeMarkerState,
} from '../components/messages/hello-world-markers';
import { UsagePanelComponent } from '../components/messages/usage-panel';
import { getLlmNotSetMessage, getNoActiveSessionMessage } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import { permissionModeDescription, permissionModeDisplayName } from '../utils/permission-mode';
import { nextTranscriptId } from '../utils/transcript-id';
import type { SlashCommandHost } from './dispatch';

/** Protocol stage ids (never localized); shown to the user lowercase as-is. */
export const HELLO_WORLD_STAGES = [
  'requirements',
  'design',
  'implement',
  'test',
  'review',
  'docs',
  'deliver',
] as const;
export type HelloWorldStageId = (typeof HELLO_WORLD_STAGES)[number];

/** Protocol checklist item ids (never localized). */
export const HELLO_WORLD_RUN_ITEMS = [
  'requirements-approved',
  'design-written',
  'tasks-complete',
  'tests-green',
  'review-done',
  'docs-updated',
  'changeset-ready',
] as const;
export type HelloWorldRunItemId = (typeof HELLO_WORLD_RUN_ITEMS)[number];

type HelloWorldRunStatus = NonNullable<SessionStatus['helloWorldRun']>;

function isHelloWorldStage(value: string): value is HelloWorldStageId {
  return (HELLO_WORLD_STAGES as readonly string[]).includes(value);
}

function isHelloWorldRunItem(value: string): value is HelloWorldRunItemId {
  return (HELLO_WORLD_RUN_ITEMS as readonly string[]).includes(value);
}

export async function handleHelloWorldCommand(host: SlashCommandHost, args: string): Promise<void> {
  if (host.session === undefined) {
    host.showError(getNoActiveSessionMessage());
    return;
  }

  const prompt = args.trim();
  const mode = helloWorldModeSubcommand(prompt);
  if (mode !== undefined) {
    await applyHelloWorldMode(host, mode, `/hello-world ${prompt}`);
    return;
  }

  if (prompt.length === 0) {
    await applyHelloWorldMode(host, !host.state.appState.helloWorldMode, '/hello-world');
    return;
  }

  const runSubcommand = helloWorldRunSubcommand(prompt);
  if (runSubcommand !== undefined) {
    await handleHelloWorldRunSubcommand(host, runSubcommand);
    return;
  }

  if (host.state.appState.model.trim().length === 0) {
    host.showError(getLlmNotSetMessage());
    return;
  }

  if (host.state.appState.permissionMode === 'manual') {
    showHelloWorldStartPermissionPrompt(
      host,
      `/hello-world ${prompt}`,
      t('tui.statusMessages.helloWorldTaskNotStarted'),
      (choice) => startHelloWorldWithPermission(host, prompt, choice),
    );
    return;
  }

  await startHelloWorldTask(host, prompt);
}

function showHelloWorldStartPermissionPrompt(
  host: SlashCommandHost,
  commandText: string,
  cancelStatus: string,
  onSelect: (choice: HelloWorldStartPermissionChoice) => Promise<void>,
): void {
  const cancelStart = (): void => {
    host.restoreInputText(commandText);
    host.showStatus(cancelStatus);
  };
  host.mountEditorReplacement(
    new HelloWorldStartPermissionPromptComponent({
      onSelect: (choice) => {
        host.restoreEditor();
        void onSelect(choice);
      },
      onCancel: cancelStart,
    }),
  );
}

async function startHelloWorldWithPermission(
  host: SlashCommandHost,
  prompt: string,
  choice: HelloWorldStartPermissionChoice,
): Promise<void> {
  const previousMode = host.state.appState.permissionMode;
  const switched = choice !== previousMode && (choice === 'auto' || choice === 'yolo');
  if (switched) {
    if (!(await setPermissionForHelloWorld(host, choice))) return;
  }
  const started = await startHelloWorldTask(host, prompt);
  // The permission switch only exists to run this hello-world task. If the
  // task never starts (e.g. setHelloWorldMode failed), restore the previous
  // mode so the session is not left more permissive than before.
  if (!started && switched) {
    await setPermissionForHelloWorld(host, previousMode);
  }
}

async function setPermissionForHelloWorld(
  host: SlashCommandHost,
  mode: PermissionMode,
): Promise<boolean> {
  try {
    await host.requireSession().setPermission(mode);
  } catch (error) {
    host.showError(
      t('tui.messages.helloWorldPermissionFailed', { error: formatErrorMessage(error) }),
    );
    return false;
  }
  host.setAppState({ permissionMode: mode });
  host.showNotice(
    t('tui.statusMessages.permissionModeChanged', { mode: permissionModeDisplayName(mode) }),
  );
  host.showStatus(permissionModeDescription(mode), 'warning');
  return true;
}

async function startHelloWorldTask(host: SlashCommandHost, prompt: string): Promise<boolean> {
  if (
    !host.state.appState.helloWorldMode &&
    !(await setHelloWorldMode(host, true, 'task', prompt))
  ) {
    return false;
  }
  renderHelloWorldModeMarker(host, 'active');
  host.sendNormalUserInput(prompt);
  return true;
}

async function applyHelloWorldMode(
  host: SlashCommandHost,
  enabled: boolean,
  commandText: string,
): Promise<void> {
  if (enabled && host.state.appState.helloWorldMode) {
    host.showStatus(t('tui.statusMessages.helloWorldModeAlreadyOn'));
    return;
  }
  if (!enabled && !host.state.appState.helloWorldMode) {
    host.showStatus(t('tui.statusMessages.helloWorldModeAlreadyOff'));
    return;
  }
  if (enabled && host.state.appState.permissionMode === 'manual') {
    showHelloWorldStartPermissionPrompt(
      host,
      commandText,
      t('tui.statusMessages.helloWorldModeNotEnabled'),
      async (choice) => {
        if (
          (choice === 'auto' || choice === 'yolo') &&
          !(await setPermissionForHelloWorld(host, choice))
        ) {
          return;
        }
        if (!(await setHelloWorldMode(host, true, 'manual'))) return;
        renderHelloWorldModeMarker(host, 'active');
      },
    );
    return;
  }
  if (!enabled) await warnOpenHelloWorldItems(host);
  if (!(await setHelloWorldMode(host, enabled, 'manual'))) return;
  renderHelloWorldModeMarker(host, enabled ? 'active' : 'inactive');
}

async function setHelloWorldMode(
  host: SlashCommandHost,
  enabled: boolean,
  trigger: 'manual' | 'task',
  task?: string,
): Promise<boolean> {
  const session = host.requireSession();
  try {
    await session.setHelloWorldMode(enabled, trigger, task);
    // The engine may refuse (a conflicting mode it cannot leave), so confirm
    // the mode actually took before reporting success, like `/tower` does. The
    // read must not *gate* the state write: a failed read is not evidence of
    // success, and reconciling to a value we could not read would strand the
    // UI on a mode the engine may already have left.
    const status = await session.getStatus().catch(() => null);
    // Only a *reported* disagreement is evidence the engine refused. A missing
    // field means this view does not carry the flag, not that the mode is off.
    const reported = status?.helloWorldMode;
    if (reported !== undefined && reported !== enabled) {
      host.setAppState({ helloWorldMode: reported });
      host.state.helloWorldModeEntry = reported ? trigger : undefined;
      host.showError(
        t('tui.messages.helloWorldToggleFailed', {
          action: enabled
            ? t('tui.messages.helloWorldEnable')
            : t('tui.messages.helloWorldDisable'),
          error: t('tui.messages.helloWorldModeDidNotChange'),
        }),
      );
      return false;
    }
  } catch (error) {
    host.showError(
      t('tui.messages.helloWorldToggleFailed', {
        action: enabled ? t('tui.messages.helloWorldEnable') : t('tui.messages.helloWorldDisable'),
        error: formatErrorMessage(error),
      }),
    );
    return false;
  }
  host.setAppState({ helloWorldMode: enabled });
  host.state.helloWorldModeEntry = enabled ? trigger : undefined;
  return true;
}

function helloWorldModeSubcommand(input: string): boolean | undefined {
  const command = input.toLowerCase();
  if (command === 'on') return true;
  if (command === 'off') return false;
  return undefined;
}

function renderHelloWorldModeMarker(host: SlashCommandHost, state: HelloWorldModeMarkerState): void {
  host.appendTranscriptEntry(
    {
      id: nextTranscriptId(),
      kind: 'status',
      turnId: undefined,
      renderMode: 'plain',
      content: state,
    },
    new HelloWorldModeMarkerComponent(state),
  );
}

type HelloWorldRunSubcommand =
  | { kind: 'status' }
  | { kind: 'next' }
  | { kind: 'phase'; arg: string | undefined }
  | { kind: 'skip'; arg: string | undefined };

function helloWorldRunSubcommand(input: string): HelloWorldRunSubcommand | undefined {
  const command = input.toLowerCase();
  if (command === 'status') return { kind: 'status' };
  if (command === 'next') return { kind: 'next' };
  const phase = /^phase(?:\s+([\s\S]*))?$/i.exec(input);
  if (phase !== null) return { kind: 'phase', arg: phase[1] };
  const skip = /^skip(?:\s+([\s\S]*))?$/i.exec(input);
  if (skip !== null) return { kind: 'skip', arg: skip[1] };
  return undefined;
}

function protocolName(raw: string | undefined): string | undefined {
  const normalized = raw?.trim().toLowerCase();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

async function handleHelloWorldRunSubcommand(
  host: SlashCommandHost,
  subcommand: HelloWorldRunSubcommand,
): Promise<void> {
  switch (subcommand.kind) {
    case 'status':
      await showHelloWorldRunStatus(host);
      return;
    case 'next':
      await advanceHelloWorldStage(host, 'next');
      return;
    case 'phase': {
      const stage = protocolName(subcommand.arg);
      if (stage === undefined) {
        host.showError(t('tui.statusMessages.helloWorldPhaseUsage'));
        return;
      }
      if (!isHelloWorldStage(stage)) {
        host.showError(
          t('tui.statusMessages.helloWorldInvalidStage', {
            stage,
            stages: HELLO_WORLD_STAGES.join(', '),
          }),
        );
        return;
      }
      await advanceHelloWorldStage(host, stage);
      return;
    }
    case 'skip': {
      const item = protocolName(subcommand.arg);
      if (item === undefined) {
        host.showError(t('tui.statusMessages.helloWorldSkipUsage'));
        return;
      }
      if (!isHelloWorldRunItem(item)) {
        host.showError(
          t('tui.statusMessages.helloWorldInvalidItem', {
            item,
            items: HELLO_WORLD_RUN_ITEMS.join(', '),
          }),
        );
        return;
      }
      await waiveHelloWorldRunItem(host, item);
      return;
    }
  }
}

async function advanceHelloWorldStage(
  host: SlashCommandHost,
  stage: HelloWorldStageId | 'next',
): Promise<void> {
  try {
    await host.requireSession().setHelloWorldStage(stage);
  } catch (error) {
    host.showError(t('tui.messages.helloWorldStageFailed', { error: formatErrorMessage(error) }));
    return;
  }
  await syncHelloWorldRunState(host);
}

async function waiveHelloWorldRunItem(
  host: SlashCommandHost,
  item: HelloWorldRunItemId,
): Promise<void> {
  try {
    await host.requireSession().waiveHelloWorldItem(item);
  } catch (error) {
    host.showError(t('tui.messages.helloWorldSkipFailed', { error: formatErrorMessage(error) }));
    return;
  }
  await syncHelloWorldRunState(host);
}

/**
 * Mirror the engine's run stage into appState after `next`/`phase`/`skip` so
 * the footer badge and `/status` row do not wait for the next status event. A
 * failed read is not actionable (the event stream carries the same value), so
 * it degrades to no update rather than an error, like the toggle confirmation.
 */
async function syncHelloWorldRunState(host: SlashCommandHost): Promise<void> {
  const status = await host.requireSession().getStatus().catch(() => null);
  if (status === null) return;
  host.setAppState({ helloWorldStage: status.helloWorldRun?.stage });
}

async function warnOpenHelloWorldItems(host: SlashCommandHost): Promise<void> {
  const status = await host.requireSession().getStatus().catch(() => null);
  const run = status?.helloWorldRun;
  if (run === undefined) return;
  const open = run.items.filter((item) => !item.done).map((item) => item.id);
  if (open.length === 0) return;
  host.showStatus(
    t('tui.statusMessages.helloWorldOpenItemsWarning', { items: open.join(', ') }),
    'warning',
  );
}

async function showHelloWorldRunStatus(host: SlashCommandHost): Promise<void> {
  let status: SessionStatus;
  try {
    status = await host.requireSession().getStatus();
  } catch (error) {
    host.showError(formatErrorMessage(error));
    return;
  }
  const run = status.helloWorldRun;
  if (run === undefined) {
    host.showStatus(t('tui.statusMessages.helloWorldNoRun'));
    return;
  }
  host.appendTranscriptEntry(
    {
      id: nextTranscriptId(),
      kind: 'status',
      turnId: undefined,
      renderMode: 'plain',
      content: '',
    },
    new HelloWorldRunPanelComponent(run),
  );
}

const RUN_PANEL_LABEL_WIDTH = 11;

/** Pad `text` to `width` visible columns (CJK-safe, unlike `padEnd`). */
function padEndVisible(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleWidth(text)));
}

function buildHelloWorldRunLines(run: HelloWorldRunStatus, wrapWidth: number): string[] {
  const value = (text: string): string => currentTheme.fg('text', text);
  const muted = (text: string): string => currentTheme.fg('textDim', text);
  const row = (label: string, val: string): string =>
    `${muted(padEndVisible(label, RUN_PANEL_LABEL_WIDTH))}${val}`;
  const lines: string[] = [
    row(t('tui.messages.helloWorldRunPanel.stageLabel'), value(run.stage)),
    row(
      t('tui.messages.helloWorldRunPanel.taskLabel'),
      run.task === undefined
        ? muted(t('tui.messages.helloWorldRunPanel.noTask'))
        : value(run.task),
    ),
    '',
    muted(t('tui.messages.helloWorldRunPanel.itemsLabel')),
  ];
  const evidenceWidth = Math.max(1, wrapWidth - 4);
  for (const item of run.items) {
    lines.push(`  ${value(`${item.done ? '✓' : '·'} ${item.id}`)}`);
    if (item.evidence !== undefined && item.evidence.length > 0) {
      lines.push(`    ${muted(truncateToWidth(item.evidence, evidenceWidth, '…'))}`);
    }
  }
  if (run.waivers.length > 0) {
    lines.push('');
    lines.push(
      row(t('tui.messages.helloWorldRunPanel.waiversLabel'), value(run.waivers.join(', '))),
    );
  }
  return lines;
}

class HelloWorldRunPanelComponent implements Component {
  /** Box built once per width; recreated when the width changes. */
  private panel: UsagePanelComponent | undefined;
  private panelWidth = -1;

  constructor(private readonly run: HelloWorldRunStatus) {}

  invalidate(): void {
    this.panel = undefined;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    if (this.panel === undefined || this.panelWidth !== safeWidth) {
      const contentWidth = Math.max(1, safeWidth - 6);
      this.panel = new UsagePanelComponent(
        () => buildHelloWorldRunLines(this.run, contentWidth),
        'primary',
        t('tui.messages.helloWorldRunPanel.title'),
      );
      this.panelWidth = safeWidth;
    }
    return ['', ...this.panel.render(safeWidth)];
  }
}
