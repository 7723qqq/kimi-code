import { type BackgroundTaskInfo } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, mock } from 'bun:test';

import {
  TasksPanelComponent,
  type TasksPanelProps,
} from '@/tui/components/dialogs/tasks-browser';
import { SubagentActivityStore } from '@/tui/controllers/subagent-activity-store';
import { TasksBrowserController } from '@/tui/controllers/tasks-browser';
import type { SubagentActivityRecord } from '@/tui/controllers/subagent-activity-store';

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

/** Kitty CSI-u form of Ctrl+O (codepoint 111, modifier 1+4). */
const CTRL_O = '\u001B[111;5u';

function task(overrides: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo {
  return {
    taskId: 'bash-abcd1234',
    kind: 'process',
    command: 'npm run dev',
    description: 'dev server',
    status: 'running',
    pid: 1234,
    exitCode: null,
    startedAt: Date.now() - 60_000,
    endedAt: null,
    ...overrides,
  } as BackgroundTaskInfo;
}

function makeProps(overrides: Partial<TasksPanelProps> = {}): TasksPanelProps {
  return {
    tasks: [],
    tab: 'all',
    selectedTaskId: undefined,
    height: 30,
    output: undefined,
    outputLoading: false,
    activity: undefined,
    cwd: undefined,
    flashMessage: undefined,
    availableModels: {},
    onSelect: mock(),
    onTabChange: mock(),
    onRefresh: mock(),
    onCancel: mock(),
    onStop: mock(),
    onStopIgnored: mock(),
    ...overrides,
  } as TasksPanelProps;
}

function makePanel(props: Partial<TasksPanelProps> = {}, height = 30): TasksPanelComponent {
  return new TasksPanelComponent(makeProps({ ...props, height }));
}

function render(props: Partial<TasksPanelProps> = {}, width = 120, height = 30): string {
  return strip(makePanel(props, height).render(width).join('\n'));
}

function record(overrides: Partial<SubagentActivityRecord> = {}): SubagentActivityRecord {
  return {
    agentId: 'agent-1',
    agentName: 'explore',
    description: 'find things',
    parentToolCallId: 'tc-1',
    steps: [],
    totalSteps: 0,
    status: 'running',
    version: 1,
    ...overrides,
  };
}

describe('TasksPanelComponent — layout', () => {
  it('fills exactly the height it was given', () => {
    expect(makePanel({}, 30).render(120).length).toBe(30);
    expect(makePanel({}, 18).render(120).length).toBe(18);
  });

  it('renders two columns separated by a rule', () => {
    const out = render({
      tasks: [task({ taskId: 'bash-aaaaaaaa' })],
      selectedTaskId: 'bash-aaaaaaaa',
    });
    expect(out).toContain('│');
    expect(out).toContain('bash-aaaaaaaa');
  });

  it('stacks the columns on a narrow terminal', () => {
    const out = render(
      { tasks: [task({ taskId: 'bash-aaaaaaaa' })], selectedTaskId: 'bash-aaaaaaaa' },
      80,
    );
    expect(out).not.toContain('│');
    expect(out).toContain('bash-aaaaaaaa');
  });

  it('falls back to a single line when the terminal is too small', () => {
    expect(render({}, 30, 5)).toContain('too small');
  });

  it('shows the title, the tab strip and the hint', () => {
    const out = render();
    expect(out).toContain('Tasks');
    expect(out).toContain('All');
    expect(out).toContain('Running');
    expect(out).toContain('Finished');
    expect(out).toContain('navigate');
    expect(out).toContain('cancel');
  });
});

describe('TasksPanelComponent — tabs', () => {
  const tasks = [
    task({ taskId: 'bash-aaaaaaaa', status: 'running', description: 'web server' }),
    task({ taskId: 'bash-bbbbbbbb', status: 'completed', description: 'test runner' }),
  ];

  it('lists every task on the All tab', () => {
    const out = render({ tasks, tab: 'all' });
    expect(out).toContain('web server');
    expect(out).toContain('test runner');
  });

  it('lists only running tasks on the Running tab', () => {
    const out = render({ tasks, tab: 'running' });
    expect(out).toContain('web server');
    expect(out).not.toContain('test runner');
  });

  it('lists only finished tasks on the Finished tab', () => {
    const out = render({ tasks, tab: 'finished' });
    expect(out).not.toContain('web server');
    expect(out).toContain('test runner');
  });

  it('cycles the tab with Tab', () => {
    const onTabChange = mock();
    makePanel({ tasks, onTabChange }).handleInput('\t');
    expect(onTabChange).toHaveBeenCalledWith('running');
    makePanel({ tasks, tab: 'running', onTabChange }).handleInput('\t');
    expect(onTabChange).toHaveBeenCalledWith('finished');
    makePanel({ tasks, tab: 'finished', onTabChange }).handleInput('\t');
    expect(onTabChange).toHaveBeenCalledWith('all');
  });

  it('shows an empty state per tab', () => {
    expect(render({ tasks: [], tab: 'running' })).toContain('No running tasks');
    expect(render({ tasks: [], tab: 'finished' })).toContain('No finished tasks');
    expect(render({ tasks: [], tab: 'all' })).toContain('No background tasks');
  });
});

describe('TasksPanelComponent — detail narrative', () => {
  it('tells what, where and how it ended', () => {
    const out = render({
      tasks: [
        task({
          taskId: 'bash-aaaaaaaa',
          status: 'completed',
          exitCode: 0,
          endedAt: Date.now() - 1000,
        }),
      ],
      selectedTaskId: 'bash-aaaaaaaa',
      cwd: '/repo',
      output: 'ready in 432ms',
    });
    expect(out).toContain('What');
    expect(out).toContain('npm run dev');
    expect(out).toContain('Where');
    expect(out).toContain('/repo');
    expect(out).toContain('Outcome');
    expect(out).toContain('exit code: 0');
    expect(out).toContain('Output');
    expect(out).toContain('ready in 432ms');
  });

  it('hides the noise fields until the raw view is asked for', () => {
    const props = {
      tasks: [task({ taskId: 'bash-aaaaaaaa', pid: 9999 })],
      selectedTaskId: 'bash-aaaaaaaa',
    };
    const plain = render(props);
    expect(plain).not.toContain('9999');
    expect(plain).not.toContain('pid');

    const panel = makePanel(props);
    panel.handleInput(CTRL_O);
    const raw = strip(panel.render(120).join('\n'));
    expect(raw).toContain('pid');
    expect(raw).toContain('9999');
  });

  it('keeps the task id as the last line', () => {
    const out = render({
      tasks: [task({ taskId: 'bash-aaaaaaaa' })],
      selectedTaskId: 'bash-aaaaaaaa',
    });
    const lines = out.split('\n');
    const taskIdIndex = lines.findIndex((line) => line.includes('task id'));
    const outputIndex = lines.findIndex((line) => line.trim() === 'Output');
    expect(taskIdIndex).toBeGreaterThan(outputIndex);
    expect(lines[taskIdIndex]).toContain('bash-aaaaaaaa');
  });

  it('drops the agent model and type into tags', () => {
    const out = render({
      tasks: [
        task({
          taskId: 'agent-aaaaaaaa',
          kind: 'agent',
          agentId: 'agent-1',
          subagentType: 'explore',
          model: 'kimi-code/k3-256k',
        }),
      ],
      selectedTaskId: 'agent-aaaaaaaa',
    });
    expect(out).toContain('type: explore');
    expect(out).toContain('model: kimi-code/k3-256k');
  });
});

describe('TasksPanelComponent — output section', () => {
  it('always renders the output section', () => {
    const out = render({
      tasks: [task({ taskId: 'bash-aaaaaaaa' })],
      selectedTaskId: 'bash-aaaaaaaa',
    });
    expect(out).toContain('Output');
    expect(out).toContain('[no output captured]');
  });

  it('shows a loading state while the output is being read', () => {
    const out = render({
      tasks: [task({ taskId: 'bash-aaaaaaaa' })],
      selectedTaskId: 'bash-aaaaaaaa',
      outputLoading: true,
    });
    expect(out).toContain('[loading');
  });

  it('follows the tail of a long output', () => {
    const output = Array.from({ length: 200 }, (_, i) =>
      `line-${String(i + 1).padStart(3, '0')}`,
    ).join('\n');
    const out = render({
      tasks: [task({ taskId: 'bash-aaaaaaaa' })],
      selectedTaskId: 'bash-aaaaaaaa',
      output,
    });
    expect(out).toContain('line-200');
    expect(out).not.toContain('line-001');
  });

  it('does not pass terminal controls from the output into the panel', () => {
    const raw = makePanel({
      tasks: [task({ taskId: 'bash-aaaaaaaa' })],
      selectedTaskId: 'bash-aaaaaaaa',
      output: 'Downloading wheel 25%\rDownloading wheel 75%\u001B[2Jdone',
    })
      .render(120)
      .join('\n');
    expect(raw).not.toContain('\r');
    expect(raw).not.toContain('\u001B[2J');
    expect(strip(raw)).toContain('Downloading wheel 25%Downloading wheel 75%done');
  });
});

describe('TasksPanelComponent — agent activity', () => {
  const agentTask = task({
    taskId: 'agent-aaaaaaaa',
    kind: 'agent',
    agentId: 'agent-1',
    subagentType: 'explore',
  });

  it('says so explicitly when the activity record is gone', () => {
    const out = render({
      tasks: [agentTask],
      selectedTaskId: 'agent-aaaaaaaa',
      activity: undefined,
    });
    expect(out).toContain('Activity');
    expect(out).toContain('activity unavailable (session restarted)');
  });

  it('renders the activity of a running agent above the output', () => {
    const out = render({
      tasks: [agentTask],
      selectedTaskId: 'agent-aaaaaaaa',
      activity: record({ status: 'running' }),
      output: 'engine output',
    });
    expect(out.indexOf('Activity')).toBeLessThan(out.indexOf('Output'));
  });

  it('renders the output of a finished agent above the activity', () => {
    const out = render({
      tasks: [{ ...agentTask, status: 'completed' } as BackgroundTaskInfo],
      selectedTaskId: 'agent-aaaaaaaa',
      activity: record({ status: 'completed' }),
      output: 'engine output',
    });
    expect(out.indexOf('Output')).toBeLessThan(out.indexOf('Activity'));
  });

  it('never substitutes the output for the activity', () => {
    const out = render({
      tasks: [agentTask],
      selectedTaskId: 'agent-aaaaaaaa',
      activity: undefined,
      output: 'engine output',
    });
    expect(out).toContain('engine output');
    expect(out).toContain('activity unavailable (session restarted)');
  });

  it('gives a process task no activity section', () => {
    const out = render({
      tasks: [task({ taskId: 'bash-aaaaaaaa' })],
      selectedTaskId: 'bash-aaaaaaaa',
      activity: record(),
    });
    expect(out).not.toContain('Activity');
  });
});

describe('TasksPanelComponent — input handling', () => {
  it('Esc invokes onCancel', () => {
    const onCancel = mock();
    makePanel({ onCancel }).handleInput('\u001B');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('q invokes onCancel', () => {
    const onCancel = mock();
    makePanel({ onCancel }).handleInput('q');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('R invokes onRefresh', () => {
    const onRefresh = mock();
    makePanel({ onRefresh }).handleInput('r');
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('arrow keys move the selection and invoke onSelect', () => {
    const onSelect = mock();
    const tasks = [
      task({ taskId: 'bash-aaaaaaaa', status: 'running', startedAt: 1 }),
      task({ taskId: 'bash-bbbbbbbb', status: 'running', startedAt: 2 }),
      task({ taskId: 'bash-cccccccc', status: 'running', startedAt: 3 }),
    ];
    const panel = makePanel({ tasks, selectedTaskId: 'bash-aaaaaaaa', onSelect });
    panel.handleInput('\u001B[B');
    expect(onSelect).toHaveBeenLastCalledWith('bash-bbbbbbbb');
    panel.handleInput('\u001B[A');
    expect(onSelect).toHaveBeenLastCalledWith('bash-aaaaaaaa');
  });

  it('Enter focuses the output and Esc leaves it again', () => {
    const onCancel = mock();
    const panel = makePanel({
      tasks: [task({ taskId: 'bash-aaaaaaaa' })],
      selectedTaskId: 'bash-aaaaaaaa',
      onCancel,
    });
    panel.handleInput('\r');
    panel.handleInput('\u001B');
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe('TasksPanelComponent — Kitty CSI-u printable input', () => {
  const kitty = (ch: string): string => `\u001B[${String(ch.codePointAt(0) ?? 0)}u`;

  it('Kitty-encoded q invokes onCancel', () => {
    const onCancel = mock();
    makePanel({ onCancel }).handleInput(kitty('q'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Kitty-encoded r invokes onRefresh', () => {
    const onRefresh = mock();
    makePanel({ onRefresh }).handleInput(kitty('r'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('TasksPanelComponent — stop confirmation', () => {
  it('arms the stop on the first S and fires on the second', () => {
    const onStop = mock();
    const panel = makePanel({
      tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'running' })],
      selectedTaskId: 'bash-aaaaaaaa',
      onStop,
    });
    panel.handleInput('s');
    expect(strip(panel.render(120).join('\n'))).toContain('press S again to stop');
    expect(onStop).not.toHaveBeenCalled();
    panel.handleInput('s');
    expect(onStop).toHaveBeenCalledWith('bash-aaaaaaaa');
    expect(strip(panel.render(120).join('\n'))).not.toContain('press S again to stop');
  });

  it('cancels the armed stop when another key arrives', () => {
    const onStop = mock();
    const onRefresh = mock();
    const panel = makePanel({
      tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'running' })],
      selectedTaskId: 'bash-aaaaaaaa',
      onStop,
      onRefresh,
    });
    panel.handleInput('s');
    panel.handleInput('r');
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
    expect(strip(panel.render(120).join('\n'))).not.toContain('press S again to stop');
  });

  it('refuses to stop a task that already settled', () => {
    const onStop = mock();
    const onStopIgnored = mock();
    const panel = makePanel({
      tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'completed', exitCode: 0 })],
      selectedTaskId: 'bash-aaaaaaaa',
      onStop,
      onStopIgnored,
    });
    panel.handleInput('s');
    expect(onStopIgnored).toHaveBeenCalledWith('bash-aaaaaaaa', 'terminal');
    expect(onStop).not.toHaveBeenCalled();
  });
});

describe('TasksPanelComponent — setProps', () => {
  it('keeps the selection across prop updates when the task still exists', () => {
    const tasks = [
      task({ taskId: 'bash-aaaaaaaa', status: 'running' }),
      task({ taskId: 'bash-bbbbbbbb', status: 'running' }),
    ];
    const panel = makePanel({ tasks, selectedTaskId: 'bash-bbbbbbbb' });
    panel.setProps(
      makeProps({
        tasks: [...tasks, task({ taskId: 'bash-cccccccc', status: 'completed' })],
        selectedTaskId: 'bash-bbbbbbbb',
      }),
    );
    expect(strip(panel.render(120).join('\n'))).toContain('bash-bbbbbbbb');
  });
});

describe('TasksBrowserController — data sources', () => {
  function makeControllerHost(tasks: BackgroundTaskInfo[], store: SubagentActivityStore) {
    const ui = {
      children: [] as unknown[],
      clear() {
        this.children = [];
      },
      addChild(child: unknown) {
        this.children.push(child);
      },
      setFocus: () => {},
      requestRender: () => {},
    };
    const state = {
      tasksBrowser: undefined as unknown,
      terminal: { rows: 30 },
      ui,
      editor: {},
      appState: { availableModels: {} },
    };
    const host = {
      state,
      backgroundTasks: new Map(tasks.map((t) => [t.taskId, t])),
      sessionEventHandler: { subAgentEventHandler: { activityStore: store } },
      session: {
        listBackgroundTasks: async () => tasks,
        getBackgroundTaskOutput: async () => 'engine output',
        workDir: '/repo',
      },
      showError: mock(),
      setTasksBrowser(value: unknown) {
        state.tasksBrowser = value;
      },
    };
    return { host, state };
  }

  it('feeds the panel the engine output and the activity record separately', async () => {
    const store = new SubagentActivityStore();
    const info = task({
      taskId: 'agent-task-1',
      kind: 'agent',
      agentId: 'agent-1',
      status: 'running',
    } as Partial<BackgroundTaskInfo>);
    const { host, state } = makeControllerHost([info], store);
    store.ensureRecord({ agentId: 'agent-1', agentName: 'explore', parentToolCallId: 'tc-1' });
    const controller = new TasksBrowserController(host as never);
    await controller.show();

    const browser = state.tasksBrowser as {
      output?: string;
      component: { setProps: (props: unknown) => void };
    };
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(browser.output).toBe('engine output');
    controller.close();
  });
});
