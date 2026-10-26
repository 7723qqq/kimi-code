import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { arch, platform } from 'node:os';
import { join } from 'node:path';

import { kimiCodeCdnBase } from '#/constant/app';
import { t } from '#/i18n';
import { getBinDir } from '#/utils/paths';
import { resolveCommandPath } from '#/utils/process/resolve-command';

const CANDIDATES = ['fd', 'fdfind'];
const DOWNLOAD_TIMEOUT_MS = 120_000;

const FD_ARCHIVE_SHA256: Record<string, string> = {
  'fd-v10.4.2-aarch64-apple-darwin.tar.gz':
    '623dc0afc81b92e4d4606b380d7bc91916ba7b97814263e554d50923a39e480a',
  'fd-v10.3.0-x86_64-apple-darwin.tar.gz':
    '50d30f13fe3d5914b14c4fff5abcbd4d0cdab4b855970a6956f4f006c17117a3',
  'fd-v10.4.2-aarch64-unknown-linux-gnu.tar.gz':
    '6c51f7c5446b3338b1e401ff15dc194c590bb2fa64fd43ff3278300f073adec5',
  'fd-v10.4.2-x86_64-unknown-linux-musl.tar.gz':
    'e3257d48e29a6be965187dbd24ce9af564e0fe67b3e73c9bdcd180f4ec11bdde',
  'fd-v10.4.2-aarch64-pc-windows-msvc.zip':
    '4f9110c2d5b33a7f760bfa5510f4c113d828109f7277d421b1053a9943c0fc92',
  'fd-v10.4.2-x86_64-pc-windows-msvc.zip':
    'b2816e506390a89941c63c9187d58a3cc10e9a55f2ef0685f9ea0eccaf7c98c8',
};

export interface FdSpawnResult {
  readonly status: number | null;
  readonly error?: { readonly message: string } | undefined;
  readonly stderr?: { toString(): string } | undefined;
}

export type FdSpawnSync = (
  command: string,
  args: readonly string[],
  options: { readonly stdio: 'ignore' | 'pipe' },
) => FdSpawnResult;

export interface FdDetectDeps {
  readonly spawnSync: FdSpawnSync;
  readonly resolveCommandPath: (command: string) => string | undefined;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => number;
  readonly binDir: () => string;
  readonly fetch: typeof fetch;
}

export function createFdDetectDeps(overrides: Partial<FdDetectDeps> = {}): FdDetectDeps {
  return {
    spawnSync: (command, args, options) => {
      try {
        const result = Bun.spawnSync({
          cmd: [command, ...args],
          stdout: options.stdio === 'pipe' ? 'pipe' : 'ignore',
          stderr: options.stdio === 'pipe' ? 'pipe' : 'ignore',
        });
        const stderrBytes = result.stderr;
        return {
          status: result.exitCode,
          error: undefined,
          stderr:
            stderrBytes === undefined || stderrBytes.length === 0
              ? undefined
              : { toString: () => new TextDecoder().decode(stderrBytes) },
        };
      } catch (error) {
        return {
          status: null,
          error: { message: error instanceof Error ? error.message : String(error) },
          stderr: undefined,
        };
      }
    },
    resolveCommandPath: (command) => resolveCommandPath(command),
    platform: platform(),
    arch: arch(),
    env: process.env,
    now: () => Date.now(),
    binDir: () => getBinDir(),
    fetch,
    ...overrides,
  };
}

export function detectFdPath(overrides: Partial<FdDetectDeps> = {}): string | null {
  const deps = createFdDetectDeps(overrides);
  const managed = getManagedFdPath(deps);
  if (managed !== null) return managed;
  return detectSystemFdPath(deps);
}

export async function ensureFdPath(overrides: Partial<FdDetectDeps> = {}): Promise<string | null> {
  const deps = createFdDetectDeps(overrides);
  const existing = detectFdPath(deps);
  if (existing !== null) return existing;

  try {
    return await downloadFd(deps);
  } catch {
    return null;
  }
}

function detectSystemFdPath(deps: FdDetectDeps): string | null {
  for (const name of CANDIDATES) {
    const commandPath = deps.resolveCommandPath(name);
    if (commandPath === undefined) continue;
    try {
      const result = deps.spawnSync(commandPath, ['--version'], { stdio: 'ignore' });
      if (result.status === 0) return commandPath;
    } catch {
      // ENOENT, EACCES, etc. — try next candidate.
    }
  }
  return null;
}

function getManagedFdPath(deps: FdDetectDeps): string | null {
  const binaryPath = getManagedFdBinaryPath(deps);
  if (!existsSync(binaryPath)) return null;
  try {
    const result = deps.spawnSync(binaryPath, ['--version'], { stdio: 'ignore' });
    return result.status === 0 ? binaryPath : null;
  } catch {
    return null;
  }
}

function getManagedFdBinaryPath(deps: FdDetectDeps): string {
  return join(deps.binDir(), deps.platform === 'win32' ? 'fd.exe' : 'fd');
}

export function getFdAssetName(plat = platform(), architecture = arch()): string | null {
  if (plat === 'darwin') {
    if (architecture === 'arm64') return 'fd-v10.4.2-aarch64-apple-darwin.tar.gz';
    if (architecture === 'x64') return 'fd-v10.3.0-x86_64-apple-darwin.tar.gz';
    return null;
  }
  if (plat === 'linux') {
    if (architecture === 'arm64') return 'fd-v10.4.2-aarch64-unknown-linux-gnu.tar.gz';
    if (architecture === 'x64') return 'fd-v10.4.2-x86_64-unknown-linux-musl.tar.gz';
    return null;
  }
  if (plat === 'win32') {
    if (architecture === 'arm64') return 'fd-v10.4.2-aarch64-pc-windows-msvc.zip';
    if (architecture === 'x64') return 'fd-v10.4.2-x86_64-pc-windows-msvc.zip';
    return null;
  }
  return null;
}

async function downloadFd(deps: FdDetectDeps): Promise<string | null> {
  const assetName = getFdAssetName(deps.platform, deps.arch);
  if (assetName === null) return null;
  const expectedSha256 = FD_ARCHIVE_SHA256[assetName];
  if (expectedSha256 === undefined) return null;

  const binDir = deps.binDir();
  mkdirSync(binDir, { recursive: true });

  const binaryPath = getManagedFdBinaryPath(deps);
  const extractDir = join(
    binDir,
    `fd_extract_${process.pid}_${deps.now()}_${Math.random().toString(36).slice(2, 10)}`,
  );
  mkdirSync(extractDir, { recursive: true });
  const archivePath = join(extractDir, assetName);

  try {
    const downloadUrl = `${kimiCodeCdnBase()}/fd/${assetName}`;
    await downloadFile(deps, downloadUrl, archivePath);
    await verifyArchive(archivePath, expectedSha256);
    extractArchive(deps, archivePath, extractDir, assetName);

    const binaryName = deps.platform === 'win32' ? 'fd.exe' : 'fd';
    const extractedBinary = findBinaryRecursively(extractDir, binaryName);
    if (extractedBinary === null) return null;

    rmSync(binaryPath, { force: true });
    renameSync(extractedBinary, binaryPath);
    if (deps.platform !== 'win32') {
      chmodSync(binaryPath, 0o755);
    }
    return binaryPath;
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

async function verifyArchive(path: string, expectedSha256: string): Promise<void> {
  const actualSha256 = new Bun.CryptoHasher('sha256').update(await Bun.file(path).bytes()).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error(`fd archive checksum mismatch: ${actualSha256} !== ${expectedSha256}`);
  }
}

async function downloadFile(deps: FdDetectDeps, url: string, dest: string): Promise<void> {
  const response = await deps.fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Failed to download fd: ${response.status}`);
  }
  if (response.body === null) {
    throw new Error(t('tui.statusMessages.fdDownloadEmptyResponse'));
  }
  await Bun.write(dest, response.body);
}

function extractArchive(
  deps: FdDetectDeps,
  archivePath: string,
  extractDir: string,
  assetName: string,
): void {
  if (assetName.endsWith('.tar.gz')) {
    runExtractionCommand(deps, 'tar', ['xzf', archivePath, '-C', extractDir]);
    return;
  }
  if (assetName.endsWith('.zip')) {
    if (deps.platform === 'win32') {
      runExtractionCommand(deps, getWindowsTarCommand(deps), ['xf', archivePath, '-C', extractDir]);
      return;
    }
    runExtractionCommand(deps, 'unzip', ['-q', archivePath, '-d', extractDir]);
    return;
  }
  throw new Error(`Unsupported fd archive format: ${assetName}`);
}

function runExtractionCommand(deps: FdDetectDeps, command: string, args: readonly string[]): void {
  const result = deps.spawnSync(command, [...args], { stdio: 'pipe' });
  if (!result.error && result.status === 0) return;
  const stderr = result.stderr?.toString().trim() ?? '';
  const detail =
    result.error?.message ?? (stderr.length > 0 ? stderr : `exit status ${String(result.status)}`);
  throw new Error(`Failed to extract fd with ${command}: ${detail}`);
}

function getWindowsTarCommand(deps: FdDetectDeps): string {
  const systemRoot = deps.env['SystemRoot'] ?? deps.env['WINDIR'];
  if (systemRoot !== undefined) {
    const systemTar = join(systemRoot, 'System32', 'tar.exe');
    if (existsSync(systemTar)) return systemTar;
  }
  return 'tar.exe';
}

function findBinaryRecursively(rootDir: string, binaryName: string): string | null {
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (currentDir === undefined) continue;
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isFile() && entry.name === binaryName) return fullPath;
      if (entry.isDirectory()) stack.push(fullPath);
    }
  }
  return null;
}
