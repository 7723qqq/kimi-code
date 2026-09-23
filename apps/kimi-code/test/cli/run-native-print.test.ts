import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { runNativePrint } from '../../src/cli/run-native-print';
import type { CLIOptions } from '../../src/cli/options';

const mockSession = {
  sessionId: 'sess-native-print-1',
  onEvent: vi.fn(),
  events: vi.fn(),
  prompt: vi.fn(async () => {}),
  setModel: vi.fn(async () => {}),
};

const mockHarness = {
  createSession: vi.fn(async () => mockSession),
  resumeSession: vi.fn(async () => mockSession),
  close: vi.fn(async () => {}),
};

vi.mock('@moonshot-ai/kimi-code-sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    createKimiHarnessNative: vi.fn(() => mockHarness),
    resolveKimiHome: vi.fn(() => '/mock/kimi-home'),
  };
});

vi.mock('../../src/cli/telemetry', () => ({
  createCliTelemetryBootstrap: vi.fn(() => ({ homeDir: '/mock/kimi-home' })),
}));

describe('runNativePrint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeOpts(overrides: Partial<CLIOptions> = {}): CLIOptions {
    return {
      session: undefined,
      continue: false,
      yolo: true,
      auto: false,
      plan: false,
      model: 'test-model',
      outputFormat: 'text',
      prompt: 'Hello Native Print',
      skillsDirs: [],
      agent: undefined,
      agentFiles: [],
      addDirs: [],
      ...overrides,
    };
  }

  function startPrint(overrides: Partial<CLIOptions> = {}) {
    let stdoutBuffer = '';
    let stderrBuffer = '';
    const mockStdout = {
      write: (chunk: string) => {
        stdoutBuffer += chunk;
        return true;
      },
    };
    const mockStderr = {
      write: (chunk: string) => {
        stderrBuffer += chunk;
        return true;
      },
    };
    const mockProcess = { exit: vi.fn() };
    let eventCallback: ((event: any) => void) | undefined;
    mockSession.onEvent.mockImplementation((cb: any) => {
      eventCallback = cb;
    });
    return {
      mockProcess,
      emit: (event: any) => eventCallback?.(event),
      stdout: () => stdoutBuffer,
      stderr: () => stderrBuffer,
      run: () =>
        runNativePrint(makeOpts(overrides), '0.1.0-test', {
          stdout: mockStdout as any,
          stderr: mockStderr as any,
          process: mockProcess as any,
        }),
    };
  }

  it('initializes native harness, sends prompt and closes harness cleanly', async () => {
    const print = startPrint();

    mockSession.prompt.mockImplementation(() => {
      print.emit({ type: 'assistant.delta', delta: 'Native Hello World' });
      // The native engine settles the turn asynchronously after the
      // submission resolves; the runner must wait for turn.ended.
      setTimeout(() => print.emit({ type: 'turn.ended', reason: 'completed' }), 5);
      return Promise.resolve();
    });

    await print.run();

    if (print.mockProcess.exit.mock.calls.length > 0) {
      throw new Error(`Unexpected exit called, stderr: ${print.stderr()}`);
    }

    expect(mockHarness.createSession).toHaveBeenCalled();
    expect(mockSession.setModel).toHaveBeenCalledWith('test-model');
    expect(mockSession.prompt).toHaveBeenCalledWith('Hello Native Print');
    expect(mockHarness.close).toHaveBeenCalled();
    expect(print.stdout()).toContain('Native Hello World');
  });

  it('surfaces a failed turn as an error and a non-zero exit', async () => {
    const print = startPrint();

    mockSession.prompt.mockImplementation(() => {
      setTimeout(
        () =>
          print.emit({
            type: 'turn.ended',
            reason: 'failed',
            error: { message: 'llm http status 403 FreeTierError' },
          }),
        5,
      );
      return Promise.resolve();
    });

    await print.run();

    expect(print.stderr()).toContain('[Error]: llm http status 403 FreeTierError');
    expect(print.mockProcess.exit).toHaveBeenCalledWith(1);
    expect(mockHarness.close).toHaveBeenCalled();
  });

  it('resumes the requested session instead of creating a new one', async () => {
    const print = startPrint({ session: 'sess-existing' });

    mockSession.prompt.mockImplementation(() => {
      setTimeout(() => print.emit({ type: 'turn.ended', reason: 'completed' }), 5);
      return Promise.resolve();
    });

    await print.run();

    expect(mockHarness.resumeSession).toHaveBeenCalledWith({ id: 'sess-existing' });
    expect(mockHarness.createSession).not.toHaveBeenCalled();
    expect(print.mockProcess.exit).not.toHaveBeenCalled();
  });

  // A --session that cannot be resumed must not silently become a fresh, empty
  // session: the run would answer without the requested conversation's context
  // and look like it succeeded. The TUI reports the same failure.
  it('fails the run when the requested session cannot be resumed', async () => {
    const print = startPrint({ session: 'bad/id' });
    mockHarness.resumeSession.mockRejectedValueOnce(new Error('invalid session id "bad/id"'));

    await print.run();

    expect(mockHarness.createSession).not.toHaveBeenCalled();
    expect(print.stderr()).toContain('[Error]: invalid session id "bad/id"');
    expect(print.mockProcess.exit).toHaveBeenCalledWith(1);
    expect(mockHarness.close).toHaveBeenCalled();
  });
});
