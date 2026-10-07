import { spawn } from 'node:child_process';

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

function readTmuxOptionFromProcess(option: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const proc = spawn('tmux', ['show', '-gv', option], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    let settled = false;
    let timer: NodeJS.Timeout;

    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    timer = setTimeout(() => {
      proc.kill();
      finish(undefined);
    }, TMUX_QUERY_TIMEOUT_MS);

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString('utf8');
    });
    proc.on('error', () => {
      finish(undefined);
    });
    proc.on('close', (code) => {
      finish(code === 0 ? stdout.trim() : undefined);
    });
  });
}
