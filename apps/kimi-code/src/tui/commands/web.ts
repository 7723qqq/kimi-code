import chalk from 'chalk';

import { splitTokenFragment } from '#/cli/sub/web/access-urls';
import { getVersion } from '#/cli/version';
import { CLI_MSH_PLATFORM, CLI_USER_AGENT_PRODUCT } from '#/constant/app';
import {
  buildRemoteControlUrl,
  formatRemoteControlAlreadyRunning,
  formatRemoteControlOutput,
  formatRemoteControlStatus,
  inspectRemoteControlLock,
  startRemoteControl,
  type RemoteControlStatus,
} from '#/cli/sub/web/remote-control';
import { formatReadyBanner, startServerForeground } from '#/cli/sub/web/run';
import { parseServerOptions, tryResolveServerToken } from '#/cli/sub/web/shared';
import { t } from '#/i18n';
import { openUrl } from '#/utils/open-url';
import { getDataDir } from '#/utils/paths';
import { persistedKimiOAuthRef } from '#/utils/region';
import { generateRemoteControlQr } from '#/utils/remote-control-qr';

import { getNoActiveSessionMessage } from '../constant/kimi-tui';
import { darkColors } from '../theme/colors';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

export interface WebCommandIO {
  readonly stdout?: Pick<NodeJS.WriteStream, 'write'>;
  readonly stderr?: Pick<NodeJS.WriteStream, 'write'>;
  readonly exit?: (code: number) => never | void;
}

/**
 * `/web` — hand the current session off to the browser.
 *
 * Always starts a new server: the TUI shuts down and this process becomes the
 * server, running in the foreground attached to this terminal and taking the
 * next free port alongside any running ones. The session deep link opens from
 * the ready hook once the server is actually listening.
 */
export async function handleWebCommand(
  host: SlashCommandHost,
  io: WebCommandIO = {},
): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(getNoActiveSessionMessage());
    return;
  }

  startNewServerAfterExit(host, session.id, io);
  await host.stop();
}

export async function handleRemoteControlCommand(
  host: SlashCommandHost,
  io: WebCommandIO = {},
): Promise<void> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const exit = io.exit ?? ((code: number): never => process.exit(code));
  await host.waitForLazyCreation();
  const session = host.session;

  const holder = await inspectRemoteControlLock(getDataDir());
  if (holder !== undefined) {
    host.showError(formatRemoteControlAlreadyRunning(holder));
    return;
  }

  host.setExitForegroundTask(async () => {
    const options = parseServerOptions({});
    let remoteControl: Awaited<ReturnType<typeof startRemoteControl>> | undefined;
    try {
      await startServerForeground(options, {
        onReady: async (origin, controls) => {
          const dataDir = getDataDir();
          const token = tryResolveServerToken(dataDir);
          if (token === undefined) throw new Error(t('tui.statusMessages.unableToReadServerToken'));
          const persisted = persistedKimiOAuthRef();
          let outputReady = false;
          const pendingStatuses: string[] = [];
          const onStatus = (status: RemoteControlStatus): void => {
            const line = formatRemoteControlStatus(status);
            if (outputReady) stdout.write(line);
            else pendingStatuses.push(line);
          };
          remoteControl = await startRemoteControl({
            homeDir: dataDir,
            localOrigin: origin,
            localServerToken: token,
            clientVersion: `${CLI_USER_AGENT_PRODUCT}/${getVersion()}`,
            urlSource: CLI_MSH_PLATFORM,
            configuredOAuthKey: persisted?.key,
            configuredOAuthHost: persisted?.oauthHost,
            onStatus,
          });
          void remoteControl.closed.then(
            (reason) => {
              if (reason === 'user_requested') {
                controls?.requestShutdown('remote_control_user_requested');
              }
            },
            (error) => {
              stderr.write(
                `${t('cli.commandDescriptions.remoteControlLockReleaseFailed', {
                  error: formatErrorMessage(error),
                })}\n`,
              );
              controls?.requestShutdown('remote_control_closed');
            },
          );
          const url = buildRemoteControlUrl(
            remoteControl.deviceId,
            session?.id,
            remoteControl.relayOrigin,
            CLI_MSH_PLATFORM,
          );
          const qrCode = await generateRemoteControlQr(url, dataDir);
          stdout.write(
            formatRemoteControlOutput({
              url,
              localOrigin: origin,
              localServerToken: token,
              deviceName: remoteControl.deviceName,
              qrCode: qrCode.terminal,
              pngPath: qrCode.pngPath,
            }),
          );
          outputReady = true;
          for (const line of pendingStatuses) stdout.write(line);
          openUrl(url);
        },
        onShutdown: async () => {
          await remoteControl?.close();
        },
      });
    } catch (error) {
      stderr.write(
        t('tui.statusMessages.failedToStartRemoteControl', {
          error: formatErrorMessage(error),
        }) + '\n',
      );
      exit(1);
    }
  });
  await host.stop();
}

/**
 * Register the exit takeover that turns this process into the new server once
 * the TUI has shut down (where `process.exit` would normally happen): the
 * server stays attached to this terminal until Ctrl+C, and the session deep
 * link opens from the ready hook once the server is actually listening. The
 * terminal shows the same ready banner as `kimi web` plus the deep link.
 */
function startNewServerAfterExit(
  host: SlashCommandHost,
  sessionId: string,
  io: WebCommandIO,
): void {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const exit = io.exit ?? ((code: number): never => process.exit(code));
  host.setExitForegroundTask(async () => {
    const options = parseServerOptions({});
    try {
      await startServerForeground(options, {
        onReady: (origin) => {
          // Resolve the token here (after the server is listening): a fresh
          // server writes `server.token` on first boot, so reading it earlier
          // would miss first-time starts and the browser would hit the auth
          // gate.
          const token = tryResolveServerToken(getDataDir());
          const url = webSessionUrl(origin, sessionId, token);
          stdout.write(formatReadyBanner(origin, options.host, { token }));
          stdout.write(`\n  ${sessionLine(url)}\n`);
          openUrl(url);
        },
      });
    } catch (error) {
      stderr.write(
        t('tui.statusMessages.failedToStartServer', { error: formatErrorMessage(error) }) + '\n',
      );
      exit(1);
    }
  });
}

/** Styled `Session:` line for the foreground handoff; the token fragment is
 * dimmed like in the ready banner so the host/path stands out. */
function sessionLine(url: string, labelText = 'Session:  '): string {
  const label = (text: string): string => chalk.bold.hex(darkColors.textDim)(text);
  const accent = (text: string): string => chalk.hex(darkColors.accent)(text);
  const dim = (text: string): string => chalk.hex(darkColors.textDim)(text);
  const [base, frag] = splitTokenFragment(url);
  return `${label(labelText)}${accent(base)}${frag === '' ? '' : dim(frag)}`;
}

/**
 * Build the deep-link URL the web UI recognises for a session. When a token is
 * known it rides in the `#token=` fragment (never sent to the server, so never
 * logged), so the browser authenticates on load just like `kimi web`.
 */
export function webSessionUrl(origin: string, sessionId: string, token?: string): string {
  const base = `${origin.replace(/\/+$/, '')}/sessions/${encodeURIComponent(sessionId)}`;
  return token === undefined ? base : `${base}#token=${token}`;
}
