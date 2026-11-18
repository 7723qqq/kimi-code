import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configureDiagnosticLogging, flushDiagnosticLogs } from '@moonshot-ai/kimi-code-sdk';
import { ProcessTerminal, Text, TuiAltScreen, TuiMainScreen } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { DiagnosticTerminal } from '#/tui/utils/diagnostic-terminal';

import { VirtualTerminal } from '../../../../packages/pi-tui/test/virtual-terminal';

const dirs: string[] = [];
const terminals: DiagnosticTerminal[] = [];

afterEach(async () => {
  for (const terminal of terminals.splice(0)) terminal.stop();
  await flushDiagnosticLogs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function configureLog(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-tui-diagnostics-'));
  dirs.push(dir);
  await configureDiagnosticLogging({ homeDir: dir, env: { KIMI_LOG_LEVEL: 'debug' } });
  return join(dir, 'logs', 'kimi-code.log');
}

function terminalWithScreen(screen = new VirtualTerminal(80, 20)): DiagnosticTerminal {
  const terminal = new DiagnosticTerminal();
  terminals.push(terminal);
  spyOn(ProcessTerminal.prototype, 'start').mockImplementation((input, resize) => {
    screen.start(input, resize);
  });
  spyOn(ProcessTerminal.prototype, 'stop').mockImplementation(() => screen.stop());
  spyOn(ProcessTerminal.prototype, 'write').mockImplementation((text) => screen.write(text));
  return terminal;
}

describe('DiagnosticTerminal', () => {
  afterEach(() => {
    for (const terminal of terminals.splice(0)) terminal.stop();
    spyOn(ProcessTerminal.prototype, 'start').mockRestore();
    spyOn(ProcessTerminal.prototype, 'stop').mockRestore();
    spyOn(ProcessTerminal.prototype, 'write').mockRestore();
  });

  it.each(['regular', 'fullscreen'] as const)(
    'keeps a multi-line lock error out of the %s screen and preserves the next redraw',
    async (mode) => {
      const logPath = await configureLog();
      const screen = new VirtualTerminal(80, 20);
      const terminal = terminalWithScreen(screen);
      const ui = mode === 'fullscreen' ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
      const content = new Text('Compaction complete\nPrompt > draft remains', 0, 0);
      ui.addChild(content);
      ui.start();
      try {
        ui.renderNow();
        await screen.flush();
        const before = screen.getViewport();
        const cursor = screen.getCursorPosition();
        const error = Object.assign(new Error('database is locked by another process'), {
          code: 'ELOCKED',
        });
        error.stack =
          'LockError: database is locked by another process\n    at openMiniDb (example.ts:211:9)';
        console.error('[unexpected]', error);
        await screen.flush();
        expect(screen.getViewport()).toEqual(before);
        expect(screen.getCursorPosition()).toEqual(cursor);

        content.setText('Compaction complete\nPrompt > updated draft');
        ui.renderNow();
        await screen.flush();
        const text = screen.getViewport().join('\n');
        expect(text).toContain('updated draft');
        expect(text).not.toContain('LockError');
        expect(text).not.toContain('openMiniDb');
        await flushDiagnosticLogs();
        const logged = await readFile(logPath, 'utf8');
        expect(logged).toContain('database is locked by another process');
        expect(logged).toContain('openMiniDb');
        expect(logged).toContain('ELOCKED');
      } finally {
        ui.stop();
      }
    },
  );

  it('captures console diagnostics and stderr while leaving stdout terminal commands intact', async () => {
    const logPath = await configureLog();
    const terminal = terminalWithScreen();
    const stderr: string[] = [];
    const stdout: string[] = [];
    const errSpy = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    const outSpy = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    const originalWarn = console.warn;
    const originalWrite = process.stderr.write;
    const notices: string[] = [];
    terminal.onDiagnostic = (message) => notices.push(message);
    terminal.start(
      () => {},
      () => {},
    );
    try {
      console.warn('configuration warning');
      console.log('telemetry diagnostic');
      console.info('information');
      console.debug('debug diagnostic');
      process.stderr.write('[cron/session] scheduled\n');
      let called = false;
      process.stderr.write(Buffer.from('byte diagnostic'), () => {
        called = true;
      });
      process.stdout.write('\u001b]11;?\u0007');
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(called).toBe(true);
      expect(stderr).toEqual([]);
      expect(stdout).toEqual(['\u001b]11;?\u0007']);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toBe(t('tui.statusMessages.diagnosticsCaptured'));
      await flushDiagnosticLogs();
      const logged = await readFile(logPath, 'utf8');
      for (const value of [
        'configuration warning',
        'telemetry diagnostic',
        'information',
        'debug diagnostic',
        'scheduled',
        'byte diagnostic',
      ]) {
        expect(logged).toContain(value);
      }
      terminal.stop();
      expect(console.warn).toBe(originalWarn);
      expect(process.stderr.write).toBe(originalWrite);
      process.stderr.write('foreground output');
      expect(stderr).toEqual(['foreground output']);
    } finally {
      terminal.stop();
      errSpy.mockRestore();
      outSpy.mockRestore();
    }
  });

  it('restores diagnostics after a failed terminal start and captures them again after resume', () => {
    const terminal = terminalWithScreen();
    const originalError = console.error;
    const originalWrite = process.stderr.write;
    const startSpy = spyOn(ProcessTerminal.prototype, 'start').mockImplementationOnce(() => {
      throw new Error('terminal startup failed');
    });
    expect(() =>
      terminal.start(
        () => {},
        () => {},
      ),
    ).toThrow('terminal startup failed');
    expect(console.error).toBe(originalError);
    expect(process.stderr.write).toBe(originalWrite);
    startSpy.mockImplementation(() => {});
    terminal.start(
      () => {},
      () => {},
    );
    terminal.start(
      () => {},
      () => {},
    );
    terminal.stop();
    expect(console.error).toBe(originalError);
    terminal.start(
      () => {},
      () => {},
    );
    expect(console.error).not.toBe(originalError);
    terminal.stop();
    expect(console.error).toBe(originalError);
  });

  it('restores global output after overlapping terminal lifetimes stop out of order', async () => {
    await configureLog();
    const first = terminalWithScreen();
    const second = terminalWithScreen();
    const originalError = console.error;
    const originalWrite = process.stderr.write;
    const firstNotices: string[] = [];
    const secondNotices: string[] = [];
    first.onDiagnostic = (message) => firstNotices.push(message);
    second.onDiagnostic = (message) => secondNotices.push(message);
    first.start(
      () => {},
      () => {},
    );
    second.start(
      () => {},
      () => {},
    );
    first.stop();
    console.error('diagnostic from the active terminal');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(firstNotices).toEqual([]);
    expect(secondNotices).toHaveLength(1);
    second.stop();
    expect(console.error).toBe(originalError);
    expect(process.stderr.write).toBe(originalWrite);
  });

  it('redacts diagnostic secrets and does not recurse when its notice callback logs', async () => {
    const logPath = await configureLog();
    const terminal = terminalWithScreen();
    const notices: string[] = [];
    terminal.onDiagnostic = (message) => {
      notices.push(message);
      if (notices.length < 3) console.warn('notice callback diagnostic');
    };
    terminal.start(
      () => {},
      () => {},
    );
    try {
      console.error('request diagnostic', { token: 'fixture-value-do-not-record' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(notices).toHaveLength(1);
      await flushDiagnosticLogs();
      const logged = await readFile(logPath, 'utf8');
      expect(logged).toContain('[REDACTED]');
      expect(logged).not.toContain('fixture-value-do-not-record');
      expect(logged).toContain('notice callback diagnostic');
    } finally {
      terminal.stop();
    }
  });

  it('reports a failed log sink without recursively sending its failure back to the sink', async () => {
    const logPath = await configureLog();
    await mkdir(join(logPath, 'blocked'), { recursive: true });
    await writeFile(join(logPath, 'blocked', 'marker'), 'blocked');
    const terminal = terminalWithScreen();
    const notices: string[] = [];
    const stderr: string[] = [];
    const errSpy = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    terminal.onDiagnostic = (message) => notices.push(message);
    terminal.start(
      () => {},
      () => {},
    );
    try {
      console.error(new Error('error while logging is unavailable'));
      expect(await flushDiagnosticLogs()).toBe(false);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(stderr).toEqual([]);
      expect(notices).toContain(t('tui.statusMessages.diagnosticLogUnavailable'));
      expect(notices.length).toBeLessThanOrEqual(2);
    } finally {
      terminal.stop();
      errSpy.mockRestore();
      await rm(logPath, { recursive: true, force: true });
      await flushDiagnosticLogs();
    }
  });
});
