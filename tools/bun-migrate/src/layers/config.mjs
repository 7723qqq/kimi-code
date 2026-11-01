import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read one `.npmrc` value: strip a quoted wrapper and an unquoted trailing
 * comment, keeping `#` inside quotes.
 *
 * Without this, `registry="https://r.example/"` rendered as
 * `registry = ""https://r.example/""` — invalid TOML — and
 * `registry=https://r.example/ # internal` kept the comment inside the URL.
 */
function npmrcValue(raw) {
  let value = '';
  let quote;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote) {
      if (character === '\\' && index + 1 < raw.length) {
        value += raw[index + 1];
        index += 1;
        continue;
      }
      if (character === quote) {
        quote = undefined;
        continue;
      }
      value += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#') break;
    value += character;
  }
  return value.trim();
}

function tomlString(value) {
  return JSON.stringify(value);
}

const NPMRC_MAPPINGS = [
  {
    pattern: /^registry\s*=\s*(.+)$/im,
    key: 'registry',
    render: (value) => {
      const parsed = npmrcValue(value);
      if (parsed === '') return { reason: 'registry: the value is empty after parsing' };
      return { table: 'install', key: 'registry', line: `registry = ${tomlString(parsed)}` };
    },
  },
  {
    pattern: /^(?:strict-ssl|strict_ssl)\s*=\s*false$/im,
    key: 'strict-ssl',
    render: () => null,
    reason: 'bunfig.toml has no strict-ssl switch; Bun always verifies TLS',
  },
  {
    pattern: /^hoist-pattern\[\]\s*=\s*(.+)$/im,
    key: 'hoist-pattern',
    render: () => null,
    reason: 'Bun hoisting is not configurable through bunfig.toml',
  },
  {
    pattern: /^node-linker\s*=\s*(.+)$/im,
    key: 'node-linker',
    render: (value) => {
      const parsed = npmrcValue(value);
      if (parsed === 'isolated' || parsed === 'hoisted') {
        return { table: 'install', key: 'linker', line: `linker = ${tomlString(parsed)}` };
      }
      return {
        reason: `node-linker=${parsed}: Bun only supports "isolated" and "hoisted", so this was not translated`,
      };
    },
  },
  {
    pattern: /^shamefully-hoist\s*=\s*true$/im,
    key: 'shamefully-hoist',
    render: () => ({ table: 'install', key: 'linker', line: 'linker = "hoisted"' }),
  },
];

/**
 * Subcommands that are package-manager operations, not user scripts.
 *
 * The bare-command rules below cannot tell `pnpm build` (a script) from
 * `pnpm publish` (an operation) by shape alone. Without this list, a migration
 * would turn `npm publish` into `bun run publish`, a script Bun cannot resolve.
 * `test`, `start`, `stop` and `restart` are deliberately absent: they are script
 * aliases, so `npm test` must become `bun run test`.
 */
const PNPM_NON_SCRIPT_SUBCOMMANDS = new Set([
  'add', 'install', 'i', 'update', 'up', 'upgrade', 'remove', 'rm', 'uninstall', 'un',
  'link', 'unlink', 'import', 'rebuild', 'prune', 'fetch', 'patch', 'patch-commit',
  'patch-remove', 'audit', 'list', 'ls', 'll', 'la', 'why', 'outdated', 'licenses',
  'publish', 'pack', 'deploy', 'dedupe', 'doctor', 'server', 'store', 'config', 'set',
  'get', 'init', 'create', 'dlx', 'exec', 'run', 'root', 'bin', 'env', 'help', 'version',
]);

const NPM_NON_SCRIPT_SUBCOMMANDS = new Set([
  'add', 'install', 'i', 'ci', 'update', 'up', 'upgrade', 'remove', 'rm', 'uninstall',
  'un', 'link', 'unlink', 'rebuild', 'prune', 'audit', 'list', 'ls', 'll', 'la', 'why',
  'outdated', 'publish', 'pack', 'view', 'info', 'show', 'search', 's', 'find', 'config',
  'set', 'get', 'init', 'create', 'exec', 'run', 'root', 'bin', 'prefix', 'help',
  'version', 'whoami', 'login', 'logout', 'adduser', 'token', 'owner', 'access', 'team',
  'org', 'deprecate', 'dist-tag', 'star', 'unstar', 'fund', 'doctor', 'dedupe', 'diff',
  'explain', 'repo', 'bugs', 'docs', 'homepage', 'query', 'sbom', 'pkg', 'pkg-fix',
  'cache', 'install-ci-test', 'install-test', 'it',
]);

const SCRIPT_REWRITES = [
  // `-r --filter` must come before the generic `-r` rule, or the generic one
  // turns it into `bun run --filter "*" --filter <x> run <script>`.
  { pattern: /\bpnpm\s+-r\s+--filter\s+(\S+)\s+run\s+/g, replacement: 'bun run --filter $1 ' },
  { pattern: /\bpnpm\s+-r\s+--filter\s+(\S+)\s+/g, replacement: 'bun run --filter $1 ' },
  { pattern: /\bpnpm\s+-r\s+run\s+/g, replacement: 'bun run --filter "*" ' },
  { pattern: /\bpnpm\s+-r\s+/g, replacement: 'bun run --filter "*" ' },
  { pattern: /\bpnpm\s+--filter\s+(\S+)\s+run\s+/g, replacement: 'bun run --filter $1 ' },
  { pattern: /\bpnpm\s+--filter\s+(\S+)\s+/g, replacement: 'bun run --filter $1 ' },
  { pattern: /\bpnpm\s+-C\s+(\S+)\s+run\s+/g, replacement: 'cd $1 && bun run ' },
  { pattern: /\bpnpm\s+-C\s+(\S+)\s+install\s+/g, replacement: 'cd $1 && bun install ' },
  { pattern: /\bpnpm\s+-C\s+(\S+)\s+/g, replacement: 'cd $1 && bun ' },
  { pattern: /\bpnpm\s+run\s+/g, replacement: 'bun run ' },
  { pattern: /\bpnpm\s+run-script\s+/g, replacement: 'bun run ' },
  { pattern: /\bpnpm\s+exec\s+/g, replacement: 'bunx ' },
  { pattern: /\bpnpm\s+dlx\s+/g, replacement: 'bunx ' },
  { pattern: /\bnpx\s+/g, replacement: 'bunx ' },
  { pattern: /\bnpm\s+run\s+/g, replacement: 'bun run ' },
  { pattern: /\bnpm\s+run-script\s+/g, replacement: 'bun run ' },
  { pattern: /\bnpm\s+exec\s+/g, replacement: 'bunx ' },
  // `npm t` / `pnpm t` are aliases for the `test` script, not a script named "t".
  { pattern: /\b(?:npm|pnpm)\s+t\b/g, replacement: 'bun run test' },
  { pattern: /\bnpm\s+(?:install|ci|i)\b/g, replacement: 'bun install' },
  { pattern: /\bpnpm\s+install\b/g, replacement: 'bun install' },
  { pattern: /\bpnpm\s+i\b/g, replacement: 'bun install' },
  /**
   * A bare `pnpm <script>` / `npm <script>` invocation. Every more specific form
   * is handled above, so what survives is `pnpm build` and its siblings — the
   * shape a CI workflow carries after the provider action was dropped. Without
   * it the migration removed the provider and left `pnpm: command not found` /
   * `npm: command not found` behind.
   *
   * The name position is the guard: a command position followed by one word
   * that is not a package-manager operation. A flag-looking word (`--`, `-r`)
   * does not match, so `pnpm --version` keeps its specific handling above.
   */
  {
    pattern: /(^|&&\s*|\|\|\s*|;\s*|\|\s*)(pnpm)\s+([A-Za-z][\w:.-]*)(?=\s|$)/g,
    replacement: (match, lead, _runner, name) =>
      PNPM_NON_SCRIPT_SUBCOMMANDS.has(name) ? match : `${lead}bun run ${name}`,
  },
  {
    pattern: /(^|&&\s*|\|\|\s*|;\s*|\|\s*)(npm)\s+([A-Za-z][\w:.-]*)(?=\s|$)/g,
    replacement: (match, lead, _runner, name) =>
      NPM_NON_SCRIPT_SUBCOMMANDS.has(name) ? match : `${lead}bun run ${name}`,
  },
];

/**
 * Test-runner scripts that stop working once the test files import `bun:test`.
 *
 * The tests layer rewrites a runner import into the built-in module, so a script
 * that still invokes that runner directly fails with "operation not permitted"
 * rather than a readable error. This table is the other half of that rewrite:
 * leaving it out produces a project whose tests pass under Bun but whose
 * `bun run test` does not.
 *
 * The match is anchored to a command position — the start of the script, or after
 * one of the shell operators that begin a new command. A looser rule rewrites
 * `vitest-when` into `bun test-when`, `pnpm vitest run` into `pnpm bun test`, and
 * `node vitest.js` into `node bun test.js`; all three were measured and are wrong.
 * A quote or a path segment before the word disqualifies the position too, which
 * is what keeps `echo vitest` and `./node_modules/.bin/vitest` intact.
 *
 * Only the runner invocation is replaced. Arguments stay, so a coverage run
 * becomes `bun test --coverage`, which is what the caller meant.
 *
 * `pnpm vitest` is the reason the vitest rule carries an optional `pnpm `
 * prefix: after `pnpm/action-setup` is gone, `pnpm vitest run` would otherwise
 * fall through to the bare `pnpm <script>` rule below and become
 * `bun run vitest` — which invokes whatever a script named "vitest" says, not
 * the runner binary. The runner table runs before SCRIPT_REWRITES in
 * `rewriteTestRunnerScript(rewriteScript(...))` order is wrong for this case, so
 * `applyConfigLayer` applies the runner table to the raw script first (line
 * below) and the general table second.
 */
const RUNNER_SCRIPT_REWRITES = [
  {
    pattern: /(^|&&\s*|\|\|\s*|;\s*|\|\s*)(pnpm\s+)?(vitest|jest)(?:\s+run)?(?=\s|$)/g,
    replacement: (_match, lead, _pnpmPrefix) => `${lead}bun test`,
  },
  {
    pattern: /(^|&&\s*|\|\|\s*|;\s*|\|\s*)(jest)(?=\s|$)/g,
    replacement: (_match, lead) => `${lead}bun test`,
  },
  {
    pattern: /^pnpm\s+(vitest|jest)(?:\s+run)?(?=\s|$)/,
    replacement: () => 'bun test',
  },
  {
    pattern: /^(npx|bunx)\s+(vitest|jest)(?:\s+run)?(?=\s|$)/,
    replacement: () => 'bun test',
  },  {
    pattern: /^([A-Za-z_][A-Za-z0-9_]*=\S*\s+)+(vitest|jest)(?:\s+run)?(?=\s|$)/,
    replacement: (match) => `${match.slice(0, match.search(/(vitest|jest)/))}bun test`,
  },
];

/**
 * Rewrite a package script into the form Bun runs.
 *
 * Returns `{ script, applied }` so the journal can say what moved and why; a bare
 * string would make a wrong rewrite indistinguishable from a right one in the
 * report.
 */
export function rewriteTestRunnerScript(script) {
  let next = script;
  const applied = [];
  for (const rule of RUNNER_SCRIPT_REWRITES) {
    next = next.replace(rule.pattern, (match, ...groups) => {
      const replaced = rule.replacement(match, ...groups);
      if (replaced !== match) applied.push('test runner');
      return replaced;
    });
  }
  return { script: next, applied: [...new Set(applied)] };
}

/**
 * Collapse the doubled `run` a chained rewrite can produce.
 *
 * `pnpm -r run build` becomes `bun run --filter "*" run build` if the `-r` rule
 * fires first and the `run` rule fires second. One `run` is correct; two is a
 * script Bun cannot resolve.
 */
function collapseDoubleRun(script) {
  return script.replaceAll(/\brun\s+run\b/g, 'run');
}

function readText(project, path) {
  const absolute = join(project.root, path);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined;
}

function readManifest(project, journal) {
  const staged = journal.current('package.json');
  if (staged !== undefined) {
    try {
      return JSON.parse(staged);
    } catch {
      return project.readJson('package.json');
    }
  }
  return project.readJson('package.json');
}

export function rewriteScript(script) {
  let next = script;
  for (const rule of SCRIPT_REWRITES) {
    next = next.replace(rule.pattern, rule.replacement);
  }
  return collapseDoubleRun(next);
}

/**
 * Merge migrated settings into an existing `bunfig.toml` without repeating a table header.
 *
 * TOML rejects a redefined table, so emitting one `[install]` block per setting
 * produces a file Bun refuses to load: `Cannot redefine table 'install'`. Measured
 * before this guard, a two-setting `.npmrc` produced exactly that and `bun install`
 * could not start.
 *
 * An existing table keeps its own lines; a migrated line replaces an existing line
 * with the same key inside that table, and is appended otherwise. A key that no
 * table owns yet creates the table once.
 */
export function mergeBunfig(existing, settings) {
  const lines = existing === '' ? [] : existing.split('\n');
  const byTable = new Map();
  for (const setting of settings) {
    if (!byTable.has(setting.table)) byTable.set(setting.table, new Map());
    byTable.get(setting.table).set(setting.key, setting.line);
  }

  for (const [tableName, entries] of byTable) {
    const header = `[${tableName}]`;
    const headerIndex = lines.findIndex((line) => line.trim() === header);
    if (headerIndex === -1) {
      if (lines.length > 0 && lines.at(-1).trim() !== '') lines.push('');
      lines.push(header, ...entries.values());
      continue;
    }
    let insertAt = headerIndex + 1;
    let lastEntry = headerIndex;
    while (insertAt < lines.length && !/^\s*\[/.test(lines[insertAt])) {
      if (lines[insertAt].trim() !== '') lastEntry = insertAt;
      const key = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(lines[insertAt]);
      if (key && entries.has(key[1])) {
        /**
         * A value can span lines: `preload = [` followed by entries and a closing `]`.
         * Replacing only the opening line left the rest of the array behind as orphan
         * text — measured, a wrapped `preload` came out as the new one-line value with
         * a dangling `"./a.ts",` / `"./b.ts",` / `]` under it, which is not valid TOML
         * and makes `bun install` refuse to load the file.
         *
         * The continuation is recognised by bracket depth rather than by indentation,
         * because a wrapped array is not required to indent its entries.
         */
        let end = insertAt;
        let depth = bracketDelta(lines[insertAt]);
        while (depth > 0 && end + 1 < lines.length && !/^\s*\[/.test(lines[end + 1])) {
          end += 1;
          depth += bracketDelta(lines[end]);
        }
        lines.splice(insertAt, end - insertAt + 1, entries.get(key[1]));
        entries.delete(key[1]);
        lastEntry = insertAt;
        insertAt += 1;
        continue;
      }
      insertAt += 1;
    }
    if (entries.size > 0) {
      lines.splice(lastEntry + 1, 0, ...entries.values());
    }
  }
  const merged = lines.join('\n');
  return merged.endsWith('\n') ? merged : `${merged}\n`;
}

/**
 * Net `[` minus `]` on a line, for telling a one-line value from a wrapped one.
 *
 * Quoted brackets are skipped: a preload path may legally contain either character,
 * and counting them would make a single-line array look like an unterminated one.
 */
function bracketDelta(line) {
  let depth = 0;
  let quote;
  for (const character of line) {
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '[') depth += 1;
    else if (character === ']') depth -= 1;
  }
  return depth;
}

/**
 * Every key an .npmrc declares, so none of them can disappear silently.
 *
 * The migration deletes `.npmrc` after extracting the settings it knows, which
 * is only safe when every key the file carries was either mapped or reported.
 * Measured before this scan: `proxy=` and a registry auth token vanished with
 * the file while the journal said "migrated 1 setting(s)" — a loss the reader
 * had no record of. Comments and blank lines are skipped; a line without `=`
 * is reported by position rather than guessed at.
 */
export function npmrcKeys(text) {
  const keys = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) {
      keys.push(`<unreadable line: ${line}>`);
      continue;
    }
    keys.push(line.slice(0, eq).trim());
  }
  return keys;
}

function indentOf(line) {
  return /^\s*/.exec(line)[0].length;
}

/**
 * Locate each `steps:` block by indentation.
 *
 * The previous version found only the first block, so a workflow with several
 * jobs lost `actions/setup-node` from every job while gaining `setup-bun` in one.
 * A block runs until a non-blank line at or above the `steps:` indentation.
 */
function workflowStepsBlocks(lines) {
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)steps:\s*$/.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length;
    let end = index + 1;
    while (end < lines.length) {
      const line = lines[end];
      if (line.trim() === '') {
        end += 1;
        continue;
      }
      if (indentOf(line) <= indent) break;
      end += 1;
    }
    let stepIndent;
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      const line = lines[cursor];
      if (line.trim() === '') continue;
      if (indentOf(line) <= indent) break;
      if (/^\s*-/.test(line)) {
        stepIndent = indentOf(line);
        break;
      }
    }
    blocks.push({ anchor: index, indent, end, stepIndent });
  }
  return blocks;
}

function freshBunStep(indent) {
  const pad = ' '.repeat(indent);
  return [`${pad}- uses: oven-sh/setup-bun@v2`, `${pad}  with:`, `${pad}    bun-version: latest`];
}

function rewriteCommand(script) {
  return rewriteScript(rewriteTestRunnerScript(script).script).replaceAll('node_modules/.bin/', '');
}

/**
 * Rewrite shell commands in `run:` values, including block scalars.
 *
 * A `run: |` body is where a multi-line CI command lives. Rewriting only the
 * `run:` line left `npm ci` and `npm test` inside the body untouched while the
 * Node setup step that provided `npm` was deleted.
 */
function rewriteWorkflowRuns(text) {
  const lines = text.split('\n');
  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const cr = line.endsWith('\r') ? '\r' : '';
    const bare = cr === '' ? line : line.slice(0, -1);
    const match = /^(\s*-?\s*run:\s*)(.*)$/.exec(bare);
    if (!match) {
      out.push(line);
      continue;
    }
    const value = match[2];
    if (/^[|>][+-]?[1-9]?\s*(?:#.*)?$/.test(value)) {
      out.push(`${match[1]}${value}${cr}`);
      const blockIndent = indentOf(bare);
      let cursor = index + 1;
      while (cursor < lines.length) {
        const inner = lines[cursor];
        const innerCr = inner.endsWith('\r') ? '\r' : '';
        const innerBare = innerCr === '' ? inner : inner.slice(0, -1);
        if (innerBare.trim() !== '' && indentOf(innerBare) <= blockIndent) break;
        if (innerBare.trim() === '' || innerBare.trim().startsWith('#')) {
          out.push(inner);
          cursor += 1;
          continue;
        }
        const lead = /^\s*/.exec(innerBare)[0];
        out.push(`${lead}${rewriteCommand(innerBare.slice(lead.length))}${innerCr}`);
        cursor += 1;
      }
      index = cursor - 1;
      continue;
    }
    out.push(`${match[1]}${rewriteCommand(value)}${cr}`);
  }
  return out.join('\n');
}

/**
 * Drop the Node/pnpm setup steps and give each job that needed them a Bun step.
 *
 * An existing `oven-sh/setup-bun` step stays where it is, verbatim, so a pinned
 * `bun-version` is never loosened. Only a block whose provider step was removed
 * and which has no Bun step of its own receives a fresh one.
 */
function rewriteWorkflow(text) {
  const lines = text.split('\n');
  const blocks = workflowStepsBlocks(lines);
  if (blocks.length === 0) {
    return {
      changed: false,
      text,
      skipped: 'workflow has no steps block; CI setup left for manual review',
    };
  }
  const removed = new Set();
  const inserts = new Map();
  for (const block of blocks) {
    let hasBun = false;
    let removedSetup = false;
    for (let index = block.anchor + 1; index < block.end; index += 1) {
      if (removed.has(index)) continue;
      const line = lines[index];
      const match = /^(\s*)-?\s*uses:\s*(pnpm\/action-setup|actions\/setup-node|oven-sh\/setup-bun)@/.exec(line);
      if (!match) continue;
      if (match[2] === 'oven-sh/setup-bun') {
        hasBun = true;
        continue;
      }
      removedSetup = true;
      removed.add(index);
      const stepIndent = indentOf(line);
      let cursor = index + 1;
      while (cursor < block.end) {
        const next = lines[cursor];
        if (next.trim() === '') {
          removed.add(cursor);
          cursor += 1;
          continue;
        }
        if (indentOf(next) <= stepIndent) break;
        removed.add(cursor);
        cursor += 1;
      }
      index = cursor - 1;
    }
    if (removedSetup && !hasBun) {
      inserts.set(block.anchor, freshBunStep(block.stepIndent ?? block.indent + 2));
    }
  }
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!removed.has(index)) kept.push(lines[index]);
    const insertion = inserts.get(index);
    if (insertion) kept.push(...insertion);
  }
  const withRuns = rewriteWorkflowRuns(kept.join('\n'));
  return { changed: withRuns !== text, text: withRuns };
}

function workspaceGlobs(project, manifest) {
  const globs = [];
  if (Array.isArray(manifest?.workspaces)) {
    globs.push(...manifest.workspaces.filter((entry) => typeof entry === 'string'));
  } else if (Array.isArray(manifest?.workspaces?.packages)) {
    globs.push(...manifest.workspaces.packages.filter((entry) => typeof entry === 'string'));
  }
  const workspaceText = readText(project, 'pnpm-workspace.yaml');
  if (workspaceText !== undefined) {
    try {
      const parsed = Bun.YAML.parse(workspaceText);
      if (Array.isArray(parsed?.packages)) {
        globs.push(...parsed.packages.filter((entry) => typeof entry === 'string'));
      }
    } catch {
      // The workspace file is reported by the packages layer; no globs here.
    }
  }
  return globs.map((glob) => glob.replace(/^\.\//, ''));
}

function globToRegExp(glob) {
  let pattern = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === '*') {
      if (glob[index + 1] === '*') {
        pattern += '.*';
        index += 1;
      } else {
        pattern += '[^/]*';
      }
    } else if (character === '?') {
      pattern += '[^/]';
    } else {
      pattern += character.replaceAll(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${pattern}$`);
}

function isWorkspaceDirectory(directory, globs) {
  const positive = globs.filter((glob) => !glob.startsWith('!'));
  const negative = globs.filter((glob) => glob.startsWith('!')).map((glob) => glob.slice(1));
  const matches = (glob) => globToRegExp(glob).test(directory);
  return positive.some(matches) && !negative.some(matches);
}

function rewriteManifestScripts(manifest) {
  const scripts = {};
  let scriptChanges = 0;
  let runnerChanges = 0;
  for (const [name, value] of Object.entries(manifest.scripts ?? {})) {
    const withRunner = rewriteTestRunnerScript(String(value));
    const rewritten = rewriteScript(withRunner.script);
    if (withRunner.applied.length > 0) runnerChanges += 1;
    if (rewritten !== value) scriptChanges += 1;
    scripts[name] = rewritten;
  }
  return { scripts, scriptChanges, runnerChanges };
}

export function applyConfigLayer(project, journal) {
  if (!journal.enabled('config')) return;

  const npmrc = readText(project, '.npmrc');
  const bunfigPath = 'bunfig.toml';
  if (npmrc) {
    const bunfigOnDisk = readText(project, bunfigPath);
    const existing = journal.readFile(bunfigPath) ?? bunfigOnDisk ?? '';
    const settings = [];
    const handledKeys = new Set();
    for (const mapping of NPMRC_MAPPINGS) {
      const match = mapping.pattern.exec(npmrc);
      if (!match) continue;
      for (const key of npmrcKeys(match[0])) handledKeys.add(key);
      const rendered = mapping.render(match[1] ?? '');
      if (rendered === null) {
        journal.skip('.npmrc', 'config', `${mapping.key}: ${mapping.reason}`);
      } else if (rendered.reason !== undefined) {
        journal.skip('.npmrc', 'config', rendered.reason);
      } else {
        settings.push(rendered);
      }
    }
    const registryStyle = /^(\/\/[^=]+:)?_authToken$|^\/\//;
    for (const key of npmrcKeys(npmrc)) {
      if (handledKeys.has(key)) continue;
      if (registryStyle.test(key)) {
        journal.skip(
          '.npmrc',
          'config',
          `${key}: registry auth has no bunfig.toml form; copy the credentials into ~/.bunfig.toml or an environment variable before committing`,
        );
        continue;
      }
      journal.skip('.npmrc', 'config', `${key}: not a setting this migration maps; carry it over by hand`);
    }
    let npmrcRemovable = true;
    if (settings.length > 0) {
      const merged = mergeBunfig(existing, settings);
      /**
       * The merged file is parsed before it can replace the project's config.
       * A quoted `.npmrc` value used to render as `registry = ""...""`, and
       * deleting `.npmrc` afterwards left the project with a bunfig Bun refuses
       * to load. Refusing the merge keeps both files intact and reports why.
       */
      try {
        Bun.TOML.parse(merged);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        journal.skip(
          '.npmrc',
          'config',
          `the merged bunfig.toml would not be valid TOML (${detail}); .npmrc was left in place`,
        );
        npmrcRemovable = false;
      }
      if (npmrcRemovable) {
        /**
         * A bunfig the migration brings into existence records `before:
         * undefined`, so `revert` removes the file instead of leaving a 0-byte
         * one behind — the same contract the timeout preload follows.
         */
        journal.set(
          bunfigPath,
          merged,
          'config',
          `migrated ${settings.length} setting(s) from .npmrc${bunfigOnDisk === undefined ? '; created the file' : ''}`,
          bunfigOnDisk,
        );
      }
    }
    if (npmrcRemovable) {
      journal.remove('.npmrc', 'config', 'pnpm/npm configuration replaced by bunfig.toml', npmrc);
    }
  }

  if (readText(project, '.nvmrc') !== undefined) {
    journal.remove('.nvmrc', 'config', 'Bun is the runtime; version pinned in packageManager', readText(project, '.nvmrc'));
  }

  const manifest = readManifest(project, journal);
  if (manifest) {
    let changed = false;
    const nextManifest = { ...manifest };
    if (nextManifest.packageManager !== `bun@${Bun.version}`) {
      const previous = nextManifest.packageManager;
      nextManifest.packageManager = `bun@${Bun.version}`;
      changed = true;
      if (previous !== undefined) {
        journal.note('config', `packageManager ${previous} -> bun@${Bun.version}`);
      }
    }
    if (nextManifest.engines && nextManifest.engines.node) {
      const engines = { ...nextManifest.engines };
      delete engines.node;
      if (Object.keys(engines).length > 0) nextManifest.engines = engines;
      else delete nextManifest.engines;
      changed = true;
      journal.note('config', 'dropped engines.node; the runtime is pinned by packageManager');
    }
    if (nextManifest.scripts) {
      /**
       * The runner table runs on the raw script first. `pnpm vitest run` is
       * both a runner invocation and a bare `pnpm <script>` call, and only this
       * order reads it as the runner: after `rewriteScript` has produced
       * `bun run vitest run`, no runner rule can recognize the runner behind the
       * rewritten prefix.
       */
      const rewritten = rewriteManifestScripts(nextManifest);
      if (rewritten.scriptChanges > 0) {
        nextManifest.scripts = rewritten.scripts;
        changed = true;
        const parts = [];
        if (rewritten.scriptChanges - rewritten.runnerChanges > 0) parts.push('pnpm/npm/npx to bun');
        if (rewritten.runnerChanges > 0) parts.push('test runner to bun test');
        journal.note('config', `rewrote ${rewritten.scriptChanges} package script(s): ${parts.join(', ')}`);
      }
    }
    if (changed) {
      journal.set(
        'package.json',
        `${JSON.stringify(nextManifest, null, 2)}\n`,
        'config',
        'added packageManager and rewrote package scripts',
        // The journal's before is the disk bytes, not a re-serialization: revert
        // must restore the file exactly as it was, whitespace included.
        project.rawText('package.json') ?? `${JSON.stringify(manifest, null, 2)}\n`,
      );
    }
  }

  /**
   * Workspace members declare their own `test` and build scripts; rewriting
   * only the root manifest left `pnpm --filter <pkg> test` invoking Vitest after
   * the test files had moved to `bun:test`. Every manifest is rewritten with the
   * same tables as the root.
   */
  const workspaceMembership = workspaceGlobs(project, manifest);
  for (const directory of workspaceMembership.length === 0 ? [] : project.manifestDirectories ?? []) {
    if (directory === '' || !isWorkspaceDirectory(directory, workspaceMembership)) continue;
    const manifestPath = `${directory}/package.json`;
    const text = journal.readFile(manifestPath) ?? readText(project, manifestPath);
    if (text === undefined) continue;
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch {
      journal.skip(manifestPath, 'config', 'package.json could not be parsed; scripts were not rewritten');
      continue;
    }
    if (manifest.scripts === null || typeof manifest.scripts !== 'object') continue;
    const rewritten = rewriteManifestScripts(manifest);
    if (rewritten.scriptChanges === 0) continue;
    const next = { ...manifest, scripts: rewritten.scripts };
    journal.set(
      manifestPath,
      `${JSON.stringify(next, null, 2)}\n`,
      'config',
      `rewrote ${rewritten.scriptChanges} package script(s)`,
      project.rawText(manifestPath) ?? text,
    );
  }

  for (const file of project.ciFiles ?? []) {
    const text = journal.readFile(file) ?? readText(project, file);
    if (!text) continue;
    if (!/actions\/setup-node|pnpm\/action-setup/.test(text)) continue;
    const rewritten = rewriteWorkflow(text);
    if (rewritten.skipped !== undefined) {
      journal.skip(file, 'config', rewritten.skipped);
      continue;
    }
    if (rewritten.changed) {
      journal.set(file, rewritten.text, 'config', 'CI installs Bun instead of Node and pnpm', text);
    }
  }
}
