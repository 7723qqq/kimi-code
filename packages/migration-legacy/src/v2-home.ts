// `~/.kimi-code/` home subdirectory inventory (M4 Q1 + M5).
//
// v2's bootstrap places seven subdirectories under the home (see
// `agent-core-v2/src/app/bootstrap/bootstrapService.ts:45-50`):
// `sessions/`, `blobs/`, `store/`, `cache/`, `logs/`, `credentials/`,
// plus the top-level `config.toml` / `local.toml` / `mcp.json`. The Rust
// engine added `engine-state/<workspace-key>/` (M4 Q2) but does not own any
// of the seven v2 subdirs.
//
// M4 Q1: when v2 is deleted (M5), every subdir below becomes orphaned
// (no Rust consumer). The `v2-detect` and `v2-export` subcommands
// (`./v2-detect.ts`, `./v2-export.ts`) help users discover and archive
// the data before the upgrade.

export interface V2Subdir {
  /** Path relative to the home, e.g. `'sessions'`. */
  readonly rel: string;
  /** Human label, used in the detect/export report. */
  readonly label: string;
  /** v2 component that owns the subdir. */
  readonly owner: string;
  /** One-line format description for the manifest. */
  readonly format: string;
  /** Whether the Rust engine has a read/write replacement today. */
  readonly migrated: boolean;
}

export const V2_HOME_SUBDIRS: readonly V2Subdir[] = [
  {
    rel: 'sessions',
    label: 'session transcripts',
    owner: 'ISessionStore (v2 SessionStore)',
    format: 'JSONL — one event per line, gzip-compressed after a session closes',
    migrated: false,
  },
  {
    rel: 'store',
    label: 'append log (durable state bridge + undo anchors)',
    owner: 'IAppendLogStore (v2 bootstrapService.storeDir)',
    format: 'binary — append log with periodic snapshots',
    migrated: false,
  },
  {
    rel: 'cache',
    label: 'minidb cache (search index + session index mirror)',
    owner: 'IGlobalSearchService + ISessionIndexMirror',
    format: 'minidb WAL + snapshot (read-your-writes cache)',
    migrated: false,
  },
  {
    rel: 'credentials',
    label: 'OAuth / GitHub credential vault',
    owner: 'IAuthLegacyService + IOAuthService',
    format: 'encrypted JSON (host-managed symmetric key)',
    migrated: false,
  },
  {
    rel: 'blobs',
    label: 'binary blobs (file originals, image compression cache)',
    owner: 'IAgentBlobService',
    format: 'binary — sha256-keyed',
    migrated: false,
  },
  {
    rel: 'logs',
    label: 'application logs',
    owner: 'logging',
    format: 'text log files (kimi-code*.log)',
    migrated: false,
  },
  {
    rel: '.',
    label: 'top-level config (config.toml / local.toml / mcp.json)',
    owner: 'IConfigService + IMcpManagementService',
    format: 'TOML / JSON',
    migrated: false,
  },
];

/**
 * The `'.'` entry represents the top-level config files at the home root,
 * not a directory. `v2-detect` and `v2-export` limit the walk for this
 * entry to these filenames (no recursion into subdirs — those are owned
 * by their respective V2_HOME_SUBDIRS entries).
 */
export const TOP_LEVEL_CONFIG_FILES: readonly string[] = [
  'config.toml',
  'local.toml',
  'mcp.json',
];
