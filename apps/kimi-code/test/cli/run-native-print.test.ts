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

  it('initializes native harness, sends prompt and closes harness cleanly', async () => {
    let stdoutBuffer = '';
    const mockStdout = {
      write: (chunk: string) => {
        stdoutBuffer += chunk;
        return true;
      },
    };

    let stderrBuffer = '';
    const mockStderr = {
      write: (chunk: string) => {
        stderrBuffer += chunk;
        return true;
      },
    };
    const mockProcess = {
      exit: vi.fn(),
    };

    let eventCallback: ((event: any) => void) | undefined;
    mockSession.onEvent.mockImplementation((cb: any) => {
      eventCallback = cb;
    });

    mockSession.prompt.mockImplementation(async () => {
      if (eventCallback) {
        eventCallback({ type: 'assistant.delta', delta: 'Native Hello World' });
      }
    });

    const opts = makeOpts();
    await runNativePrint(opts, '0.1.0-test', {
      stdout: mockStdout as any,
      stderr: mockStderr as any,
      process: mockProcess as any,
    });

    if (mockProcess.exit.mock.calls.length > 0) {
      throw new Error(`Unexpected exit called, stderr: ${stderrBuffer}`);
    }

    expect(mockHarness.createSession).toHaveBeenCalled();
    expect(mockSession.setModel).toHaveBeenCalledWith('test-model');
    expect(mockSession.prompt).toHaveBeenCalledWith('Hello Native Print');
    expect(mockHarness.close).toHaveBeenCalled();
    expect(stdoutBuffer).toContain('Native Hello World');
  });
});
