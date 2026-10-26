/**
 * External-editor helper — spawn $VISUAL / $EDITOR (or a configured
 * command) on a temp file seeded with the current editor buffer, then
 * read the edited contents back.
 *
 * Resolution priority:
 *   configured (from Core/SDK defaults or `/editor`) >
 *   $VISUAL > $EDITOR > undefined (caller handles "no editor" toast).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { quoteShellArg } from '#/utils/shell-quote';

export interface EditInExternalEditorDeps {
  readonly spawn?: (
    argv: string[],
    options: { stdio: ['inherit', 'inherit', 'inherit']; windowsVerbatimArguments: boolean },
  ) => { readonly exited: Promise<number> };
}

export function resolveEditorCommand(configured?: string | null): string | undefined {
  const candidates = [configured, process.env['VISUAL'], process.env['EDITOR']];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) {
      return c.trim();
    }
  }
  return undefined;
}

/**
 * Launch `command` (tokenised via a shell) against a temp file seeded
 * with `initialText`. Returns the edited contents on success, or
 * `undefined` if the editor exited non-zero / the file disappeared.
 *
 * The command is passed to the system shell (`shell: true`) so users can
 * supply argv-style strings like `code --wait` or `nvim +"set ft=markdown"`.
 */
export async function editInExternalEditor(
  initialText: string,
  command: string,
  deps: EditInExternalEditorDeps = {},
): Promise<string | undefined> {
  const spawnChild =
    deps.spawn ??
    ((argv: string[],
      options: { stdio: ['inherit', 'inherit', 'inherit']; windowsVerbatimArguments: boolean }) =>
      Bun.spawn({ cmd: argv, ...options }));
  const dir = await mkdtemp(join(tmpdir(), 'kimi-edit-'));
  const file = join(dir, 'prompt.md');
  await Bun.write(file, initialText, { createPath: false });
  try {
    const shellCmd = `${command} ${quoteShellArg(file)}`;
    const code = await (async () => {
      const child = spawnChild(
        process.platform === 'win32'
          ? [process.env['COMSPEC'] ?? 'cmd.exe', '/d', '/s', '/c', `"${shellCmd}"`]
          : [process.env['SHELL'] ?? '/bin/sh', '-c', shellCmd],
        { stdio: ['inherit', 'inherit', 'inherit'], windowsVerbatimArguments: true },
      );
      return child.exited;
    })();
    if (code !== 0) return undefined;
    return await Bun.file(file).text();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      // best-effort cleanup
    });
  }
}
