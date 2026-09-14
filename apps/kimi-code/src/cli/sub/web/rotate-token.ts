/**
 * `kimi web rotate-token` — generate a new persistent server token.
 *
 * Rewrites `<KIMI_CODE_HOME>/server.token` (0600, atomic). The previous token
 * stops working immediately: a running server re-reads the file on its next
 * auth check, so rotation takes effect without a restart.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import chalk from 'chalk';
import type { Command } from 'commander';

import { t } from '#/i18n';
import { darkColors } from '#/tui/theme/colors';
import { getDataDir } from '#/utils/paths';

import { accessUrlLines, splitTokenFragment } from './access-urls';

export interface ServerInstanceInfo {
  readonly serverId: string;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly startedAt: number;
  readonly heartbeatAt: number;
  readonly serverVersion?: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return true;
  }
}

export async function rotateServerToken(homeDir: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  mkdirSync(homeDir, { recursive: true });
  const target = join(homeDir, 'server.token');
  const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, token, { mode: 0o600 });
  renameSync(tmp, target);
  return token;
}

export async function getLiveServerInstance(
  homeDir: string = getDataDir(),
): Promise<ServerInstanceInfo | undefined> {
  const dir = join(homeDir, 'server', 'instances');
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  const instances: ServerInstanceInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, entry), 'utf8')) as Record<string, unknown>;
      if (typeof raw['pid'] === 'number' && pidAlive(raw['pid'])) {
        instances.push({
          serverId: typeof raw['server_id'] === 'string' ? raw['server_id'] : entry.slice(0, -5),
          pid: raw['pid'],
          host: typeof raw['host'] === 'string' ? raw['host'] : '127.0.0.1',
          port: typeof raw['port'] === 'number' ? raw['port'] : 58627,
          startedAt: typeof raw['started_at'] === 'number' ? raw['started_at'] : 0,
          heartbeatAt: typeof raw['heartbeat_at'] === 'number' ? raw['heartbeat_at'] : 0,
          serverVersion: typeof raw['host_version'] === 'string' ? raw['host_version'] : undefined,
        });
      }
    } catch {
      // Ignore corrupt or invalid instance files
    }
  }
  instances.sort((a, b) => a.startedAt - b.startedAt);
  return instances[0];
}

export function registerRotateTokenCommand(server: Command): void {
  server
    .command('rotate-token')
    .description(t('cli.commandDescriptions.serverRotateToken'))
    .action(async () => {
      try {
        const token = await rotateServerToken(getDataDir());
        process.stdout.write(t('tui.statusMessages.serverTokenRotated') + '\n');

        // Token in the middle: indented and set off by blank lines (no color
        // highlight), so it is easy to spot without dominating the output.
        process.stdout.write(
          '\n  ' + chalk.bold(t('tui.statusMessages.serverNewToken', { token })) + '\n\n',
        );

        // Re-print the access links with the new token so the user can
        // reconnect immediately. When a server is running its bind host/port
        // come from the instance registry; otherwise there is nothing to
        // connect to yet.
        const instance = await getLiveServerInstance();
        if (instance !== undefined) {
          for (const { label, url: href } of accessUrlLines(instance.host, instance.port, token)) {
            // De-emphasize the `#token=…` fragment so the host/port stands out.
            const [base, frag] = splitTokenFragment(href);
            const rendered =
              frag === ''
                ? chalk.hex(darkColors.accent)(base)
                : chalk.hex(darkColors.accent)(base) + chalk.hex(darkColors.textDim)(frag);
            process.stdout.write(`  ${chalk.dim(label)}${rendered}\n`);
          }
        }
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}
