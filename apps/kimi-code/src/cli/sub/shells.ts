import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  type ShellPayloadKind,
  type ShellPayloadStatus,
  type ShellPayloadVerifyResult,
  downloadShellPayloadArchive,
  findShellPayloadPin,
  probeHostEnvironmentFromNode,
  readShellPayloadStatus,
  resolvePowerShellExecutable,
  resolveKimiHome,
  resolveShellPayloadHome,
  shellPayloadExePath,
  verifyShellPayload,
  createWindowsShellProvisionDeps,
  provisionShellPayload,
} from '@moonshot-ai/kimi-code-sdk';
import type { Command } from 'commander';

import { t } from '#/i18n';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface ShellsDeps {
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
  readonly kimiHome: () => string;
  readonly env: () => Record<string, string | undefined>;
  readonly osHomeDir: () => string;
  readonly cwd: () => string;
}

export interface ShellsStatusOptions {
  readonly verify?: boolean;
}

export interface ShellsProvisionOptions {
  readonly bash?: boolean;
  readonly pwsh?: boolean;
  readonly all?: boolean;
  readonly mirror?: string;
}

export interface ShellsDownloadOptions extends ShellsProvisionOptions {
  readonly dir?: string;
}

const PAYLOAD_KINDS: readonly ShellPayloadKind[] = ['bash', 'pwsh'];

function defaultDeps(): ShellsDeps {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    exit: (code: number) => process.exit(code) as never,
    kimiHome: () => resolveKimiHome(),
    env: () => process.env as Record<string, string | undefined>,
    osHomeDir: () => homedir(),
    cwd: () => process.cwd(),
  };
}

export function registerShellsCommand(parent: Command, deps?: Partial<ShellsDeps>): void {
  const shells = parent.command('shells').description(t('cli.commandDescriptions.shells'));

  shells
    .command('status')
    .description(t('cli.commandDescriptions.shellsStatus'))
    .option('--verify', t('cli.optionDescriptions.shellsVerify'))
    .action(async (options: ShellsStatusOptions) => {
      await runShellsStatus({ ...defaultDeps(), ...deps }, options);
    });

  shells
    .command('provision')
    .description(t('cli.commandDescriptions.shellsProvision'))
    .option('--bash', t('cli.optionDescriptions.shellsBash'))
    .option('--pwsh', t('cli.optionDescriptions.shellsPwsh'))
    .option('--all', t('cli.optionDescriptions.shellsAll'))
    .option('--mirror <base>', t('cli.optionDescriptions.shellsMirror'))
    .action(async (options: ShellsProvisionOptions) => {
      await runShellsProvision({ ...defaultDeps(), ...deps }, options);
    });

  shells
    .command('download')
    .description(t('cli.commandDescriptions.shellsDownload'))
    .option('--bash', t('cli.optionDescriptions.shellsBash'))
    .option('--pwsh', t('cli.optionDescriptions.shellsPwsh'))
    .option('--all', t('cli.optionDescriptions.shellsAll'))
    .option('--mirror <base>', t('cli.optionDescriptions.shellsMirror'))
    .option('--dir <dir>', t('cli.optionDescriptions.shellsDownloadDir'))
    .action(async (options: ShellsDownloadOptions) => {
      await runShellsDownload({ ...defaultDeps(), ...deps }, options);
    });
}

async function runShellsStatus(deps: ShellsDeps, options: ShellsStatusOptions): Promise<void> {
  const kimiHome = deps.kimiHome();
  deps.stdout.write(`${t('cli.shells.statusHeader', { home: kimiHome })}\n`);
  for (const kind of PAYLOAD_KINDS) {
    const pin = findShellPayloadPin(kind);
    if (pin === undefined) continue;
    const source = await resolveShellSource(deps, kind);
    const payload =
      options.verify === true
        ? await verifyToken(kimiHome, kind)
        : await statusToken(kimiHome, kind);
    const exe =
      source === 'none' ? shellPayloadExePath(kimiHome, pin) : await activeShellPath(deps, kind);
    deps.stdout.write(
      `${t('cli.shells.statusLine', { kind, source, payload, exe: exe ?? '-' })}\n`,
    );
  }
}

async function runShellsProvision(
  deps: ShellsDeps,
  options: ShellsProvisionOptions,
): Promise<void> {
  const kinds = selectedKinds(options);
  const kimiHome = deps.kimiHome();
  const mirror = options.mirror ?? deps.env()['KIMI_DOWNLOAD_MIRROR'];
  const provisionDeps = createWindowsShellProvisionDeps();
  let failed = false;
  for (const kind of kinds) {
    const pin = findShellPayloadPin(kind);
    if (pin === undefined) continue;
    deps.stdout.write(`${t('cli.shells.provisionStart', { kind, version: pin.version })}\n`);
    try {
      const result = await provisionShellPayload(kimiHome, kind, provisionDeps, mirror);
      deps.stdout.write(
        `${t(result.installed ? 'cli.shells.provisionInstalled' : 'cli.shells.provisionSkipped', {
          kind,
          version: result.status.version,
          path: result.status.exePath,
        })}\n`,
      );
    } catch (error) {
      failed = true;
      deps.stderr.write(
        `${t('cli.shells.provisionFailed', {
          kind,
          error: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
    }
  }
  if (failed) deps.exit(1);
}

function selectedKinds(options: ShellsProvisionOptions): readonly ShellPayloadKind[] {
  if (options.bash === true && options.pwsh !== true) return ['bash'];
  if (options.pwsh === true && options.bash !== true) return ['pwsh'];
  return PAYLOAD_KINDS;
}

async function runShellsDownload(deps: ShellsDeps, options: ShellsDownloadOptions): Promise<void> {
  const kinds = selectedKinds(options);
  const mirror = options.mirror ?? deps.env()['KIMI_DOWNLOAD_MIRROR'];
  const destDir = options.dir ?? join(deps.cwd(), 'kimi-shell-payloads');
  const provisionDeps = createWindowsShellProvisionDeps();
  await mkdir(destDir, { recursive: true });
  let failed = false;
  for (const kind of kinds) {
    const pin = findShellPayloadPin(kind);
    if (pin === undefined) continue;
    const fileName = pin.url.slice(pin.url.lastIndexOf('/') + 1);
    const destPath = join(destDir, fileName);
    deps.stdout.write(`${t('cli.shells.downloadStart', { kind, version: pin.version })}\n`);
    try {
      const result = await downloadShellPayloadArchive(pin, destPath, provisionDeps, mirror);
      deps.stdout.write(
        `${t('cli.shells.downloadDone', {
          file: result.path,
          size: String(result.sizeBytes),
          sha256: result.sha256,
        })}\n`,
      );
    } catch (error) {
      failed = true;
      deps.stderr.write(
        `${t('cli.shells.downloadFailed', {
          kind,
          error: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
    }
  }
  if (failed) deps.exit(1);
}

async function activeShellPath(
  deps: ShellsDeps,
  kind: ShellPayloadKind,
): Promise<string | undefined> {
  try {
    if (kind === 'bash') {
      const info = await probeHostEnvironmentFromNode();
      return info.shellPath;
    }
    const exe = await resolvePowerShellExecutable({
      env: deps.env(),
      osHomeDir: deps.osHomeDir(),
      isFile: async (path: string) => {
        try {
          await Bun.file(path).exists();
          return true;
        } catch {
          return false;
        }
      },
    });
    return exe.path;
  } catch {
    return undefined;
  }
}

async function resolveShellSource(
  deps: ShellsDeps,
  kind: ShellPayloadKind,
): Promise<'system' | 'payload' | 'none'> {
  const pin = findShellPayloadPin(kind);
  if (pin === undefined) return 'none';
  const active = await activeShellPath(deps, kind);
  if (active === undefined) return 'none';
  const payloadExe = shellPayloadExePath(
    resolveShellPayloadHome(deps.env(), deps.osHomeDir()),
    pin,
  );
  return active.toLowerCase() === payloadExe.toLowerCase() ? 'payload' : 'system';
}

async function statusToken(kimiHome: string, kind: ShellPayloadKind): Promise<string> {
  let status: ShellPayloadStatus | undefined;
  try {
    status = await readShellPayloadStatus(kimiHome, kind);
  } catch {
    return 'status-unreadable';
  }
  return status === undefined ? 'missing' : 'installed';
}

async function verifyToken(kimiHome: string, kind: ShellPayloadKind): Promise<string> {
  const result: ShellPayloadVerifyResult = await verifyShellPayload(kimiHome, kind);
  return result.ok ? 'verified' : result.reason;
}
