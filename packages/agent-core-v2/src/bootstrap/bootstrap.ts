/**
 * `bootstrap` domain (L1) — frozen startup snapshot and composition root.
 *
 * Defines the `IBootstrapService`, the snapshot of the world the process runs
 * in, resolved once at startup and frozen for the process: observed host facts
 * (`platform`, `arch`, `cwd`, `osHomeDir`, `getEnv`, `detect`) and the app path
 * layout (`homeDir`, `configPath`, …). `resolveBootstrapOptions` is the single
 * place that reads `process.env` / `os.homedir()` / invocation input to resolve
 * the snapshot; everything downstream reads from `IBootstrapService` instead of
 * touching `process` directly. Bound at Core scope. Also seeds the Core storage
 * roles (`IStorageService`, `IAppendLogStorage`, `IAtomicDocumentStorage`,
 * `IBlobStorage`) with a `FileStorageService` rooted at `homeDir` so the byte
 * layer (and every Store above it) persists to disk.
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

import { join } from 'pathe';

import type { Environment } from '@moonshot-ai/kaos';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { createCoreScope, type Scope, type ScopeSeed } from '#/_base/di/scope';
import {
  FileStorageService,
  IAppendLogStorage,
  IAtomicDocumentStorage,
  IBlobStorage,
  IStorageService,
} from '#/storage';

export interface IBootstrapOptions {
  readonly homeDir: string;
  readonly configPath: string;
  readonly osHomeDir: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export const IBootstrapOptions: ServiceIdentifier<IBootstrapOptions> =
  createDecorator<IBootstrapOptions>('bootstrapOptions');

export interface IBootstrapService {
  readonly _serviceBrand: undefined;

  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly cwd: string;
  readonly osHomeDir: string;

  readonly homeDir: string;
  readonly configPath: string;
  readonly sessionsDir: string;
  readonly blobsDir: string;
  readonly storeDir: string;
  readonly cacheDir: string;
  readonly logsDir: string;

  getEnv(name: string): string | undefined;
  detect(): Promise<Environment>;
}

export const IBootstrapService: ServiceIdentifier<IBootstrapService> =
  createDecorator<IBootstrapService>('bootstrapService');

export interface BootstrapInput {
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly osHomeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly cwd?: string;
}

export function resolveBootstrapOptions(input: BootstrapInput = {}): IBootstrapOptions {
  const env = input.env ?? process.env;
  const osHomeDir = input.osHomeDir ?? homedir();
  const homeDir = resolveKimiHome(input.homeDir, env, osHomeDir);
  const configPath = input.configPath ?? join(homeDir, 'config.toml');
  return {
    homeDir,
    configPath,
    osHomeDir,
    platform: input.platform ?? process.platform,
    arch: input.arch ?? process.arch,
    cwd: input.cwd ?? process.cwd(),
    env,
  };
}

export function bootstrapSeed(input: BootstrapInput = {}): ScopeSeed {
  return [[IBootstrapOptions as ServiceIdentifier<unknown>, resolveBootstrapOptions(input)]];
}

export interface BootstrapResult {
  readonly core: Scope;
}

export function bootstrap(input: BootstrapInput = {}, extraSeeds: ScopeSeed = []): BootstrapResult {
  const options = resolveBootstrapOptions(input);
  const core = createCoreScope({
    extra: [...bootstrapSeed(input), ...storageSeed(options), ...extraSeeds],
  });
  return { core };
}

function storageSeed(options: IBootstrapOptions): ScopeSeed {
  const fileStorage = new FileStorageService(options.homeDir);
  return [
    [IStorageService as ServiceIdentifier<unknown>, fileStorage],
    [IAppendLogStorage as ServiceIdentifier<unknown>, fileStorage],
    [IAtomicDocumentStorage as ServiceIdentifier<unknown>, fileStorage],
    [IBlobStorage as ServiceIdentifier<unknown>, fileStorage],
  ];
}

export function resolveKimiHome(
  homeDir?: string,
  env: NodeJS.ProcessEnv = process.env,
  osHomeDir: string = homedir(),
): string {
  return homeDir ?? env['KIMI_CODE_HOME'] ?? join(osHomeDir, '.kimi-code');
}

export function resolveConfigPath(input: {
  readonly homeDir?: string;
  readonly configPath?: string;
}): string {
  return input.configPath ?? join(resolveKimiHome(input.homeDir), 'config.toml');
}

export function ensureKimiHome(homeDir: string): void {
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
}
