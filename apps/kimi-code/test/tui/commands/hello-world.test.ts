import { describe, expect, it, mock, type Mock } from 'bun:test';
import { waitForAssertion } from '#test/helpers/waitFor';

import { handleHelloWorldCommand } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { currentTheme } from '#/tui/theme';
import { permissionModeDescription } from '#/tui/utils/permission-mode';

const ENTER = '\r';
const ESCAPE = '\u001B';
const UP = '\u001B[A';
const DOWN = '\u001B[B';

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

interface TestComponent {
  render(width: number): string[];
}

interface HelloWorldRunFixture {
  stage: string;
  task?: string;
  items: { id: string; done: boolean; evidence?: string }[];
  waivers: string[];
}

function makeHost(
  overrides: {
    model?: string;
    hasSession?: boolean;
    permissionMode?: 'manual' | 'auto' | 'yolo';
    helloWorldMode?: boolean;
    /** The engine refuses the switch, so status never reflects the request. */
    engineRefuses?: boolean;
    /** Run snapshot returned by `getStatus`; absent means no active run. */
    helloWorldRun?: HelloWorldRunFixture;
  } = {},
) {
  let engineMode = overrides.helloWorldMode ?? false;
  const session = {
    setPermission: mock(async () => {}),
    setHelloWorldMode: mock(async (enabled: boolean) => {
      if (!overrides.engineRefuses) engineMode = enabled;
    }),
    setHelloWorldStage: mock(async () => {}),
    waiveHelloWorldItem: mock(async () => {}),
    getStatus: mock(async () => ({
      helloWorldMode: engineMode,
      helloWorldStage: overrides.helloWorldRun?.stage,
      helloWorldRun: overrides.helloWorldRun,
    })),
  };
  const hasSession = overrides.hasSession ?? true;
  const host = {
    state: {
      appState: {
        model: overrides.model ?? 'kimi-model',
        permissionMode: overrides.permissionMode ?? 'auto',
        helloWorldMode: overrides.helloWorldMode ?? false,
      },
      theme: currentTheme,
      transcriptContainer: { addChild: mock() },
      ui: { requestRender: mock() },
    },
    session: hasSession ? session : undefined,
    requireSession: () => session,
    setAppState: mock((patch: Record<string, unknown>) => Object.assign(host.state.appState, patch)),
    showError: mock(),
    showNotice: mock(),
    showStatus: mock(),
    appendTranscriptEntry: mock(),
    mountEditorReplacement: mock(),
    restoreEditor: mock(),
    restoreInputText: mock(),
    sendNormalUserInput: mock(),
  } as unknown as SlashCommandHost;
  return { host, session };
}

interface TestPicker {
  handleInput(data: string): void;
  render(width: number): string[];
}

function mountedPicker(host: SlashCommandHost): TestPicker {
  const mock = host.mountEditorReplacement as Mock<(...args: any[]) => any>;
  return mock.mock.calls[0]?.[0] as TestPicker;
}

function markerAddChild(host: SlashCommandHost): Mock<(...args: any[]) => any> {
  return host.appendTranscriptEntry as Mock<(...args: any[]) => any>;
}

function expectHelloWorldMarker(host: SlashCommandHost, text: string): void {
  const components = markerAddChild(host).mock.calls.map(
    ([, component]) => component as TestComponent,
  );
  const rendered = stripAnsi(components.at(-1)?.render(80).join('\n') ?? '');
  expect(rendered).toContain(text);
}

describe('handleHelloWorldCommand', () => {
  it('sends the task as a normal prompt after enabling hello-world mode', async () => {
    const { host, session } = makeHost({ permissionMode: 'auto' });

    await handleHelloWorldCommand(host, 'Ship feature X');

    expect(session.setPermission).not.toHaveBeenCalled();
    expect(session.setHelloWorldMode).toHaveBeenCalledWith(true, 'task', 'Ship feature X');
    expect(host.state.helloWorldModeEntry).toBe('task');
    expectHelloWorldMarker(host, 'Hello-world activated');
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('sends the task without re-entering hello-world mode when already on', async () => {
    const { host, session } = makeHost({ permissionMode: 'auto', helloWorldMode: true });

    await handleHelloWorldCommand(host, 'Ship feature X');

    expect(session.setHelloWorldMode).not.toHaveBeenCalled();
    expect(host.state.helloWorldModeEntry).toBeUndefined();
    expectHelloWorldMarker(host, 'Hello-world activated');
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('turns hello-world mode on without sending a prompt', async () => {
    const { host, session } = makeHost({ model: '' });

    await handleHelloWorldCommand(host, 'on');

    expect(session.setHelloWorldMode).toHaveBeenCalledWith(true, 'manual', undefined);
    expect(host.setAppState).toHaveBeenCalledWith({ helloWorldMode: true });
    expect(host.state.helloWorldModeEntry).toBe('manual');
    expectHelloWorldMarker(host, 'Hello-world activated');
    expect(host.showStatus).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('asks before turning hello-world mode on in Manual mode', async () => {
    const { host, session } = makeHost({ model: '', permissionMode: 'manual' });

    await handleHelloWorldCommand(host, 'on');

    expect(session.setHelloWorldMode).not.toHaveBeenCalled();
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.mountEditorReplacement).toHaveBeenCalledTimes(1);
    expect(session.setPermission).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    const text = stripAnsi(mountedPicker(host).render(80).join('\n'));
    expect(text).toContain('Always Ask mode can block hello-world work');
    const picker = mountedPicker(host);
    picker.handleInput(UP);
    picker.handleInput(UP);
    picker.handleInput(ENTER);

    await waitForAssertion(() => {
      expect(session.setHelloWorldMode).toHaveBeenCalledWith(true, 'manual', undefined);
    });
    expect(session.setPermission).toHaveBeenCalledWith('auto');
    expect(session.setHelloWorldMode).toHaveBeenCalledTimes(1);
    expect(host.setAppState).toHaveBeenCalledWith({ permissionMode: 'auto' });
    expect(host.setAppState).toHaveBeenCalledWith({ helloWorldMode: true });
    expect(host.state.helloWorldModeEntry).toBe('manual');
    expectHelloWorldMarker(host, 'Hello-world activated');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('turns hello-world mode on when called without args while the mode is off', async () => {
    const { host, session } = makeHost({ model: '', helloWorldMode: false });

    await handleHelloWorldCommand(host, '');

    expect(session.setHelloWorldMode).toHaveBeenCalledWith(true, 'manual', undefined);
    expect(host.setAppState).toHaveBeenCalledWith({ helloWorldMode: true });
    expect(host.state.helloWorldModeEntry).toBe('manual');
    expectHelloWorldMarker(host, 'Hello-world activated');
    expect(host.showError).not.toHaveBeenCalled();
    expect(host.showStatus).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('does not call the session when hello-world mode is already on', async () => {
    const { host, session } = makeHost({ model: '', helloWorldMode: true });

    await handleHelloWorldCommand(host, 'on');

    expect(session.setHelloWorldMode).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalledWith({ helloWorldMode: true });
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Hello-world mode is already on.');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('turns hello-world mode off without sending a prompt', async () => {
    const { host, session } = makeHost({ model: '', helloWorldMode: true });

    await handleHelloWorldCommand(host, 'off');

    expect(session.setHelloWorldMode).toHaveBeenCalledWith(false, 'manual', undefined);
    expect(host.setAppState).toHaveBeenCalledWith({ helloWorldMode: false });
    expect(host.state.helloWorldModeEntry).toBeUndefined();
    expectHelloWorldMarker(host, 'Hello-world deactivated');
    expect(host.showStatus).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('turns hello-world mode off when called without args while the mode is on', async () => {
    const { host, session } = makeHost({ model: '', helloWorldMode: true });

    await handleHelloWorldCommand(host, '');

    expect(session.setHelloWorldMode).toHaveBeenCalledWith(false, 'manual', undefined);
    expect(host.setAppState).toHaveBeenCalledWith({ helloWorldMode: false });
    expect(host.state.helloWorldModeEntry).toBeUndefined();
    expectHelloWorldMarker(host, 'Hello-world deactivated');
    expect(host.showError).not.toHaveBeenCalled();
    expect(host.showStatus).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('does not call the session when hello-world mode is already off', async () => {
    const { host, session } = makeHost({ model: '', helloWorldMode: false });

    await handleHelloWorldCommand(host, 'off');

    expect(session.setHelloWorldMode).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalledWith({ helloWorldMode: false });
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Hello-world mode is already off.');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('asks before starting a task in Manual mode', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });

    await handleHelloWorldCommand(host, 'Ship feature X');

    expect(session.setHelloWorldMode).not.toHaveBeenCalled();
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.mountEditorReplacement).toHaveBeenCalledTimes(1);
    expect(session.setPermission).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    const text = stripAnsi(mountedPicker(host).render(80).join('\n'));
    expect(text).toContain('Always Ask mode can block hello-world work');
    expect(text).toContain('Switch to Ask When Needed and start');
    expect(text).not.toContain('Do not start');
  });

  it('keeps Always Ask when confirming a Manual-mode start', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });

    await handleHelloWorldCommand(host, 'Ship feature X');
    mountedPicker(host).handleInput(ENTER);

    await waitForAssertion(() => {
      expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
    });
    expect(session.setPermission).not.toHaveBeenCalled();
    expect(session.setHelloWorldMode).toHaveBeenCalledWith(true, 'task', 'Ship feature X');
    expect(session.setHelloWorldMode).toHaveBeenCalledTimes(1);
    expect(host.setAppState).not.toHaveBeenCalledWith({ permissionMode: 'auto' });
    expect(host.setAppState).toHaveBeenCalledWith({ helloWorldMode: true });
    expect(host.state.helloWorldModeEntry).toBe('task');
    expectHelloWorldMarker(host, 'Hello-world activated');
  });

  it('still switches to Auto when the cursor is moved there first', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });

    await handleHelloWorldCommand(host, 'Ship feature X');
    const picker = mountedPicker(host);
    picker.handleInput(UP);
    picker.handleInput(UP);
    picker.handleInput(ENTER);

    await waitForAssertion(() => {
      expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
    });
    expect(session.setPermission).toHaveBeenCalledWith('auto');
    expect(host.showNotice).toHaveBeenCalledWith('Permission mode: Never Ask');
    expectHelloWorldMarker(host, 'Hello-world activated');
  });

  it('can start a Manual-mode task after switching to YOLO', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });

    await handleHelloWorldCommand(host, 'Ship feature X');
    const picker = mountedPicker(host);
    picker.handleInput(UP);
    picker.handleInput(ENTER);

    await waitForAssertion(() => {
      expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
    });
    expect(session.setPermission).toHaveBeenCalledWith('yolo');
    expect(session.setHelloWorldMode).toHaveBeenCalledWith(true, 'task', 'Ship feature X');
    expect(session.setHelloWorldMode).toHaveBeenCalledTimes(1);
    expect(host.setAppState).toHaveBeenCalledWith({ permissionMode: 'yolo' });
    expect(host.setAppState).toHaveBeenCalledWith({ helloWorldMode: true });
    expect(host.showNotice).toHaveBeenCalledWith('Permission mode: Ask When Needed');
    expect(host.showStatus).toHaveBeenCalledWith(permissionModeDescription('yolo'), 'warning');
    expect(host.state.helloWorldModeEntry).toBe('task');
    expectHelloWorldMarker(host, 'Hello-world activated');
  });

  it('returns the command to the input box when a Manual-mode start is cancelled', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });

    await handleHelloWorldCommand(host, 'Ship feature X');
    mountedPicker(host).handleInput(ESCAPE);

    expect(host.restoreInputText).toHaveBeenCalledWith('/hello-world Ship feature X');
    expect(host.showStatus).toHaveBeenCalledWith('Hello-world task not started.');
    expect(session.setPermission).not.toHaveBeenCalled();
    expect(session.setHelloWorldMode).not.toHaveBeenCalled();
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('does not start when permission update fails', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });
    session.setPermission.mockRejectedValueOnce(new Error('denied'));

    await handleHelloWorldCommand(host, 'Ship feature X');
    const picker = mountedPicker(host);
    picker.handleInput(UP);
    picker.handleInput(UP);
    picker.handleInput(ENTER);

    await waitForAssertion(() => {
      expect(host.showError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to set permission mode'),
      );
    });
    expect(session.setHelloWorldMode).not.toHaveBeenCalled();
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('does not send a prompt when enabling hello-world mode fails', async () => {
    const { host, session } = makeHost({ permissionMode: 'auto' });
    session.setHelloWorldMode.mockRejectedValueOnce(new Error('denied'));

    await handleHelloWorldCommand(host, 'Ship feature X');

    expect(host.showError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to enable hello-world mode'),
    );
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('reports an error when the engine refuses to enable hello-world mode', async () => {
    const { host } = makeHost({ model: '', engineRefuses: true });

    await handleHelloWorldCommand(host, 'on');

    // The engine stayed off, so claiming success would desync the footer.
    expect(host.showError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to enable hello-world mode'),
    );
    expect(host.state.appState.helloWorldMode).toBe(false);
  });

  it('reports an error when the engine refuses to disable hello-world mode', async () => {
    const { host } = makeHost({ model: '', helloWorldMode: true, engineRefuses: true });

    await handleHelloWorldCommand(host, 'off');

    expect(host.showError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to disable hello-world mode'),
    );
    expect(host.state.appState.helloWorldMode).toBe(true);
  });
});

const openRun: HelloWorldRunFixture = {
  stage: 'design',
  task: 'Ship feature X',
  items: [
    { id: 'requirements-approved', done: true, evidence: 'specs/foo/requirements.md' },
    { id: 'design-written', done: false },
    { id: 'tests-green', done: true, evidence: 'waived' },
  ],
  waivers: ['tests-green'],
};

const completeRun: HelloWorldRunFixture = {
  ...openRun,
  items: openRun.items.map((item) => ({ ...item, done: true })),
};

describe('handleHelloWorldCommand run subcommands', () => {
  it('renders the run panel for status', async () => {
    const { host } = makeHost({ model: '', helloWorldMode: true, helloWorldRun: openRun });

    await handleHelloWorldCommand(host, 'status');

    expect(host.showStatus).not.toHaveBeenCalled();
    expect(host.showError).not.toHaveBeenCalled();
    const components = markerAddChild(host).mock.calls.map(([, component]) => component as TestComponent);
    const rendered = stripAnsi(components.at(-1)?.render(80).join('\n') ?? '');
    expect(rendered).toContain('design');
    expect(rendered).toContain('Ship feature X');
    expect(rendered).toContain('requirements-approved');
    expect(rendered).toContain('specs/foo/requirements.md');
    expect(rendered).toContain('design-written');
    expect(rendered).toContain('tests-green');
    expect(rendered).toContain('waived');
  });

  it('reports when status has no active run', async () => {
    const { host } = makeHost({ model: '' });

    await handleHelloWorldCommand(host, 'status');

    expect(host.showStatus).toHaveBeenCalledWith('No active hello-world run.');
    expect(markerAddChild(host)).not.toHaveBeenCalled();
  });

  it('advances the run with next and syncs the stage into appState', async () => {
    const { host, session } = makeHost({
      model: '',
      helloWorldMode: true,
      helloWorldRun: openRun,
    });

    await handleHelloWorldCommand(host, 'next');

    expect(session.setHelloWorldStage).toHaveBeenCalledWith('next');
    expect(host.setAppState).toHaveBeenCalledWith({ helloWorldStage: 'design' });
  });

  it('sets a specific stage with phase and syncs the stage into appState', async () => {
    const { host, session } = makeHost({
      model: '',
      helloWorldMode: true,
      helloWorldRun: openRun,
    });

    await handleHelloWorldCommand(host, 'phase Test');

    expect(session.setHelloWorldStage).toHaveBeenCalledWith('test');
    expect(host.setAppState).toHaveBeenCalledWith({ helloWorldStage: 'design' });
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('rejects an unknown stage name without calling the session', async () => {
    const { host, session } = makeHost({ model: '', helloWorldMode: true });

    await handleHelloWorldCommand(host, 'phase bogus');

    expect(host.showError).toHaveBeenCalledWith(
      expect.stringContaining('Unknown stage "bogus"'),
    );
    expect(session.setHelloWorldStage).not.toHaveBeenCalled();
  });

  it('shows the phase usage when the stage is missing', async () => {
    const { host, session } = makeHost({ model: '', helloWorldMode: true });

    await handleHelloWorldCommand(host, 'phase');

    expect(host.showError).toHaveBeenCalledWith('Usage: /hello-world phase <stage>');
    expect(session.setHelloWorldStage).not.toHaveBeenCalled();
  });

  it('waives a checklist item with skip and syncs the stage into appState', async () => {
    const { host, session } = makeHost({
      model: '',
      helloWorldMode: true,
      helloWorldRun: openRun,
    });

    await handleHelloWorldCommand(host, 'skip tests-green');

    expect(session.waiveHelloWorldItem).toHaveBeenCalledWith('tests-green');
    expect(host.setAppState).toHaveBeenCalledWith({ helloWorldStage: 'design' });
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('rejects an unknown item name without calling the session', async () => {
    const { host, session } = makeHost({ model: '', helloWorldMode: true });

    await handleHelloWorldCommand(host, 'skip bogus');

    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('Unknown item "bogus"'));
    expect(session.waiveHelloWorldItem).not.toHaveBeenCalled();
  });

  it('shows the skip usage when the item is missing', async () => {
    const { host, session } = makeHost({ model: '', helloWorldMode: true });

    await handleHelloWorldCommand(host, 'skip');

    expect(host.showError).toHaveBeenCalledWith('Usage: /hello-world skip <item>');
    expect(session.waiveHelloWorldItem).not.toHaveBeenCalled();
  });

  it('warns about open items before turning the mode off', async () => {
    const { host, session } = makeHost({
      model: '',
      helloWorldMode: true,
      helloWorldRun: openRun,
    });

    await handleHelloWorldCommand(host, 'off');

    expect(host.showStatus).toHaveBeenCalledWith(
      'Hello-world open items: design-written',
      'warning',
    );
    expect(session.setHelloWorldMode).toHaveBeenCalledWith(false, 'manual', undefined);
    expect(host.state.helloWorldModeEntry).toBeUndefined();
  });

  it('does not warn on off when every run item is done', async () => {
    const { host, session } = makeHost({
      model: '',
      helloWorldMode: true,
      helloWorldRun: completeRun,
    });

    await handleHelloWorldCommand(host, 'off');

    expect(host.showStatus).not.toHaveBeenCalled();
    expect(session.setHelloWorldMode).toHaveBeenCalledWith(false, 'manual', undefined);
  });
});
