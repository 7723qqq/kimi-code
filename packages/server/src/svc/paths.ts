/**
 * Per-platform paths and labels used by the OS service backends.
 *
 * The dispatcher and the three platform backends all import these so
 * `paths.test.ts` is the one place a path or label needs to change. Mirrors
 * openclaw's `src/server/paths.ts` + `constants.ts` pattern, trimmed.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveKimiHome } from '@moonshot-ai/agent-core';

/** Reverse-DNS service identifier — labelled the same across platforms. */
export const KIMI_SERVER_LABEL = 'ai.moonshot.kimi-server';

/** macOS LaunchAgent plist filename — same label with the `.plist` suffix. */
export const KIMI_SERVER_PLIST_FILENAME = `${KIMI_SERVER_LABEL}.plist`;

/** Linux systemd `--user` unit filename. */
export const KIMI_SERVER_SYSTEMD_UNIT = 'kimi-server.service';

/** Windows Scheduled Task name. */
export const KIMI_SERVER_TASK_NAME = 'KimiServer';

/** macOS LaunchAgent plist absolute path. `~/Library/LaunchAgents/<label>.plist`. */
export function launchAgentPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', KIMI_SERVER_PLIST_FILENAME);
}

/** Linux user systemd unit absolute path. */
export function systemdUnitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', KIMI_SERVER_SYSTEMD_UNIT);
}

/**
 * Where the supervisor's stdout/stderr lands.
 *
 * One file per platform — the supervisor (launchd / systemd / schtasks) writes
 * the server's stdout there. The server's own pino logger also writes
 * structured JSON to this file because the foreground entrypoint inherits the
 * supervisor's stdio.
 */
export function supervisorLogPath(): string {
  return join(resolveKimiHome(), 'server', 'server.log');
}

/** Where the install plan is recorded, for `status` to read back. */
export function installPlanPath(): string {
  return join(resolveKimiHome(), 'server', 'install.json');
}

/** macOS launchctl `gui/<uid>` domain (so launchctl print can address the agent). */
export function guiDomain(uid: number = process.getuid?.() ?? 0): string {
  return `gui/${uid}`;
}
