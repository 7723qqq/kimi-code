/**
 * TUI2 tasks browser controller — background task list + output viewer.
 *
 * Mirrors `tui/controllers/tasks-browser.ts`. The v1 controller mounted
 * pi-tui components (TasksBrowserApp, TaskOutputViewer, AgentActivityViewer)
 * with screen takeovers; the tui2 version keeps the polling/refresh logic
 * and writes `store.state.tasksBrowser` — the opentui reconciler renders the
 * dialog from that state.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { BackgroundTaskInfo, Session } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';

import type { Tui2Store } from '../state';
import type { TasksBrowserState } from '../types';
import type { SubToolCallActivity, SubagentActivityRecord } from './subagent-activity-store';
import type { SessionEventHandler } from './session-event-handler';

export interface TasksBrowserHost {
  readonly store: Tui2Store;
  readonly backgroundTasks: ReadonlyMap<string, BackgroundTaskInfo>;
  readonly sessionEventHandler: SessionEventHandler;
  readonly session: Session | undefined;
  showError(msg: string): void;
  setTasksBrowser(value: TasksBrowserState | undefined): void;
}

export class TasksBrowserController {
  private refreshing = false;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private viewerPollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly host: TasksBrowserHost) {}

  async show(): Promise<void> {
    const { store } = this.host;
    if (store.state.tasksBrowser !== undefined) return;

    const session = this.host.session;
    if (session === undefined) {
      this.host.showError(t('tui.statusMessages.noActiveSession'));
      return;
    }

    let tasks: readonly BackgroundTaskInfo[] = [];
    try {
      tasks = await session.listBackgroundTasks({ activeOnly: false });
    } catch (error) {
      this.host.showError(
        t('tui.messages.tasksLoadFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }
    if (store.state.tasksBrowser !== undefined) return;

    const filter: TasksBrowserState['filter'] = 'all';
    const selectedTaskId = this.pickInitialSelection(tasks, filter);
    this.host.setTasksBrowser({
      tasks,
      filter,
      selectedTaskId,
      tailOutput: undefined,
      tailLoading: false,
      tailRequestId: 0,
      flashMessage: undefined,
      viewer: undefined,
    });
    // Surface the dialog through the dialog slot so the shell can render it
    // uniformly with the other controller-managed dialogs.
    this.host.store.setState('activeDialog', 'tasks-browser');

    this.pollTimer = setInterval(() => {
      void this.refreshList({ silent: true });
    }, 1000);

    if (selectedTaskId !== undefined) {
      this.loadTail(selectedTaskId);
    }
  }

  close(): void {
    const browser = this.host.store.state.tasksBrowser;
    if (browser === undefined) return;
    if (browser.viewer !== undefined) this.closeOutputViewer();
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.host.setTasksBrowser(undefined);
    // Only release the dialog slot if we still own it — never clobber a
    // different dialog that has taken the slot since close started.
    if (this.host.store.state.activeDialog === 'tasks-browser') {
      this.host.store.setState('activeDialog', null);
    }
  }

  repaint(): void {
    const browser = this.host.store.state.tasksBrowser;
    if (browser === undefined) return;
    // The store is the single source of truth; a no-op setState still notifies
    // subscribers, so this is a cheap way to force a re-render after a change
    // that mutated nested fields directly.
    this.host.store.setState('tasksBrowser', { ...browser });
  }

  /**
   * Patch a subset of `tasksBrowser` while preserving sibling fields. SolidJS
   * `createStore` setters replace at the given path, so a bare
   * `setState('tasksBrowser', { foo: x })` would wipe filter / selectedTaskId
   * / tailOutput / viewer / flashMessage on every partial write. Delegates
   * to `host.store.patch` (the shared store-level helper) so the same
   * invariant lives in exactly one place.
   *
   * No-op when the dialog slice is closed; callers that need a different
   * guard should check the slice themselves.
   */
  private patchTasksBrowser(partial: Partial<TasksBrowserState>): void {
    this.host.store.patch('tasksBrowser', partial);
  }

  async refreshOutputViewer(opts: { silent?: boolean } = {}): Promise<void> {
    const { store } = this.host;
    const browser = store.state.tasksBrowser;
    const viewer = browser?.viewer;
    if (browser === undefined || viewer === undefined) return;
    // The agent activity viewer refreshes from the local store, not the RPC.
    if (viewer.kind === 'activity') return;

    const session = this.host.session;
    if (session === undefined) return;

    let output: string;
    try {
      output = await session.getBackgroundTaskOutput(viewer.taskId);
    } catch (error) {
      if (!opts.silent) {
        const message = error instanceof Error ? error.message : String(error);
        this.flash(t('tui.messages.tasksOutputRefreshFailed', { message }));
      }
      return;
    }
    const current = store.state.tasksBrowser?.viewer;
    if (current === undefined || current !== viewer) return;
    if (output === viewer.output) return;
    this.patchTasksBrowser({
      viewer: { ...viewer, output },
    });
  }

  // ---------------------------------------------------------------------------

  private pickInitialSelection(
    tasks: readonly BackgroundTaskInfo[],
    filter: TasksBrowserState['filter'],
  ): string | undefined {
    const candidates =
      filter === 'all'
        ? tasks
        : tasks.filter(
            (task) =>
              task.status !== 'completed' &&
              task.status !== 'failed' &&
              task.status !== 'timed_out' &&
              task.status !== 'killed' &&
              task.status !== 'lost',
          );
    if (candidates.length === 0) return undefined;
    return candidates.find((task) => task.status === 'running')?.taskId ?? candidates[0]!.taskId;
  }

  private async refreshList(opts: { silent?: boolean } = {}): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const { store } = this.host;
      const browser = store.state.tasksBrowser;
      if (browser === undefined) return;

      const session = this.host.session;
      if (session === undefined) return;

      try {
        // Refresh the host's task map via the RPC; the store repaints from
        // `backgroundTasks` (kept in sync by the session event handler).
        await session.listBackgroundTasks({ activeOnly: false });
      } catch (error) {
        if (!opts.silent) {
          this.flash(
            t('tui.messages.tasksRefreshFailed', {
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
        return;
      }
      if (store.state.tasksBrowser !== browser) return;
      // Snapshot the host task map into the store so the shell can render the
      // list without reaching into the host.
      if (store.state.tasksBrowser !== undefined) {
        // SolidJS createStore setters replace at the given path; spread the
        // existing state so filter / selectedTaskId / tailOutput / viewer /
        // flashMessage survive the refresh.
        store.setState('tasksBrowser', {
          ...store.state.tasksBrowser,
          tasks: [...this.host.backgroundTasks.values()],
        });
      }
      this.syncAgentPreview();
      this.repaint();
    } finally {
      this.refreshing = false;
    }
  }

  /** Agent tasks capture output only on completion, so while one is selected
   *  the Preview frame is fed from the in-memory activity store instead. */
  private syncAgentPreview(): void {
    const browser = this.host.store.state.tasksBrowser;
    const selectedTaskId = browser?.selectedTaskId;
    if (browser === undefined || selectedTaskId === undefined) return;
    const info = this.host.backgroundTasks.get(selectedTaskId);
    if (info?.kind !== 'agent' || info.agentId === undefined) return;
    const record = this.host.sessionEventHandler.subAgentEventHandler.activityStore.get(
      info.agentId,
    );
    if (record === undefined) return;
    this.patchTasksBrowser({
      tailOutput: formatSubagentActivityPreview(record, this.host.session?.workDir),
      tailLoading: false,
    });
  }

  /** Select a task (updates the selection + tail preview). */
  select(taskId: string): void {
    const browser = this.host.store.state.tasksBrowser;
    if (browser === undefined) return;
    if (browser.selectedTaskId === taskId) return;
    this.patchTasksBrowser({
      selectedTaskId: taskId,
      tailOutput: undefined,
      tailLoading: true,
    });
    this.loadTail(taskId);
  }

  /** Cycle the filter between all / active. */
  toggleFilter(): void {
    const browser = this.host.store.state.tasksBrowser;
    if (browser === undefined) return;
    this.patchTasksBrowser({
      filter: browser.filter === 'all' ? 'active' : 'all',
    });
  }

  /** Force a refresh of the task list. */
  refresh(): void {
    this.flash(t('tui.messages.tasksRefreshing'), 600);
    void this.refreshList();
  }

  /** Stop a background task (with user-facing flash). */
  async stop(taskId: string): Promise<void> {
    const browser = this.host.store.state.tasksBrowser;
    if (browser === undefined) return;

    const session = this.host.session;
    if (session === undefined) {
      this.flash(t('tui.statusMessages.noActiveSession'));
      return;
    }

    this.flash(t('tui.messages.tasksStopping', { taskId }), 1500);
    try {
      await session.stopBackgroundTask(taskId, { reason: 'User initiated stop' });
      await this.refreshList({ silent: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.flash(t('tui.messages.tasksStopFailed', { message }));
    }
  }

  /** Open the output viewer for a task. */
  async openOutput(taskId: string): Promise<void> {
    const { store } = this.host;
    const browser = store.state.tasksBrowser;
    if (browser === undefined) return;
    if (browser.viewer !== undefined) return;

    // Agent tasks get the activity detail view when this process holds a
    // record for the agent; otherwise (e.g. a `lost` task after resume) fall
    // through to the captured-output viewer.
    const info = this.host.backgroundTasks.get(taskId);
    if (info !== undefined && info.kind === 'agent' && info.agentId !== undefined) {
      const record = this.host.sessionEventHandler.subAgentEventHandler.activityStore.get(
        info.agentId,
      );
      if (record !== undefined) {
        this.openAgentActivityViewer(taskId, info, record);
        return;
      }
    }

    const session = this.host.session;
    if (session === undefined) {
      this.flash(t('tui.statusMessages.noActiveSession'));
      return;
    }

    let output: string;
    try {
      output = await session.getBackgroundTaskOutput(taskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.flash(t('tui.messages.tasksCannotOpenOutput', { message }));
      return;
    }
    const current = store.state.tasksBrowser;
    // Re-validate after the await: a second concurrent open may have already
    // attached a viewer while we were fetching, and overwriting it here would
    // leak its poll timer.
    if (current === undefined || current !== browser || current.viewer !== undefined) return;

    this.patchTasksBrowser({
      viewer: { taskId, output, kind: 'output' },
    });
    this.viewerPollTimer = setInterval(() => {
      void this.refreshOutputViewer({ silent: true });
    }, 1000);
  }

  private openAgentActivityViewer(
    taskId: string,
    _info: BackgroundTaskInfo,
    record: SubagentActivityRecord,
  ): void {
    const { store } = this.host;
    const browser = store.state.tasksBrowser;
    if (browser === undefined || browser.viewer !== undefined) return;

    this.patchTasksBrowser({
      viewer: {
        taskId,
        output: formatSubagentActivityPreview(record, this.host.session?.workDir),
        kind: 'activity',
        lastRecordKey: `${record.agentId}:${String(record.version)}`,
      },
    });
    // The activity store is in-memory — refreshing is a local read, no RPC.
    this.viewerPollTimer = setInterval(() => {
      this.refreshAgentActivityViewer();
    }, 1000);
  }

  private refreshAgentActivityViewer(): void {
    const { store } = this.host;
    const viewer = store.state.tasksBrowser?.viewer;
    if (viewer === undefined || viewer.kind !== 'activity') return;

    const info = this.host.backgroundTasks.get(viewer.taskId);
    const agentId = info?.kind === 'agent' ? info.agentId : undefined;
    const record =
      agentId === undefined
        ? undefined
        : this.host.sessionEventHandler.subAgentEventHandler.activityStore.get(agentId);
    // The viewer's body is cached against record.version — a per-second poll
    // that re-delivers the same record must not force a repaint (rebuilding
    // all body Markdown). `agentId` is part of the key so a different agent
    // record with a coincidentally equal version still repaints.
    const recordKey =
      record === undefined ? undefined : `${record.agentId}:${String(record.version)}`;
    if (recordKey === viewer.lastRecordKey) return;
    this.patchTasksBrowser({
      viewer: {
        ...viewer,
        output: record === undefined ? '' : formatSubagentActivityPreview(record, this.host.session?.workDir),
        lastRecordKey: recordKey,
      },
    });
  }

  private loadTail(taskId: string): void {
    const { store } = this.host;
    const browser = store.state.tasksBrowser;
    if (browser === undefined) return;

    // Agent tasks capture output only on completion — serve the preview from
    // the in-memory activity store instead of the RPC when a record exists.
    const info = this.host.backgroundTasks.get(taskId);
    if (info !== undefined && info.kind === 'agent' && info.agentId !== undefined) {
      const record = this.host.sessionEventHandler.subAgentEventHandler.activityStore.get(
        info.agentId,
      );
      if (record !== undefined) {
        this.patchTasksBrowser({
          tailOutput: formatSubagentActivityPreview(record, this.host.session?.workDir),
          tailLoading: false,
        });
        return;
      }
    }

    const session = this.host.session;
    if (session === undefined) {
      this.patchTasksBrowser({ tailLoading: false });
      return;
    }

    const requestId = (browser.tailRequestId ?? 0) + 1;
    this.patchTasksBrowser({ tailRequestId: requestId });
    void session
      .getBackgroundTaskOutput(taskId, { tail: 4000 })
      .then((output) => {
        const current = this.host.store.state.tasksBrowser;
        if (current === undefined) return;
        if (current !== browser || current.tailRequestId !== requestId) return;
        if (current.selectedTaskId !== taskId) return;
        this.patchTasksBrowser({ tailOutput: output, tailLoading: false });
      })
      .catch(() => {
        const current = this.host.store.state.tasksBrowser;
        if (current === undefined) return;
        if (current !== browser || current.tailRequestId !== requestId) return;
        if (current.selectedTaskId !== taskId) return;
        this.patchTasksBrowser({ tailOutput: '', tailLoading: false });
      });
  }

  private flash(message: string, durationMs = 2500): void {
    if (this.host.store.state.tasksBrowser === undefined) return;
    this.patchTasksBrowser({ flashMessage: message });
    setTimeout(() => {
      // Unconditional clear: any later flash() will overwrite this message
      // and schedule its own timeout. The previous identity-based guard
      // never fired after `patchTasksBrowser` started replacing the slice
      // reference, which left stale banners on screen indefinitely.
      this.patchTasksBrowser({ flashMessage: undefined });
    }, durationMs);
  }

  /** Close the output viewer and return to the task list. */
  closeOutputViewer(): void {
    const browser = this.host.store.state.tasksBrowser;
    if (browser === undefined || browser.viewer === undefined) return;
    if (this.viewerPollTimer !== undefined) clearInterval(this.viewerPollTimer);
    this.viewerPollTimer = undefined;
    this.patchTasksBrowser({ viewer: undefined });
  }
}

// ---------------------------------------------------------------------------
// Subagent activity preview (simplified from the v1 AgentActivityViewer)
// ---------------------------------------------------------------------------

const MESSAGE_INDENT = '  ';

function formatSubagentActivityPreview(
  record: SubagentActivityRecord,
  workspaceDir?: string,
): string {
  const lines: string[] = [];
  for (const step of record.steps) {
    lines.push(`── step ${String(step.step)} ──`);
    if (step.retrying !== undefined) lines.push(`${MESSAGE_INDENT}↻ ${step.retrying}`);
    if (step.textTail.trim().length > 0) lines.push(...step.textTail.trimEnd().split('\n'));
    for (const call of step.toolCalls) {
      lines.push(formatPreviewToolCall(call, workspaceDir));
      if (
        call.result === undefined &&
        call.liveOutputTail !== undefined &&
        call.liveOutputTail.length > 0
      ) {
        lines.push(`${MESSAGE_INDENT}│ ${sanitizeLiveOutput(call.liveOutputTail)}`);
      }
    }
  }
  if (record.error !== undefined && record.error.length > 0) {
    lines.push(
      t('tui.dialogs.agentActivityViewer.failedColon'),
      ...record.error.trimEnd().split('\n'),
    );
  } else if (record.resultSummary !== undefined && record.resultSummary.length > 0) {
    lines.push(
      t('tui.dialogs.agentActivityViewer.resultColon'),
      ...record.resultSummary.trimEnd().split('\n'),
    );
  }
  if (lines.length === 0) {
    return record.status === 'running' ? t('tui.dialogs.agentActivityViewer.waiting') : '';
  }
  return lines.join('\n');
}

function formatPreviewToolCall(call: SubToolCallActivity, workspaceDir?: string): string {
  const mark = call.status === 'done' ? '✓' : call.status === 'error' ? '✗' : '●';
  const verb =
    call.status === 'running'
      ? t('tui.dialogs.agentActivityViewer.using')
      : t('tui.dialogs.agentActivityViewer.used');
  const keyArg = extractKeyArgument(call.name, call.args, workspaceDir);
  const argStr = keyArg === null || keyArg.length === 0 ? '' : ` (${keyArg})`;
  return `${mark} ${verb} ${call.name}${argStr}`;
}

/** Simplified key-argument extraction (no tool-renderer chips). */
function extractKeyArgument(
  toolName: string,
  args: Record<string, unknown>,
  workspaceDir?: string,
): string | null {
  const keyMap: Record<string, string[]> = {
    Bash: ['command'],
    Read: ['path', 'file_path'],
    Write: ['path', 'file_path'],
    Edit: ['path', 'file_path'],
    Grep: ['pattern'],
    Glob: ['pattern'],
    FetchURL: ['url'],
    WebSearch: ['query'],
    Agent: ['description', 'prompt'],
  };
  const keys = keyMap[toolName] ?? [];
  for (const key of keys) {
    const value = args[key];
    if (typeof value !== 'string' || value.length === 0) continue;
    const trimmed = value.replaceAll(/\s+/g, ' ').trim();
    if (trimmed.length === 0) continue;
    const relative = makeWorkspaceRelativePath(trimmed, workspaceDir);
    return truncateArgValue(key, relative);
  }
  return null;
}

function makeWorkspaceRelativePath(value: string, workspaceDir?: string): string {
  if (workspaceDir === undefined || workspaceDir.length === 0) return value;
  const prefix = `${workspaceDir.replaceAll('\\', '/')}/`;
  const normalized = value.replaceAll('\\', '/');
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : value;
}

function truncateArgValue(key: string, value: string): string {
  const max = 60;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}… (${key} truncated)`;
}

function sanitizeLiveOutput(value: string): string {
  let result = '';
  let i = 0;
  while (i < value.length) {
    const code = value.codePointAt(i)!;
    if (code === 0x1b) {
      const next = value.codePointAt(i + 1);
      if (next === 0x5b /* '[' */) {
        // CSI: ESC [ … final byte in 0x40–0x7e. Unterminated sequences are
        // consumed to the end of the string.
        i += 2;
        while (
          i < value.length &&
          !(value.codePointAt(i)! >= 0x40 && value.codePointAt(i)! <= 0x7e)
        ) {
          i += 1;
        }
        i += 1;
        continue;
      }
      if (next === 0x5d /* ']' */) {
        // OSC: ESC ] … BEL (0x07) or ST (ESC \).
        i += 2;
        while (i < value.length) {
          const c = value.codePointAt(i)!;
          if (c === 0x07) {
            i += 1;
            break;
          }
          if (c === 0x1b && value.codePointAt(i + 1) === 0x5c) {
            i += 2;
            break;
          }
          i += 1;
        }
        continue;
      }
      // Other ESC sequences: skip the next byte.
      i += 2;
      continue;
    }
    result += String.fromCodePoint(code);
    i += 1;
  }
  return result;
}
