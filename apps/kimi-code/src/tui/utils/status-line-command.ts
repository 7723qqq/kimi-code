/**
 * User-provided status line command (`status_line.command` in tui.toml).
 *
 * The footer spawns the command with a JSON snapshot on stdin and renders the
 * first stdout line. Runs are throttled and time-boxed; any failure (spawn
 * error, nonzero exit, timeout) yields null so the caller falls back to the
 * built-in layout. Mirrors Claude Code's statusLine contract at the seam:
 * JSON in, first line out, 300ms ceiling.
 */

export const STATUS_LINE_COMMAND_TIMEOUT_MS = 300;
export const STATUS_LINE_RERUN_INTERVAL_MS = 1_000;
export const STATUS_LINE_MAX_CAPTURE_BYTES = 65_536;

export interface StatusLinePayload {
  model: string;
  cwd: string;
  gitBranch: string | null;
  permissionMode: string;
  planMode: boolean;
  specMode: boolean;
  swarmMode: boolean;
  helloWorldMode: boolean;
  towerMode: boolean;
  contextUsage: number;
  contextTokens: number;
  maxContextTokens: number;
  sessionId: string;
  version: string;
}

export function runStatusLineCommand(
  command: string,
  payload: StatusLinePayload,
  timeoutMs: number = STATUS_LINE_COMMAND_TIMEOUT_MS,
): Promise<string | null> {
  return (async () => {
    const isWin = process.platform === 'win32';
    let proc;
    try {
      proc = Bun.spawn({
        cmd: isWin
          ? [process.env['ComSpec'] ?? 'cmd.exe', '/d', '/s', '/c', command]
          : ['sh', '-c', command],
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'ignore',
        env: { ...process.env, KIMI_CODE_STATUS_LINE: '1' },
        // Own process group on POSIX so a timeout can drop the whole tree,
        // not just the shell wrapper.
        detached: !isWin,
        windowsVerbatimArguments: isWin,
      });
    } catch {
      return null;
    }

    const killTree = (): void => {
      const pid = proc.pid;
      if (pid === undefined) return;
      if (isWin) {
        try {
          Bun.spawn({ cmd: ['taskkill', '/pid', String(pid), '/T', '/F'], stdio: ['ignore', 'ignore', 'ignore'] });
        } catch {
          // best effort
        }
      } else {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          proc.kill('SIGKILL');
        }
      }
    };

    const decoder = new TextDecoder();
    let stdout = '';
    let timedOut = false;
    let onTimeoutElapsed: () => void = () => {};
    const timeoutElapsed = new Promise<null>((resolve) => {
      onTimeoutElapsed = () => resolve(null);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      onTimeoutElapsed();
    }, timeoutMs);
    timer.unref?.();

    // The command is expected to read stdin to EOF, so close it once written.
    // A command that exits without reading it (`true`) makes the write fail;
    // that is not an error, its exit code decides.
    try {
      // Bun's FileSink returns promises for write/flush; a command that exits
      // without reading stdin (`true`) rejects them. Its exit code decides the
      // outcome, so they are settled as ignored.
      void proc.stdin.write(JSON.stringify(payload));
      void proc.stdin.flush();
      void proc.stdin.end();
    } catch {
      // The command closed stdin early; nothing more to send.
    }

    const reader = proc.stdout.getReader();
    const captureDrain = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        stdout += decoder.decode(value, { stream: true });
        // Only the first line is ever used; stop accumulating past it (and cap
        // a missing-newline stream) so a chatty command cannot grow memory
        // unboundedly before the timeout lands.
        const cut = stdout.indexOf('\n');
        if (cut >= 0) {
          stdout = stdout.slice(0, cut + 1);
          break;
        }
        if (stdout.length > STATUS_LINE_MAX_CAPTURE_BYTES) {
          stdout = stdout.slice(0, STATUS_LINE_MAX_CAPTURE_BYTES);
          break;
        }
      }
    })().catch(() => undefined);

    // The ceiling is hard: the timeout settles the race even if the kill
    // never lands, so a stuck child cannot pin the runner past timeoutMs.
    const code = await Promise.race([proc.exited.catch(() => null), timeoutElapsed]);
    clearTimeout(timer);
    if (timedOut) {
      reader.cancel().catch(() => {});
      return null;
    }
    if (code !== 0) {
      reader.cancel().catch(() => {});
      return null;
    }
    // Drain what is already buffered: the reader yields the remaining chunks
    // without waiting on the closed stream.
    await captureDrain;
    const firstLine = (stdout.split('\n')[0] ?? '').trimEnd();
    return firstLine.length > 0 ? firstLine : null;
  })();
}

/**
 * Throttled cache around `runStatusLineCommand` for a sync render path:
 * `current()` returns the last good line, and a refresh is kicked off in the
 * background at most once per interval. `onUpdate` fires when a fresh line
 * lands so the footer can repaint.
 */
export class StatusLineCommandRunner {
  private lastRunAt = 0;
  private cached: string | null = null;
  private inFlight = false;
  private pendingPayload: StatusLinePayload | null = null;
  private trailingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly command: string,
    private readonly onUpdate: () => void,
    private readonly rerunIntervalMs: number = STATUS_LINE_RERUN_INTERVAL_MS,
  ) {}

  current(): string | null {
    return this.cached;
  }

  maybeRefresh(payload: StatusLinePayload): void {
    const now = Date.now();
    if (this.inFlight || now - this.lastRunAt < this.rerunIntervalMs) {
      // Don't drop the update: land it as soon as the current gap expires,
      // so a final state change is never lost to throttling.
      this.pendingPayload = payload;
      this.scheduleTrailing(now);
      return;
    }
    this.startRun(payload, now);
  }

  dispose(): void {
    if (this.trailingTimer !== null) {
      clearTimeout(this.trailingTimer);
      this.trailingTimer = null;
    }
    this.pendingPayload = null;
  }

  private scheduleTrailing(now: number): void {
    if (this.trailingTimer !== null) return;
    const waitMs = Math.max(0, this.rerunIntervalMs - (now - this.lastRunAt));
    this.trailingTimer = setTimeout(() => {
      this.trailingTimer = null;
      const pending = this.pendingPayload;
      this.pendingPayload = null;
      if (pending !== null) this.maybeRefresh(pending);
    }, waitMs);
    this.trailingTimer.unref?.();
  }

  private startRun(payload: StatusLinePayload, now: number): void {
    this.inFlight = true;
    this.lastRunAt = now;
    void runStatusLineCommand(this.command, payload).then((line) => {
      this.inFlight = false;
      if (line !== null) {
        this.cached = line;
        this.onUpdate();
      }
      const pending = this.pendingPayload;
      this.pendingPayload = null;
      if (pending !== null) this.maybeRefresh(pending);
    });
  }
}
