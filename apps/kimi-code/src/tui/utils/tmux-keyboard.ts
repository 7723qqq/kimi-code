import { t } from '#/i18n';

const TMUX_QUERY_TIMEOUT_MS = 2000;

export function tmuxExtendedKeysOffWarning(): string {
  return t('tui.tmux.extendedKeysOff');
}

export function tmuxExtendedKeysFormatXtermWarning(): string {
  return t('tui.tmux.extendedKeysFormatXterm');
}

export type TmuxOptionReader = (option: string) => Promise<string | undefined>;

export async function detectTmuxKeyboardWarning(
  env: NodeJS.ProcessEnv = process.env,
  readTmuxOption: TmuxOptionReader = readTmuxOptionFromProcess,
): Promise<string | undefined> {
  if ((env['TMUX'] ?? '').length === 0) return undefined;

  try {
    const [extendedKeys, extendedKeysFormat] = await Promise.all([
      readTmuxOption('extended-keys'),
      readTmuxOption('extended-keys-format'),
    ]);

    if (extendedKeys === undefined) return undefined;

    if (extendedKeys !== 'on' && extendedKeys !== 'always') {
      return tmuxExtendedKeysOffWarning();
    }

    if (extendedKeysFormat === 'xterm') {
      return tmuxExtendedKeysFormatXtermWarning();
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function readTmuxOptionFromProcess(option: string): Promise<string | undefined> {
  let proc;
  try {
    proc = Bun.spawn({
      cmd: ['tmux', 'show', '-gv', option],
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    });
  } catch {
    return undefined;
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, TMUX_QUERY_TIMEOUT_MS);

  const code = await proc.exited;
  clearTimeout(timer);
  if (timedOut || code !== 0) return undefined;
  const stdout = await new Response(proc.stdout).text();
  return stdout.trim();
}
