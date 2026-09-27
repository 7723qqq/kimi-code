import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import builtinManifestRaw from '../../../../plugins/official/normify/kimi.plugin.json?raw';
// The `?raw` bundler loader inlines each file as its default export; the
// import linter cannot see through that loader.
// oxlint-disable-next-line eslint-plugin-import(default)
import builtinMcpBinRaw from '../../../../plugins/official/normify/bin/normify-mcp.mjs?raw';
import builtinSkillRaw from '../../../../plugins/official/normify/skills/normify-gen/SKILL.md?raw';

/**
 * The `normify` plugin ships with the CLI as a built-in default: on the first
 * `ensurePluginStore` call the host materializes the embedded plugin files and
 * installs them into the engine's plugin registry, so the normify-gen skill
 * and the 30 `normify_*` MCP tools are available with zero install steps.
 *
 * User choice is respected:
 * - an explicit disable (`/plugins` toggle) is recorded in the engine's
 *   registry and is never overridden — the seeder only ever installs what is
 *   missing;
 * - an explicit removal writes an opt-out marker next to the materialized
 *   copy, and the seeder stays away afterwards.
 */

export const BUILTIN_NORMIFY_PLUGIN_ID = 'normify';

const BUILTIN_PLUGIN_ID = BUILTIN_NORMIFY_PLUGIN_ID;

/** Sibling marker for `removePlugin`: once present the seeder never reinstalls. */
const OPT_OUT_SUFFIX = '.optout';

interface BuiltinPluginFile {
  readonly relativePath: string;
  readonly content: string;
}

const BUILTIN_PLUGIN_FILES: readonly BuiltinPluginFile[] = [
  { relativePath: 'kimi.plugin.json', content: builtinManifestRaw },
  { relativePath: 'bin/normify-mcp.mjs', content: builtinMcpBinRaw },
  { relativePath: 'skills/normify-gen/SKILL.md', content: builtinSkillRaw },
];

/** Version of the bundled plugin copy, read from the embedded manifest. */
function bundledVersion(): string {
  const manifest = JSON.parse(builtinManifestRaw) as { version?: unknown };
  return typeof manifest.version === 'string' ? manifest.version : '0';
}

/**
 * Root directory holding the materialized built-in plugin copies, inside the
 * engine data dir so it never collides with user-managed installs
 * (`<dataDir>/plugins/<id>`).
 */
export function builtinPluginsRoot(engineDataDir: string): string {
  return join(engineDataDir, 'builtin-plugins');
}

/** Whether the user explicitly removed the built-in normify plugin. */
export function builtinPluginOptedOut(engineDataDir: string): boolean {
  return existsSync(join(builtinPluginsRoot(engineDataDir), BUILTIN_PLUGIN_ID + OPT_OUT_SUFFIX));
}

/** Record (or clear) the opt-out marker for the built-in normify plugin. */
export function setBuiltinPluginOptOut(engineDataDir: string, optedOut: boolean): void {
  const root = builtinPluginsRoot(engineDataDir);
  const marker = join(root, BUILTIN_PLUGIN_ID + OPT_OUT_SUFFIX);
  if (optedOut) {
    mkdirSync(root, { recursive: true });
    writeFileSync(marker, '');
    return;
  }
  try {
    if (existsSync(marker)) unlinkSync(marker);
  } catch {
    // Best effort: a stale marker only means the plugin stays uninstalled.
  }
}

/**
 * Write the embedded plugin copy when missing or outdated. Idempotent and
 * content-addressed by version: unchanged versions keep their directory (and
 * the installed plugin's registry record untouched).
 */
export function materializeBuiltinPlugins(engineDataDir: string): string | undefined {
  // Escape hatch for tests and CI: a run that never wants the built-in
  // plugin (e.g. it would spawn a child MCP server whose handles outlive
  // the harness on Windows) can switch seeding off entirely.
  if (process.env['KIMI_CODE_BUILTIN_PLUGINS'] === 'off') return undefined;
  if (builtinPluginOptedOut(engineDataDir)) return undefined;
  const root = join(builtinPluginsRoot(engineDataDir), BUILTIN_PLUGIN_ID);
  const versionFile = join(root, '.bundled-version');
  const version = bundledVersion();
  if (existsSync(versionFile)) {
    try {
      if (readFileSync(versionFile, 'utf8').trim() === version) return root;
    } catch {
      // Fall through and rewrite the copy.
    }
  }
  for (const file of BUILTIN_PLUGIN_FILES) {
    const target = join(root, ...file.relativePath.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  writeFileSync(versionFile, version + '\n');
  return root;
}
