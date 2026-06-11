/**
 * Common types for the OS service manager that powers
 * `kimi server install/uninstall/start/stop/restart/status`.
 *
 * Per-platform implementations (launchd / systemd / schtasks) all implement
 * `ServiceManager` and are selected at runtime by `resolveServiceManager` in
 * `./service.ts`.
 *
 * Modelled on `../openclaw/src/daemon/service-types.ts` and trimmed to the
 * minimum needed for a first cross-platform cut. Edge cases openclaw handles —
 * env wrappers, restart-handoff, restart-deferral — are out of scope here.
 */

import type { ServerLogLevel } from '../services/pinoLoggerService';

/** Arguments accepted by `install`. */
export interface InstallArgs {
  /** Bind host for the installed service. */
  host: string;
  /** Bind port for the installed service. */
  port: number;
  /** Log level recorded into the generated unit. */
  logLevel: ServerLogLevel;
  /** Overwrite an existing install rather than failing. */
  force?: boolean;
}

/** Result of a successful install. */
export interface InstallResult {
  status: 'installed' | 'replaced' | 'already-installed';
  message: string;
  /** macOS only: absolute path of the LaunchAgent plist that was written. */
  plistPath?: string;
  /** Linux only: absolute path of the systemd --user unit that was written. */
  unitPath?: string;
  /** Windows only: scheduled-task name that was registered. */
  taskName?: string;
}

/** Result of `uninstall|start|stop|restart`. */
export interface LifecycleResult {
  ok: boolean;
  /** Operator-facing description of what happened (or why it didn't). */
  message: string;
}

/** Snapshot returned by `status` — see openclaw server-cli/status.gather.ts for the inspiration. */
export interface ServiceStatus {
  /** Platform of the running CLI process. */
  platform: 'darwin' | 'linux' | 'win32';
  /** Is the OS-level service definition present? (plist / unit / task) */
  installed: boolean;
  /** Is the service currently running? */
  running: boolean;
  /** Main PID, if known. */
  pid?: number;
  /** Bind port recorded in the install plan. */
  port?: number;
  /** Bind host recorded in the install plan. */
  host?: string;
  /** Absolute path of the supervisor log (best-effort). */
  logPath?: string;
  /** macOS only: launchd label. */
  label?: string;
  /** Linux only: systemd unit name. */
  unitName?: string;
  /** Windows only: scheduled-task name. */
  taskName?: string;
  /** Free-form diagnostic lines for the human renderer. */
  notes?: readonly string[];
}

/**
 * Cross-platform service manager. Each backend implements all six methods,
 * even if the implementation is "no-op + ok message" (e.g. `start` on a
 * platform where install already activates the service).
 */
export interface ServiceManager {
  install(args: InstallArgs): Promise<InstallResult>;
  uninstall(): Promise<LifecycleResult>;
  start(): Promise<LifecycleResult>;
  stop(): Promise<LifecycleResult>;
  restart(): Promise<LifecycleResult>;
  status(): Promise<ServiceStatus>;
}

/** Thrown when the running platform is not yet supported by a backend. */
export class ServiceUnsupportedError extends Error {
  override readonly name = 'ServiceUnsupportedError';
  readonly code = 'ESERVICE_UNSUPPORTED' as const;
  readonly exitCode = 2 as const;
  readonly platform: string;
  constructor(platform: string) {
    super(`Kimi server service management is not yet supported on ${platform}.`);
    this.platform = platform;
  }
}
