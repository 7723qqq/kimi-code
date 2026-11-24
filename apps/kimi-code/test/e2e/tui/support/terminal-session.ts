import { setTimeout as delay } from 'node:timers/promises';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KIMI_REGION_PROFILES } from '@moonshot-ai/kimi-code-oauth';
import { VirtualTerminal } from '@moonshot-ai/pi-tui/testing';
import {
  createTestHome,
  kimiCliCommand,
  kimiCliEnv,
  kimiServiceStubs,
  NETWORK_GUARD_PRELOAD,
  networkGuardEnv,
  readNetworkViolations,
  until,
  writeKimiConfig,
  TIMEOUTS,
  type FetchStub,
  type TestHome,
} from '@moonshot-ai/testkit/fixtures';
import { fakeModelConfig, startFakeModel, type FakeModel } from '@moonshot-ai/testkit/model';

import { getFdAssetName } from '#/utils/process/fd-detect';

const ROOT_TSCONFIG = fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url));

export function cliFetchStubs(): FetchStub[] {
  const asset = getFdAssetName();
  const downloads = asset === null ? [] : Object.values(KIMI_REGION_PROFILES).map(({ cdnBase }) => ({
    method: 'GET',
    url: `${cdnBase}/fd/${asset}`,
    status: 404,
  }));
  return [...kimiServiceStubs(), ...downloads];
}

export const TURN_FINISHED = 'Worked for ';

export interface TerminalOptions {
  readonly columns?: number;
  readonly rows?: number;
}

const KEYS = {
  Enter: '\r',
  Escape: '\x1b',
  Tab: '\t',
  'Shift+Tab': '\x1b[Z',
  Backspace: '\x7f',
  Up: '\x1b[A',
  Down: '\x1b[B',
  Right: '\x1b[C',
  Left: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  'Ctrl+C': '\x03',
  'Ctrl+D': '\x04',
} as const;

export type TerminalKey = keyof typeof KEYS;

const ECHO_TAIL = 16;

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

export interface TerminalSession {
  readonly model: FakeModel;
  readonly modelName: string;
  viewport(): Promise<string>;
  scrollback(): Promise<string>;
  type(text: string): Promise<void>;
  paste(text: string): Promise<void>;
  press(key: TerminalKey): void;
  waitForText(text: string, timeout?: number): Promise<void>;
  waitForTextGone(text: string, timeout?: number): Promise<void>;
  waitForTurnToFinish(timeout?: number): Promise<void>;
  close(): Promise<void>;
}

export async function startTerminalSession(options: TerminalOptions = {}): Promise<TerminalSession> {
  const home = await createTestHome('kimi-tui-e2e');
  const model = await startFakeModel();
  const modelName = 'terminal-smoke-model';
  await writeKimiConfig(home.dataDir, {
    ...fakeModelConfig(model, { modelName }),
    extra: { auto_session_title: false },
  });
  const root = await realpath(home.workspace);
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ extends: ROOT_TSCONFIG }));

  const columns = options.columns ?? 100;
  const rows = options.rows ?? 36;
  const screen = new VirtualTerminal(columns, rows);
  const command = kimiCliCommand();
  const networkLog = join(home.root, 'network.log');
  const preload = (specifier: string): string => (specifier.startsWith('file:') ? fileURLToPath(specifier) : specifier);
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      ...(command.imports ?? []).flatMap((specifier) => ['--import', preload(specifier)]),
      '--import',
      preload(NETWORK_GUARD_PRELOAD.href),
      command.entry,
    ],
    cwd: root,
    env: {
      ...kimiCliEnv(home, {
        KIMI_CODE_TUI_FULL_SCREEN: '0',
        COLUMNS: String(columns),
        LINES: String(rows),
      }),
      ...command.env,
      ...networkGuardEnv(networkLog, cliFetchStubs()),
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let stdout = '';
  let stderr = '';
  const readStdout = (async () => {
    for await (const chunk of proc.stdout) {
      const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      stdout += text;
      screen.write(text);
    }
  })();
  const readStderr = (async () => {
    for await (const chunk of proc.stderr) {
      stderr += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    }
  })();
  screen.onReply((reply) => {
    void proc.stdin.write(reply);
    void proc.stdin.flush();
  });

  const inputs: string[] = [];
  const viewport = async (): Promise<string> => (await screen.flushAndGetViewport()).join('\n');
  const diagnostics = async (): Promise<string> => [
    `CLI exit=${String(proc.exitCode ?? null)}; recent input=${JSON.stringify(inputs)}`,
    `Screen:\n${await viewport()}`,
    `Stderr:\n${stderr}`,
    `Model requests: ${JSON.stringify(model.requests().map(({ index, lane, state }) => ({ index, lane, state })))}`,
  ].join('\n');
  const send = (input: string): void => {
    inputs.push(input.slice(-200));
    if (inputs.length > 12) inputs.shift();
    void proc.stdin.write(input);
    void proc.stdin.flush();
  };
  const waitFor = async (description: string, ready: (screen: string) => boolean, timeout = TIMEOUTS.frame): Promise<void> => {
    try {
      await until(description, async () => proc.exitCode !== null || ready(await viewport()), { timeoutMs: timeout });
      if (proc.exitCode !== null) throw new Error('CLI exited');
    } catch (cause) {
      throw new Error(`Waiting for ${description}\n${await diagnostics()}`, { cause });
    }
  };

  await waitFor(`the model name ${JSON.stringify(modelName)} to render`, (screen) => screen.includes(modelName), TIMEOUTS.server);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (proc.exitCode === null) {
      send('\x03\x1b[200~/exit\x1b[201~\r');
      const timeout = setTimeout(() => {
        proc.kill();
      }, TIMEOUTS.wait);
      try {
        await proc.exited;
      } finally {
        clearTimeout(timeout);
      }
    }
    await Promise.allSettled([readStdout, readStderr]);
    const blocked = await readNetworkViolations(networkLog, 'TUI child process');
    await model.close();
    await home.remove();
    if (blocked.length > 0) throw new Error(`TUI child network violations: ${JSON.stringify(blocked)}\n${await diagnostics()}`);
  };

  return {
    model,
    modelName,
    viewport,
    scrollback: async () => {
      await screen.flush();
      return screen.getScrollBuffer().join('\n');
    },
    type: async (text) => {
      const echo = text.length <= columns - 4 ? text : text.slice(-ECHO_TAIL);
      const before = occurrences(await viewport(), echo);
      for (const char of text) {
        send(char);
        await delay(20);
      }
      await waitFor(`the typed text ${JSON.stringify(echo)} to appear`, (screen) => occurrences(screen, echo) > before);
    },
    paste: (text) => {
      send(`\x1b[200~${text}\x1b[201~`);
      return Promise.resolve();
    },
    press: (key) => {
      send(KEYS[key]);
    },
    waitForText: (text, timeout) => waitFor(`${JSON.stringify(text)} to appear`, (screen) => screen.includes(text), timeout),
    waitForTextGone: (text, timeout) => waitFor(`${JSON.stringify(text)} to disappear`, (screen) => !screen.includes(text), timeout),
    waitForTurnToFinish: (timeout) => waitFor('the turn to finish', (screen) => screen.includes(TURN_FINISHED), timeout),
    close,
  };
}

export async function withTerminal(
  options: TerminalOptions,
  run: (terminal: TerminalSession) => Promise<void>,
): Promise<void> {
  const terminal = await startTerminalSession(options);
  try {
    await run(terminal);
  } finally {
    await terminal.close();
  }
}

