/**
 * `kimi web` — run the local server in the foreground and open the web UI.
 *
 * The server always runs in the current process, attached to the terminal,
 * and shuts down cleanly on SIGINT/SIGTERM. `--no-open` skips the browser.
 * Multiple instances can share the home directory: each registers itself in
 * the instance registry and takes the next free port (see kap-server's
 * `startServer`).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import chalk from 'chalk';
import { type Command, Option } from 'commander';

import { t } from '#/i18n';
import { getNativeWebAssetsDir } from '#/native/web-assets';
import { darkColors } from '#/tui/theme/colors';
import { openUrl as defaultOpenUrl } from '#/utils/open-url';
import { getDataDir } from '#/utils/paths';
import { generateRemoteControlQr } from '#/utils/remote-control-qr';

import { getHostPackageRoot, getVersion } from '../../version';
import {
  accessUrlLines,
  browserOpenOrigin,
  buildOpenableUrl,
  isLoopbackHost,
  splitTokenFragment,
} from './access-urls';
import { type NetworkAddress } from './networks';
import {
  formatRemoteControlOutput,
  formatRemoteControlStatus,
  startRemoteControl,
  type RemoteControlHandle,
  type RemoteControlOptions,
  type RemoteControlStatus,
} from './remote-control';
import { findRustAgentBinary, startRustServerForeground } from './rust-server-runner';
import {
  DEFAULT_FOREGROUND_LOG_LEVEL,
  DEFAULT_LAN_HOST,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  parseServerOptions,
  tryResolveServerToken,
  VALID_LOG_LEVELS,
  type ParsedServerOptions,
  type ServerCliOptions,
} from './shared';

const WEB_ASSETS_DIR = 'dist-web';

export interface WebCliOptions extends ServerCliOptions {
  open?: boolean;
  remoteControl?: boolean;
  rustServer?: boolean;
  legacyServer?: boolean;
}

export interface StartForegroundHooks {
  /** Fires once the server is listening, before the foreground runner blocks. */
  onReady?: (origin: string) => void | Promise<void>;
  onShutdown?: (reason: string) => void | Promise<void>;
}

export interface WebCommandDeps {
  /** Foreground runner; defaults to the real native runner when omitted. */
  startServerForeground?: (
    options: ParsedServerOptions,
    hooks?: StartForegroundHooks,
  ) => Promise<never>;
  startRemoteControl?: (options: RemoteControlOptions) => Promise<RemoteControlHandle>;
  openUrl(url: string): void;
  findBinary?: () => string | undefined;
  /**
   * Best-effort read of the server's persistent bearer token. When it returns
   * a token, the ready banner prints it and the opened Web UI URL carries it in
   * the `#token=` fragment (M5.5). Optional so callers/tests that don't supply
   * it simply print/open the plain origin.
   */
  resolveToken?: () => string | undefined;
  /**
   * Non-loopback interface addresses to display for a wildcard bind. Defaults
   * to the machine's own interfaces (`listNetworkAddresses()`); inject a fixed
   * list in tests for deterministic output.
   */
  networkAddresses?: NetworkAddress[];
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

export interface ServerRunnerResolution {
  runner: (options: ParsedServerOptions, hooks?: StartForegroundHooks) => Promise<never>;
  isRust: boolean;
  isLegacyFallback: boolean;
  deprecationNotice?: string;
}

/**
 * Resolve the appropriate server runner (native Rust server only).
 * kap-server has been retired; native kimi-agent is the sole supported server.
 */
export function resolveServerRunner(
  opts: WebCliOptions,
  findBin: () => string | undefined = findRustAgentBinary,
): ServerRunnerResolution {
  const forceLegacy = opts.legacyServer === true || process.env['KIMI_LEGACY_SERVER'] === '1';
  if (forceLegacy) {
    return {
      runner: async () => {
        throw new Error(
          '[DEPRECATION] kap-server has been retired and removed. Only the native kimi-agent server is supported.',
        );
      },
      isRust: false,
      isLegacyFallback: false,
      deprecationNotice:
        '[DEPRECATION] kap-server has been retired and removed. Only the native kimi-agent server is supported.',
    };
  }

  return {
    runner: (options, hooks) =>
      startRustServerForeground(options, hooks, {
        findBinary: findBin,
        webAssetsDir: serverWebAssetsDir(),
      }),
    isRust: true,
    isLegacyFallback: false,
  };
}

/**
 * Build the Web UI URL, carrying the bearer token in the URL fragment.
 *
 * The token rides in `#token=<token>` — a client-side fragment that is never
 * sent to the server (so it never appears in server access logs) and is not
 * logged by proxies. The Web UI reads it from `location.hash` after load.
 */
export function buildWebUrl(origin: string, token: string): string {
  return buildOpenableUrl(browserOpenOrigin(origin), token);
}

/** Build the `web` command, mounting the runner action on `cmd` itself. */
export function buildWebCommand(
  cmd: Command,
  opts: { forceRemoteControl?: boolean } = {},
): Command {
  const forceRemoteControl = opts.forceRemoteControl === true;
  const withServerOptions = cmd
    .option(
      '--port <port>',
      `Bind port (default ${DEFAULT_SERVER_PORT})`,
      String(DEFAULT_SERVER_PORT),
    )
    .option(
      '--host [host]',
      `Bind host. Omit to bind ${DEFAULT_SERVER_HOST} (this machine only); pass --host to bind ${DEFAULT_LAN_HOST} (all interfaces), or --host <host> for a specific host. The bearer token is printed at startup.`,
    )
    .option(
      '--allowed-host <host...>',
      'Extra Host header value to allow through the DNS-rebinding check. Repeat or comma-separate; a leading dot matches a domain suffix (e.g. .example.com).',
    )
    .option('--insecure-no-tls', t('cli.optionDescriptions.serverRunOptionInsecureNoTls'), true)
    .option(
      '--allow-remote-shutdown',
      'On a non-loopback bind, keep POST /api/v1/shutdown enabled (default: route is disabled → 404).',
      false,
    )
    .option(
      '--dangerous-bypass-auth',
      'Disable bearer-token auth on every REST and WebSocket route, and advertise it via /api/v1/meta so the web UI connects without a token. Only use on a trusted network or behind your own authenticating proxy.',
      false,
    )
    .option(
      '--log-level <level>',
      `Server log level: ${VALID_LOG_LEVELS.join('|')}. Omit to keep logs off.`,
    )
    .option(
      '--debug-endpoints',
      'Mount /api/v1/debug/* routes for test introspection. OFF by default; production callers leave this unset.',
      false,
    )
    .option(
      '--web-title <title>',
      'Set a custom browser tab title for this web UI instance (default: "<workspace dir> | Kimi Code").',
    )
    .option(
      '--rust-server',
      'Run the native Rust HTTP/WS server (kimi-agent --serve). Active by default when binary is available.',
      process.env['KIMI_USE_RUST_SERVER'] === '1',
    )
    .option(
      '--legacy-server',
      'Force fallback to the legacy kap-server runtime (deprecated).',
      process.env['KIMI_LEGACY_SERVER'] === '1',
    );
  if (!forceRemoteControl) {
    withServerOptions.addOption(
      new Option(
        '--rc, --remote-control',
        'Expose the web UI through Kimi Remote Control.',
      ).default(false),
    );
  }
  return withServerOptions
    .option('--no-open', t('cli.optionDescriptions.serverRunOptionNoOpen'), true)
    .action(async (opts: WebCliOptions) => {
      try {
        await handleWebCommand(forceRemoteControl ? { ...opts, remoteControl: true } : opts);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}

export async function handleWebCommand(
  opts: WebCliOptions,
  deps: WebCommandDeps = DEFAULT_WEB_COMMAND_DEPS,
): Promise<void> {
  const parsed = parseServerOptions(opts);
  if (opts.remoteControl === true && parsed.dangerousBypassAuth) {
    throw new Error('--remote-control cannot be combined with --dangerous-bypass-auth.');
  }
  if (opts.remoteControl === true && !isLoopbackHost(parsed.host)) {
    throw new Error('--remote-control requires a loopback host.');
  }
  const resolution = resolveServerRunner(opts, deps.findBinary ?? findRustAgentBinary);
  if (resolution.deprecationNotice && deps.stderr) {
    deps.stderr.write(`${chalk.hex(darkColors.warning)(resolution.deprecationNotice)}\n`);
  }
  const defaultRunner = resolution.runner;
  const run = deps.startServerForeground ?? defaultRunner;
  let remoteControl: RemoteControlHandle | undefined;
  await run(parsed, {
    onReady: async (origin) => {
      // Resolve the persistent token only once the server is up: a fresh
      // server writes `server.token` on first boot, so reading it beforehand
      // would miss first-time starts and the browser would hit the auth gate.
      // It is printed in the ready banner and rides in the opened Web UI
      // URL's `#token=` fragment (M5.5); falls back to the plain origin / no
      // token line when unavailable. When auth is bypassed, the token is
      // meaningless and is intentionally NOT shown or carried in the URL.
      const token = parsed.dangerousBypassAuth ? undefined : deps.resolveToken?.();
      if (opts.remoteControl === true) {
        if (token === undefined) throw new Error(t('tui.statusMessages.unableToReadServerToken'));
        const dataDir = getDataDir();
        let outputReady = false;
        const pendingStatuses: string[] = [];
        const onStatus = (status: RemoteControlStatus): void => {
          const line = formatRemoteControlStatus(status);
          if (outputReady) deps.stdout.write(line);
          else pendingStatuses.push(line);
        };
        remoteControl = await (deps.startRemoteControl ?? startRemoteControl)({
          homeDir: dataDir,
          localOrigin: origin,
          localServerToken: token,
          stderr: deps.stderr,
          onStatus,
        });
        const qrCode = await generateRemoteControlQr(remoteControl.url, dataDir);
        deps.stdout.write(
          formatRemoteControlOutput({
            url: remoteControl.url,
            localOrigin: origin,
            deviceName: remoteControl.deviceName,
            qrCode: qrCode.terminal,
            pngPath: qrCode.pngPath,
          }),
        );
        outputReady = true;
        for (const line of pendingStatuses) deps.stdout.write(line);
        if (opts.open === true) deps.openUrl(remoteControl.url);
        return;
      }
      deps.stdout.write(
        parsed.logLevel === DEFAULT_FOREGROUND_LOG_LEVEL
          ? formatReadyBanner(origin, parsed.host, {
              token,
              networkAddresses: deps.networkAddresses,
              dangerousBypassAuth: parsed.dangerousBypassAuth,
              backend: resolution.isRust ? 'rust' : 'legacy',
            })
          : formatReadyLine(origin, token, parsed.dangerousBypassAuth),
      );
      if (opts.open === true) {
        deps.openUrl(token !== undefined ? buildWebUrl(origin, token) : browserOpenOrigin(origin));
      }
    },
    onShutdown: async () => {
      await remoteControl?.close();
    },
  });
}

function formatReadyLine(
  origin: string,
  token: string | undefined,
  dangerousBypassAuth = false,
): string {
  const notice = dangerousBypassAuth ? `${formatDangerNoticeLines().join('\n')}\n` : '';
  return `${notice}Kimi server: ${buildOpenableUrl(origin, token)}\n`;
}

/**
 * Red, impossible-to-miss notice emitted when `--dangerous-bypass-auth`
 * disables the bearer-token gate. Shared by the full ready banner and the
 * compact one-line output so the warning always shows regardless of log level.
 */
function formatDangerNoticeLines(): string[] {
  const danger = (text: string): string => chalk.hex(darkColors.error)(text);
  const dangerBold = (text: string): string => chalk.bold.hex(darkColors.error)(text);
  return [
    `  ${dangerBold(t('tui.statusMessages.serverDangerAuthDisabled'))}`,
    `  ${danger(t('tui.statusMessages.serverDangerAnyoneAccess'))}`,
    `  ${danger('If you are unsure, stop this process now with ')}${dangerBold('Ctrl+C')}${danger('.')}`,
  ];
}

/**
 * `kimi web` — runs the native Rust server in the foreground.
 */
export async function startServerForeground(
  options: ParsedServerOptions,
  hooks: StartForegroundHooks = {},
): Promise<never> {
  return startRustServerForeground(options, hooks, {
    webAssetsDir: serverWebAssetsDir(),
  });
}

/**
 * Resolve the web assets directory passed to kap-server. In dev mode
 * (`KIMI_CODE_DEV_SERVER=1`, set by the repo's `dev:server` / `dev:kap-server*`
 * scripts) a missing `dist-web` build is tolerated: the server starts API-only
 * and the web UI is expected to come from a Vite dev server (the web UI source lives in the code-app repo).
 * Outside dev mode the directory is always returned and kap-server keeps
 * failing fast when the assets are missing.
 */
export function serverWebAssetsDir(
  env: NodeJS.ProcessEnv = process.env,
  nativeWebAssetsDir: string | null = getNativeWebAssetsDir(),
): string | undefined {
  const dir = resolveServerWebAssetsDir(nativeWebAssetsDir);
  if (env['KIMI_CODE_DEV_SERVER'] === '1' && !existsSync(join(dir, 'index.html'))) {
    return undefined;
  }
  return dir;
}

export function resolveServerWebAssetsDir(
  nativeWebAssetsDir: string | null = getNativeWebAssetsDir(),
): string {
  return nativeWebAssetsDir ?? join(getHostPackageRoot(), WEB_ASSETS_DIR);
}

interface FormatReadyBannerOptions {
  /** Persistent bearer token to print; omitted when unresolvable. */
  token?: string;
  /** Non-loopback interface addresses to list for a wildcard bind. */
  networkAddresses?: NetworkAddress[];
  /** When true, render a red danger notice (auth is disabled). */
  dangerousBypassAuth?: boolean;
  /** Runtime engine backend powering the server. */
  backend?: 'rust' | 'legacy';
}

export function formatReadyBanner(
  origin: string,
  host: string,
  opts: FormatReadyBannerOptions = {},
): string {
  const primary = (text: string): string => chalk.hex(darkColors.primary)(text);
  const title = (text: string): string => chalk.bold.hex(darkColors.primary)(text);
  const dim = (text: string): string => chalk.hex(darkColors.textDim)(text);
  const muted = (text: string): string => chalk.hex(darkColors.textMuted)(text);
  const label = (text: string): string => chalk.bold.hex(darkColors.textDim)(text);
  const url = (text: string): string => chalk.hex(darkColors.accent)(text);
  const successBadge = (text: string): string => chalk.bold.hex(darkColors.success)(text);
  // Render the `#token=…` fragment in a de-emphasized gray so the host/port
  // stands out while the full URL stays selectable for copying.
  const urlWithDimToken = (href: string): string => {
    const [base, frag] = splitTokenFragment(href);
    return frag === '' ? url(base) : url(base) + dim(frag);
  };

  const lastColon = origin.lastIndexOf(':');
  const port = Number(origin.slice(lastColon + 1)) || 58627;
  // Borderless header: the Kimi sprite (the little mascot with eyes) sits next
  // to the title, keeping the brand without the enclosing box.
  const logo = ['▐█▛█▛█▌', '▐█████▌'] as const;
  const backendBadge = opts.backend === 'rust' ? `  ${successBadge('[native-rust]')}` : '';
  const lines: string[] = [
    '',
    `  ${primary(logo[0])}  ${title(t('tui.statusMessages.serverReadyBanner'))}  ${dim(getVersion())}${backendBadge}`,
    `  ${primary(logo[1])}  ${dim(t('tui.statusMessages.serverReadyLocalUi'))}`,
    '',
  ];

  if (opts.dangerousBypassAuth === true) {
    // Red, impossible-to-miss notice: the bearer-token gate is off, so anyone
    // who can reach this port gets full session / filesystem / shell access.
    lines.push(...formatDangerNoticeLines(), '');
  }

  // Access links.
  for (const { label: text, url: href } of accessUrlLines(
    host,
    port,
    opts.token,
    opts.networkAddresses,
  )) {
    lines.push(`  ${label(text)}${urlWithDimToken(href)}`);
  }
  // On a loopback bind there is no network URL; show how to enable one.
  if (isLoopbackHost(host)) {
    lines.push(`  ${label('Network:  ')}${muted('off')}${dim('  use --host to enable')}`);
  }
  if (opts.token !== undefined) {
    // Set the token off with surrounding whitespace rather than color, so it is
    // easy to spot without being highlighted.
    lines.push('');
    lines.push(`  ${label('Token:    ')}${opts.token}`);
    lines.push('');
  }

  // Auxiliary controls last.
  lines.push(`  ${label('Logs:     ')}${muted('off')}${dim('  use --log-level info to enable')}`);
  // The server always runs in the foreground attached to this terminal.
  lines.push(`  ${label('Stop:     ')}${muted('Ctrl+C')}`);
  lines.push('');
  return lines.join('\n');
}

const DEFAULT_WEB_COMMAND_DEPS: WebCommandDeps = {
  startServerForeground,
  openUrl: defaultOpenUrl,
  resolveToken: () => {
    // Read the persistent `<homeDir>/server.token` written on first boot
    // (M5.1). Best-effort: a missing/older server yields undefined and the
    // caller opens the plain origin.
    return tryResolveServerToken(getDataDir());
  },
  stdout: process.stdout,
  stderr: process.stderr,
};
