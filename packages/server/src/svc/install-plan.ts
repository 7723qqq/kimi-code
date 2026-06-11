/**
 * Pure install-plan model — the "what to install" decision, separated from
 * "how to install it" (which lives in launchd/systemd/schtasks backends).
 *
 * The plan is JSON-serialized to `install.json` on install so `status` can
 * report the configured host/port/log-level even when the supervisor is
 * temporarily down. On uninstall the file is removed.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { installPlanPath } from './paths';
import type { InstallArgs } from './types';

export interface InstallPlan {
  /** The host the supervised server binds to. */
  host: string;
  /** The port the supervised server binds to. */
  port: number;
  /** Log level passed to the supervised server. */
  logLevel: string;
  /** Absolute path of the binary the supervisor launches. */
  program: string;
  /** Argv passed to `program` — already includes the `server run` words and bind flags. */
  programArguments: string[];
  /** Absolute path of the supervisor log file. */
  logPath: string;
  /** Wall-clock when the plan was last written. */
  installedAt: string;
}

export interface BuildInstallPlanInput extends InstallArgs {
  /** Absolute path of the binary the supervisor should launch (e.g. /usr/local/bin/kimi). */
  program: string;
  /** Absolute path the supervisor should redirect stdout/stderr to. */
  logPath: string;
  /** Override `new Date().toISOString()` — used in tests for deterministic plans. */
  nowIso?: string;
}

/** Build a fresh install plan. Pure — no fs writes. */
export function buildInstallPlan(input: BuildInstallPlanInput): InstallPlan {
  return {
    host: input.host,
    port: input.port,
    logLevel: input.logLevel,
    program: input.program,
    programArguments: [
      input.program,
      'server',
      'run',
      '--host',
      input.host,
      '--port',
      String(input.port),
      '--log-level',
      input.logLevel,
    ],
    logPath: input.logPath,
    installedAt: input.nowIso ?? new Date().toISOString(),
  };
}

/** Persist the plan to `~/.kimi-code/server/install.json`. */
export function writeInstallPlan(plan: InstallPlan, path: string = installPlanPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
}

/** Read the recorded plan. Returns undefined on missing or unparseable file. */
export function readInstallPlan(path: string = installPlanPath()): InstallPlan | undefined {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isInstallPlan(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Delete the plan on uninstall. Best-effort: missing file is not an error. */
export function deleteInstallPlan(path: string = installPlanPath()): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort.
  }
}

function isInstallPlan(value: unknown): value is InstallPlan {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['host'] === 'string' &&
    typeof v['port'] === 'number' &&
    typeof v['logLevel'] === 'string' &&
    typeof v['program'] === 'string' &&
    Array.isArray(v['programArguments']) &&
    (v['programArguments'] as unknown[]).every((arg) => typeof arg === 'string') &&
    typeof v['logPath'] === 'string' &&
    typeof v['installedAt'] === 'string'
  );
}
