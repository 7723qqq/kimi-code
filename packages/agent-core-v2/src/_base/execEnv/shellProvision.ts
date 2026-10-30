import { execFile } from 'node:child_process';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type ShellPayloadArchive,
  type ShellPayloadKind,
  type ShellPayloadPin,
  type ShellPayloadStatus,
  hashFileSha256,
  pathExists,
  readShellPayloadStatus,
  shellPayloadExePath,
  shellPayloadInstallDir,
  shellPayloadPinOf,
  shellPayloadsDir,
  writeShellPayloadStatus,
} from './shellPayload';

export class ShellPayloadIntegrityError extends Error {
  constructor(
    readonly pin: ShellPayloadPin,
    readonly actualSha256: string,
  ) {
    super(
      `Shell payload integrity check failed for ${pin.kind} ${pin.version}: expected sha256 ${pin.sha256}, got ${actualSha256}`,
    );
    this.name = 'ShellPayloadIntegrityError';
  }
}

export class ShellPayloadExtractError extends Error {
  constructor(
    readonly pin: ShellPayloadPin,
    readonly detail: string,
  ) {
    super(`Shell payload extraction failed for ${pin.kind} ${pin.version}: ${detail}`);
    this.name = 'ShellPayloadExtractError';
  }
}

export interface ShellProvisionDeps {
  readonly download: (url: string, destPath: string) => Promise<void>;
  readonly extract: (
    archivePath: string,
    archive: ShellPayloadArchive,
    destDir: string,
  ) => Promise<void>;
  readonly now?: () => Date;
}

export interface ShellProvisionResult {
  readonly status: ShellPayloadStatus;
  readonly installed: boolean;
}

export function applyDownloadMirror(url: string, mirror: string | undefined): string {
  const base = mirror?.trim();
  if (base === undefined || base.length === 0) return url;
  return `${base.replace(/\/+$/, '')}/${url}`;
}

export async function provisionShellPayload(
  kimiHome: string,
  kind: ShellPayloadKind,
  deps: ShellProvisionDeps,
  mirror?: string,
): Promise<ShellProvisionResult> {
  return provisionShellPayloadWithPin(shellPayloadPinOf(kind), kimiHome, deps, mirror);
}

export async function provisionShellPayloadWithPin(
  pin: ShellPayloadPin,
  kimiHome: string,
  deps: ShellProvisionDeps,
  mirror?: string,
): Promise<ShellProvisionResult> {
  const kind = pin.kind;
  const now = deps.now ?? (() => new Date());
  const existing = await readExistingStatus(kimiHome, kind);
  if (existing !== undefined && existing.version === pin.version) {
    if (await pathExists(existing.exePath)) return { status: existing, installed: false };
  }

  const root = shellPayloadsDir(kimiHome);
  const tmpDir = join(root, `.tmp-${kind}-${String(now().getTime())}`);
  await mkdir(tmpDir, { recursive: true });
  try {
    const archivePath = join(tmpDir, `payload.${archiveFileExtension(pin.archive)}`);
    await downloadShellPayloadArchive(pin, archivePath, deps, mirror);
    const stageDir = join(tmpDir, 'stage');
    await mkdir(stageDir, { recursive: true });
    await deps.extract(archivePath, pin.archive, stageDir);
    const stagedExe = join(stageDir, pin.exeRelPath);
    if (!(await pathExists(stagedExe))) {
      throw new ShellPayloadExtractError(pin, `expected executable not found: ${pin.exeRelPath}`);
    }
    const installDir = shellPayloadInstallDir(kimiHome, pin);
    await rm(installDir, { recursive: true, force: true });
    await rename(stageDir, installDir);
    const exePath = shellPayloadExePath(kimiHome, pin);
    const exeSha256 = await hashFileSha256(exePath);
    const status: ShellPayloadStatus = {
      kind,
      version: pin.version,
      sha256: pin.sha256,
      exePath,
      exeSha256,
      verifiedAt: now().toISOString(),
    };
    await writeShellPayloadStatus(kimiHome, status);
    return { status, installed: true };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export interface WindowsShellProvisionDepsOptions {
  readonly curlPath?: string;
  readonly tarPath?: string;
}

export interface ShellPayloadArchiveDownload {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly source: string;
}

export function resolveDownloadCandidates(
  url: string,
  mirror: string | undefined,
): readonly string[] {
  const mirrored = applyDownloadMirror(url, mirror);
  return mirrored === url ? [url] : [mirrored, url];
}

export async function downloadShellPayloadArchive(
  pin: ShellPayloadPin,
  destPath: string,
  deps: ShellProvisionDeps,
  mirror?: string,
): Promise<ShellPayloadArchiveDownload> {
  const candidates = resolveDownloadCandidates(pin.url, mirror);
  const failures: string[] = [];
  let transportFailed = false;
  let integrityError: ShellPayloadIntegrityError | undefined;
  for (const candidate of candidates) {
    try {
      await deps.download(candidate, destPath);
    } catch (error) {
      transportFailed = true;
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const sha256 = await hashFileSha256(destPath);
    if (sha256 === pin.sha256) {
      const { size } = await stat(destPath);
      return { path: destPath, sha256, sizeBytes: size, source: candidate };
    }
    integrityError = new ShellPayloadIntegrityError(pin, sha256);
    failures.push(`${candidate}: sha256 mismatch (got ${sha256})`);
    await rm(destPath, { force: true });
  }
  if (integrityError !== undefined && !transportFailed) throw integrityError;
  throw new Error(`download failed from every source:\n${failures.join('\n')}`);
}

export function createWindowsShellProvisionDeps(
  options: WindowsShellProvisionDepsOptions = {},
): ShellProvisionDeps {
  const curl = options.curlPath ?? systemToolPath('curl.exe');
  const tar = options.tarPath ?? systemToolPath('tar.exe');
  return {
    download: async (url, destPath) => {
      await runCommand(curl, [
        '-sL',
        '--ssl-no-revoke',
        '--retry',
        '5',
        '--retry-all-errors',
        '--retry-delay',
        '2',
        '--max-time',
        '1800',
        '-o',
        destPath,
        url,
      ]);
    },
    extract: async (archivePath, archive, destDir) => {
      if (archive === 'zip') {
        await runCommand(tar, ['-xf', archivePath, '-C', destDir]);
        return;
      }
      await runCommand(archivePath, [`-o${destDir}`, '-y']);
    },
  };
}

async function readExistingStatus(
  kimiHome: string,
  kind: ShellPayloadKind,
): Promise<ShellPayloadStatus | undefined> {
  try {
    return await readShellPayloadStatus(kimiHome, kind);
  } catch {
    return undefined;
  }
}

function archiveFileExtension(archive: ShellPayloadArchive): string {
  return archive === 'zip' ? 'zip' : '7z.exe';
}

function systemToolPath(name: string): string {
  const systemRoot = process.env['SystemRoot']?.trim();
  const root = systemRoot !== undefined && systemRoot.length > 0 ? systemRoot : 'C:\\Windows';
  return `${root}\\System32\\${name}`;
}

async function runCommand(file: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      file,
      args as string[],
      { windowsHide: true, timeout: 20 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve();
          return;
        }
        reject(
          new Error(`${file} failed: ${error.message}${stderr.length > 0 ? `\n${stderr}` : ''}`),
        );
      },
    );
  });
}
