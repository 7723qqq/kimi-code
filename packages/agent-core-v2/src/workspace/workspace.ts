/**
 * `workspace` domain (cross-cutting) — session-scope workspace service.
 *
 * Defines the public contract of the current session's workspace: the primary
 * `workDir` plus any `additionalDirs`, and the path helpers built on top of
 * them (`resolve` / `isWithin` / `assertAllowed`). Session-scoped — one
 * instance per session — so consumers never thread a `workspaceId` around.
 *
 * This is the semantic layer above `kaos`: `ISessionKaosService` owns the raw
 * `Kaos` environments and additional roots, while `IWorkspaceService` turns
 * them into workspace-relative path operations. Dependency direction is
 * `workspace → kaos`, never the reverse (see `docs/service-design.md` §5).
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { PathAccessOperation } from '#/_base/tools/policies/path-access';
import type { WorkspaceConfig } from '#/_base/tools/support/workspace';

export interface IWorkspaceService {
  readonly _serviceBrand: undefined;

  /** Primary workspace directory (absolute). Reflects the session kaos cwd. */
  readonly workDir: string;
  /** Extra allowed roots (e.g. `--add-dir` CLI flag). */
  readonly additionalDirs: readonly string[];

  /**
   * Resolve `rel` to an absolute, canonical path. Relative paths are resolved
   * against `workDir`; absolute paths are normalized as-is. Lexical only — no
   * filesystem I/O.
   */
  resolve(rel: string): string;

  /** True iff `path` (resolved against `workDir`) sits inside `workDir` or any `additionalDirs`. */
  isWithin(path: string): boolean;

  /**
   * Throw if `path` escapes the workspace for `op` (or matches a sensitive
   * file); returns the canonical absolute path when it passes.
   */
  assertAllowed(path: string, op: PathAccessOperation): string;

  /** Snapshot as a `WorkspaceConfig` value object for the path-access helpers. */
  toConfig(): WorkspaceConfig;

  /** Add an extra allowed root for this session (no-op if already present). */
  addAdditionalDir(dir: string): void;
  /** Remove an extra allowed root from this session. */
  removeAdditionalDir(dir: string): void;
}

export const IWorkspaceService: ServiceIdentifier<IWorkspaceService> =
  createDecorator<IWorkspaceService>('workspaceService');
