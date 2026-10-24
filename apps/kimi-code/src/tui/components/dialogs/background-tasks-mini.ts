import type { BackgroundTaskInfo, ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import { Container, Text, type Focusable } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { TasksPanelComponent, type TasksPanelProps, type TasksTab } from './tasks-browser';
import { currentTheme } from '#/tui/theme';

export interface BackgroundTasksMiniProps {
  readonly tasks: readonly BackgroundTaskInfo[];
  readonly tab: TasksTab;
  readonly selectedTaskId: string | undefined;
  readonly height: number;
  readonly output: string | undefined;
  readonly outputLoading: boolean;
  readonly activity: unknown;
  readonly cwd: string | undefined;
  readonly flashMessage: string | undefined;
  readonly availableModels: Record<string, ModelAlias>;
  readonly onSelect: (taskId: string) => void;
  readonly onTabChange: (tab: TasksTab) => void;
  readonly onRefresh: () => void;
  readonly onCancel: () => void;
  readonly onStop: (taskId: string) => void;
  readonly onStopIgnored?: (taskId: string, reason: 'terminal') => void;
  readonly onAmplify: () => void;
}

export class BackgroundTasksMiniPanel extends Container implements Focusable {
  focused = false;
  private props: BackgroundTasksMiniProps;
  private inner: TasksPanelComponent;

  constructor(props: BackgroundTasksMiniProps) {
    super();
    this.props = props;
    this.inner = new TasksPanelComponent(this.toPanelProps(props));
    this.addChild(this.inner);
    this.addChild(new Text(currentTheme.fg('textMuted', `  Esc/q ${t('tui.dialogs.tasksBrowser.hintCancel')} · Enter/a ${t('tui.dialogs.backgroundTasksMini.amplify')}  `), 0, 0));
  }

  setProps(next: BackgroundTasksMiniProps): void {
    this.props = next;
    this.inner.setProps(this.toPanelProps(next));
    this.invalidate();
  }

  handleInput(data: string): void {
    const k = data.toLowerCase();
    if (k === 'q' || k === 'escape') {
      this.props.onCancel();
      return;
    }
    if (k === 'a' || k === 'enter') {
      this.props.onAmplify();
      return;
    }
    this.inner.handleInput(data);
  }

  override render(width: number): string[] {
    const innerHeight = Math.max(4, this.props.height - 1);
    const lines = this.inner.render(width).slice(0, innerHeight);
    const hint = currentTheme.fg('textMuted', `  Esc/q ${t('tui.dialogs.tasksBrowser.hintCancel')} · Enter/a ${t('tui.dialogs.backgroundTasksMini.amplify')}  `);
    while (lines.length < innerHeight) lines.push('');
    lines.push(hint);
    return lines.slice(0, this.props.height);
  }

  private toPanelProps(props: BackgroundTasksMiniProps): TasksPanelProps {
    return {
      tasks: props.tasks,
      tab: props.tab,
      selectedTaskId: props.selectedTaskId,
      height: Math.max(4, props.height - 1),
      output: props.output,
      outputLoading: props.outputLoading,
      activity: props.activity,
      cwd: props.cwd,
      flashMessage: props.flashMessage,
      availableModels: props.availableModels,
      onSelect: props.onSelect,
      onTabChange: props.onTabChange,
      onRefresh: props.onRefresh,
      onCancel: props.onCancel,
      onStop: props.onStop,
      onStopIgnored: props.onStopIgnored,
    } as TasksPanelProps;
  }
}