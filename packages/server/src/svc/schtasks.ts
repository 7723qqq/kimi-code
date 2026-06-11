/**
 * Windows Scheduled Task service manager.
 *
 * Implements `ServiceManager` for win32 by importing a UTF-16 LE task XML via
 * `schtasks /Create /XML` and driving it with `schtasks /Run|/End|/Delete|/Query`.
 *
 * Mirrors the shape of `../openclaw/src/daemon/schtasks.ts` but trimmed to the
 * minimum needed for `kimi server install/uninstall/start/stop/restart/status`.
 * The wrapper-script / launcher-cmd indirection openclaw uses is dropped — we
 * point `<Command>` at the kimi binary directly.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileUtf8, type ExecOptions, type ExecResult } from './exec';
import {
  buildInstallPlan,
  deleteInstallPlan,
  readInstallPlan,
  writeInstallPlan,
  type InstallPlan,
} from './install-plan';
import { KIMI_SERVER_TASK_NAME, supervisorLogPath as defaultSupervisorLogPath } from './paths';
import { buildScheduledTaskXml, parseSchtasksQuery } from './schtasks-xml';
import type {
  InstallArgs,
  InstallResult,
  LifecycleResult,
  ServiceManager,
  ServiceStatus,
} from './types';

export interface SchtasksManagerDeps {
  /** Run `schtasks <args>`. Tests stub this to assert the exact argv. */
  execSchtasks(args: readonly string[], options?: ExecOptions): Promise<ExecResult>;
  /** Resolve the binary the task should run. Defaults to argv[1]. */
  resolveProgram(): string;
  /** Absolute path of the supervisor stdout/stderr log file. */
  logPath(): string;
  /** Write the UTF-16 task XML to a temp file and return its path. */
  writeTaskXml(xml: string): string;
  /** Check whether the task already exists (by name). */
  taskExists(): Promise<boolean>;
}

const DEFAULT_DEPS: SchtasksManagerDeps = {
  execSchtasks: (args, options) =>
    execFileUtf8('schtasks', args, { windowsHide: true, ...options }),
  resolveProgram: () => process.argv[1] ?? 'kimi.exe',
  logPath: defaultSupervisorLogPath,
  writeTaskXml: defaultWriteTaskXml,
  taskExists: defaultTaskExists,
};

export function createSchtasksManager(
  overrides: Partial<SchtasksManagerDeps> = {},
): ServiceManager {
  const deps: SchtasksManagerDeps = { ...DEFAULT_DEPS, ...overrides };

  async function install(args: InstallArgs): Promise<InstallResult> {
    const program = deps.resolveProgram();
    const logPath = deps.logPath();
    const plan = buildInstallPlan({ ...args, program, logPath });

    const alreadyInstalled = await deps.taskExists();
    if (alreadyInstalled && args.force !== true) {
      return {
        status: 'already-installed',
        message: `Scheduled task "${KIMI_SERVER_TASK_NAME}" already exists. Rerun with --force to replace it.`,
        taskName: KIMI_SERVER_TASK_NAME,
      };
    }

    const argString = serializeArguments(plan);
    const xml = buildScheduledTaskXml({
      description: 'Kimi Code local server (managed by `kimi server install`)',
      command: plan.program,
      ...(argString.length > 0 ? { arguments: argString } : {}),
    });
    const xmlPath = deps.writeTaskXml(xml);

    try {
      const createArgs = ['/Create', '/TN', KIMI_SERVER_TASK_NAME, '/XML', xmlPath];
      if (alreadyInstalled) {
        createArgs.push('/F');
      }
      const create = await deps.execSchtasks(createArgs);
      if (create.code !== 0) {
        throw new Error(
          `schtasks /Create failed (code ${create.code}): ${detail(create) ?? 'unknown error'}`,
        );
      }
    } finally {
      // The temp xml file is no longer needed once the task is registered.
      try {
        rmSync(xmlPath, { force: true });
      } catch {
        // Best-effort cleanup.
      }
    }

    writeInstallPlan(plan);

    // The task fires at logon; start it immediately so install also activates.
    const run = await deps.execSchtasks(['/Run', '/TN', KIMI_SERVER_TASK_NAME]);
    if (run.code !== 0) {
      // Install succeeded; activation failed. Surface a note but don't roll back.
      return {
        status: alreadyInstalled ? 'replaced' : 'installed',
        message: `Task ${alreadyInstalled ? 'replaced' : 'installed'} but /Run failed: ${detail(run) ?? 'unknown error'}.`,
        taskName: KIMI_SERVER_TASK_NAME,
      };
    }

    return {
      status: alreadyInstalled ? 'replaced' : 'installed',
      message: `Kimi server scheduled task ${alreadyInstalled ? 'replaced' : 'installed'} (${KIMI_SERVER_TASK_NAME}, port ${plan.port}).`,
      taskName: KIMI_SERVER_TASK_NAME,
    };
  }

  async function uninstall(): Promise<LifecycleResult> {
    if (!(await deps.taskExists())) {
      deleteInstallPlan();
      return { ok: true, message: 'Scheduled task was not installed; nothing to remove.' };
    }
    // /End best-effort — task might already be stopped.
    await deps.execSchtasks(['/End', '/TN', KIMI_SERVER_TASK_NAME]).catch(() => undefined);
    const del = await deps.execSchtasks(['/Delete', '/TN', KIMI_SERVER_TASK_NAME, '/F']);
    if (del.code !== 0) {
      return {
        ok: false,
        message: `schtasks /Delete failed: ${detail(del) ?? 'unknown error'}`,
      };
    }
    deleteInstallPlan();
    return { ok: true, message: `Scheduled task removed (${KIMI_SERVER_TASK_NAME}).` };
  }

  async function start(): Promise<LifecycleResult> {
    if (!(await deps.taskExists())) {
      return {
        ok: false,
        message: 'Scheduled task is not installed. Run `kimi server install` first.',
      };
    }
    const result = await deps.execSchtasks(['/Run', '/TN', KIMI_SERVER_TASK_NAME]);
    if (result.code !== 0) {
      return {
        ok: false,
        message: `schtasks /Run failed: ${detail(result) ?? 'unknown error'}`,
      };
    }
    return { ok: true, message: `Kimi server started (${KIMI_SERVER_TASK_NAME}).` };
  }

  async function stop(): Promise<LifecycleResult> {
    const result = await deps.execSchtasks(['/End', '/TN', KIMI_SERVER_TASK_NAME]);
    if (result.code !== 0) {
      return {
        ok: false,
        message: `schtasks /End failed: ${detail(result) ?? 'unknown error'}`,
      };
    }
    return { ok: true, message: `Kimi server stopped (${KIMI_SERVER_TASK_NAME}).` };
  }

  async function restart(): Promise<LifecycleResult> {
    const end = await deps.execSchtasks(['/End', '/TN', KIMI_SERVER_TASK_NAME]);
    if (end.code !== 0) {
      return {
        ok: false,
        message: `schtasks /End failed during restart: ${detail(end) ?? 'unknown error'}`,
      };
    }
    const run = await deps.execSchtasks(['/Run', '/TN', KIMI_SERVER_TASK_NAME]);
    if (run.code !== 0) {
      return {
        ok: false,
        message: `schtasks /Run failed during restart: ${detail(run) ?? 'unknown error'}`,
      };
    }
    return { ok: true, message: `Kimi server restarted (${KIMI_SERVER_TASK_NAME}).` };
  }

  async function status(): Promise<ServiceStatus> {
    const plan = readInstallPlan();
    const installed = await deps.taskExists();

    const base: ServiceStatus = {
      platform: 'win32',
      installed,
      running: false,
      taskName: KIMI_SERVER_TASK_NAME,
      ...(plan?.host !== undefined ? { host: plan.host } : {}),
      ...(plan?.port !== undefined ? { port: plan.port } : {}),
      logPath: deps.logPath(),
    };

    if (!installed) {
      return { ...base, notes: ['Scheduled task is not installed.'] };
    }

    const query = await deps.execSchtasks([
      '/Query',
      '/TN',
      KIMI_SERVER_TASK_NAME,
      '/FO',
      'CSV',
      '/V',
    ]);
    if (query.code !== 0) {
      return {
        ...base,
        notes: [
          `schtasks /Query failed (code ${query.code}): ${detail(query) ?? 'unknown'}.`,
          'The task is registered but its state could not be read.',
        ],
      };
    }
    const row = parseSchtasksQuery(query.stdout);
    const taskStatus = row?.['Status'];
    const running = taskStatus === 'Running';
    return {
      ...base,
      running,
      notes: [`schtasks status: ${taskStatus ?? 'unknown'}`],
    };
  }

  return { install, uninstall, start, stop, restart, status };
}

/** Default temp-file writer for the task XML. Adds the UTF-16 LE BOM that schtasks /XML requires. */
function defaultWriteTaskXml(xml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-server-task-'));
  const xmlPath = join(dir, 'task.xml');
  const bom = Buffer.from([0xff, 0xfe]);
  const body = Buffer.from(xml, 'utf16le');
  writeFileSync(xmlPath, Buffer.concat([bom, body]));
  return xmlPath;
}

/** Default existence probe — `schtasks /Query /TN <name>` returns 0 if the task exists. */
async function defaultTaskExists(): Promise<boolean> {
  const res = await execFileUtf8('schtasks', ['/Query', '/TN', KIMI_SERVER_TASK_NAME], {
    windowsHide: true,
  });
  return res.code === 0;
}

/** Compose the argv suffix as one string for the task XML `<Arguments>` field. */
function serializeArguments(plan: InstallPlan): string {
  // First element of programArguments is the program itself; the rest is argv to pass.
  return plan.programArguments
    .slice(1)
    .map((arg) => (/\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg))
    .join(' ');
}

function detail(res: ExecResult): string | undefined {
  const text = (res.stderr || res.stdout).trim();
  return text.length > 0 ? text : undefined;
}

/** Convenience: synchronously check if the file at `path` exists. Exposed for tests. */
export function taskXmlExists(path: string): boolean {
  return existsSync(path);
}
