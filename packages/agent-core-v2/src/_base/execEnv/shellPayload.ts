import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ShellPayloadKind = 'bash' | 'pwsh';

export type ShellPayloadArchive = 'zip' | 'self-extract-7z';

export interface ShellPayloadPin {
  readonly kind: ShellPayloadKind;
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly archive: ShellPayloadArchive;
  readonly exeRelPath: string;
  readonly license: string;
  readonly source: string;
}

export const SHELL_PAYLOAD_MANIFEST: readonly ShellPayloadPin[] = [
  {
    kind: 'bash',
    version: '2.56.0.4',
    url: 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/PortableGit-2.56.0.4-64-bit.7z.exe',
    sha256: 'b1f3e52216e2ed6882d1bebfd4d3fdf319bec40d2edbbf9fd26ec4fd3fce7ed1',
    archive: 'self-extract-7z',
    exeRelPath: 'usr/bin/bash.exe',
    license:
      'GPL-2.0 (bash, MSYS2 runtime) — corresponding source: https://github.com/git-for-windows/git',
    source: 'https://github.com/git-for-windows/git/releases/tag/v2.56.0.windows.4',
  },
  {
    kind: 'pwsh',
    version: '7.6.9',
    url: 'https://github.com/PowerShell/PowerShell/releases/download/v7.6.9/PowerShell-7.6.9-win-x64.zip',
    sha256: 'ce7484804c0f0ad4dda10c958e71acdaf7eebfb22505c1b480f89e0e9f1da94d',
    archive: 'zip',
    exeRelPath: 'pwsh.exe',
    license: 'MIT (PowerShell) — corresponding source: https://github.com/PowerShell/PowerShell',
    source: 'https://github.com/PowerShell/PowerShell/releases/tag/v7.6.9',
  },
];

export interface ShellPayloadStatus {
  readonly kind: ShellPayloadKind;
  readonly version: string;
  readonly sha256: string;
  readonly exePath: string;
  readonly exeSha256: string;
  readonly verifiedAt: string;
}

export type ShellPayloadVerifyResult =
  | { readonly ok: true; readonly status: ShellPayloadStatus }
  | {
      readonly ok: false;
      readonly reason: 'missing' | 'status-unreadable' | 'exe-missing' | 'exe-hash-mismatch';
    };

export class ShellPayloadStatusCorruptError extends Error {
  constructor(
    readonly path: string,
    cause?: unknown,
  ) {
    super(`Shell payload status file is not valid JSON: ${path}`);
    this.name = 'ShellPayloadStatusCorruptError';
    if (cause !== undefined) this.cause = cause;
  }
}

export function findShellPayloadPin(kind: ShellPayloadKind): ShellPayloadPin | undefined {
  return SHELL_PAYLOAD_MANIFEST.find((entry) => entry.kind === kind);
}

export function shellPayloadPinOf(kind: ShellPayloadKind): ShellPayloadPin {
  const pin = findShellPayloadPin(kind);
  if (pin === undefined) {
    throw new Error(`No shell payload pin registered for kind: ${kind}`);
  }
  return pin;
}

export function resolveShellPayloadHome(
  env: Record<string, string | undefined>,
  osHomeDir: string,
): string {
  const fromEnv = env['KIMI_CODE_HOME']?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return join(osHomeDir, '.kimi-code');
}

export function shellPayloadsDir(kimiHome: string): string {
  return join(kimiHome, 'shells');
}

export function shellPayloadInstallDir(kimiHome: string, pin: ShellPayloadPin): string {
  return join(shellPayloadsDir(kimiHome), `${pin.kind}-${pin.version}`);
}

export function shellPayloadStatusPath(kimiHome: string, kind: ShellPayloadKind): string {
  return join(shellPayloadsDir(kimiHome), `${kind}.json`);
}

export function shellPayloadExePath(kimiHome: string, pin: ShellPayloadPin): string {
  return join(shellPayloadInstallDir(kimiHome, pin), pin.exeRelPath);
}

export async function hashFileSha256(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash('sha256').update(data).digest('hex');
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readShellPayloadStatus(
  kimiHome: string,
  kind: ShellPayloadKind,
): Promise<ShellPayloadStatus | undefined> {
  const path = shellPayloadStatusPath(kimiHome, kind);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ShellPayloadStatusCorruptError(path, error);
  }
  return normalizeShellPayloadStatus(parsed, kind, path);
}

export async function writeShellPayloadStatus(
  kimiHome: string,
  status: ShellPayloadStatus,
): Promise<void> {
  await mkdir(shellPayloadsDir(kimiHome), { recursive: true });
  const path = shellPayloadStatusPath(kimiHome, status.kind);
  await writeFile(path, `${JSON.stringify(status, undefined, 2)}\n`, 'utf8');
}

export async function verifyShellPayload(
  kimiHome: string,
  kindValue: ShellPayloadKind,
): Promise<ShellPayloadVerifyResult> {
  let status: ShellPayloadStatus | undefined;
  try {
    status = await readShellPayloadStatus(kimiHome, kindValue);
  } catch {
    return { ok: false, reason: 'status-unreadable' };
  }
  if (status === undefined) return { ok: false, reason: 'missing' };
  if (!(await pathExists(status.exePath))) return { ok: false, reason: 'exe-missing' };
  const exeSha256 = await hashFileSha256(status.exePath);
  if (exeSha256 !== status.exeSha256) return { ok: false, reason: 'exe-hash-mismatch' };
  return { ok: true, status };
}

function normalizeShellPayloadStatus(
  parsed: unknown,
  expectedKind: ShellPayloadKind,
  path: string,
): ShellPayloadStatus {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ShellPayloadStatusCorruptError(path);
  }
  const record = parsed as Record<string, unknown>;
  const { kind: kindValue, version, sha256, exePath, exeSha256, verifiedAt } = record;
  if (
    kindValue !== expectedKind ||
    typeof version !== 'string' ||
    typeof sha256 !== 'string' ||
    typeof exePath !== 'string' ||
    typeof exeSha256 !== 'string' ||
    typeof verifiedAt !== 'string'
  ) {
    throw new ShellPayloadStatusCorruptError(path);
  }
  return { kind: expectedKind, version, sha256, exePath, exeSha256, verifiedAt };
}
