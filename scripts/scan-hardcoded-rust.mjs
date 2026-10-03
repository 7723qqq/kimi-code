#!/usr/bin/env bun
/**
 * scan-hardcoded-rust.mjs — hardcoded user-facing prose in the Rust engine.
 *
 * Why this gate exists
 * --------------------
 * `scan:hardcoded` covers six TypeScript trees. `packages/kimi-agent` is 21.8
 * 万行 of Rust with zero coverage, and the catalog it resolves through
 * (`engine.*`, 167 keys) reaches a fraction of what the engine emits. A green
 * `scan:hardcoded` run says nothing about the engine — the blind spot is
 * structural, not a tuning problem, so it needs its own gate.
 *
 * Why it is shape-based, not catalog-based
 * ----------------------------------------
 * The TypeScript scanner's first three detections ask "is this string already
 * in the locale file?", which cannot see text that was never translated. This
 * gate inverts the question: "is this literal a sentence a user could read?".
 * That needs no catalog, which is the only way to catch the 122 literals the
 * engine ships that no key was ever written for.
 *
 * What is NOT exempt by default
 * -----------------------------
 * Deliberately, this gate has no built-in model of which prose *may* stay
 * English. An earlier directory-based attempt guessed from paths
 * (`src/prompt/` is model input, `src/tools/` is not) and that guess is wrong
 * in both directions — `src/tools/core_tool_defs.rs` is the model's manual and
 * must stay English, while `src/tools/exit_plan_mode.rs` is a dialog the user
 * reads. So the only exclusions are the four below, each decided by the
 * literal's *shape* rather than by where it sits, and everything else must be
 * justified by an entry in `scripts/hardcoded-rust-allowlist.json`.
 *
 *   1. test modules      — `#[cfg(test)]` assertion messages; never rendered.
 *                           Without this the signal-to-noise ratio is ~1:5.
 *   2. comments          — line, doc and block comments.
 *   3. non-prose shapes  — SQL, JSON, paths, globs, identifiers, env vars,
 *                           format strings. These fail a "≥2 words, mostly
 *                           letters, real sentence punctuation" test.
 *   4. the catalog seam  — a literal already inside a `LocalizedText`
 *                           constructor is the localized path by definition.
 *
 * The allowlist is a two-way ratchet, matching `check-locale-orphans`:
 *   - a new hardcoded literal that is not allowlisted FAILS, so debt cannot grow;
 *   - an allowlisted literal that is gone or now localized also FAILS, so the
 *     record cannot rot into fiction.
 *
 * Both are resolved with:
 *   bun run scan:hardcoded:rust -- --update
 *
 * Every entry carries a `reason` from CATEGORY below, so the debt stays
 * auditable and a reviewer can tell an upstream-mandated exemption from a
 * deferred one.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CRATE = join(ROOT, 'packages', 'kimi-agent', 'src');
const ALLOWLIST = join(ROOT, 'scripts', 'hardcoded-rust-allowlist.json');

/**
 * Why a literal is allowed to stay English. These mirror the categories the
 * root AGENTS.md already reasons about, so a reviewer does not have to learn a
 * second vocabulary.
 */
const CATEGORY = {
  'model-input': 'System prompt / injected reminder / tool description. The model\'s manual — translating it changes model behavior.',
  'tool-protocol': 'Instruction telling the model how to drive a tool ("call Read with line_offset=…"). Part of the tool contract, not UI.',
  'format-scaffolding': 'Structural wrapper with no prose of its own (`<system>…</system>`, `{}\\t{}`).',
  'wire-token': 'String the TypeScript layer matches to recognize an event. Display text at that site is produced elsewhere.',
  'dead-path': 'Emitted on a path no host consumes (e.g. ToolExecuteResponse.note, which sdk-rpc-client-native.ts does not forward).',
  diagnostic: 'Inside a tracing / log macro, or an internal bridge failure. Structured output for an operator reading logs, never rendered to a user.',
  'workspace-artifact': 'Rendered into a file in the user’s workspace for other agents and tools to read (e.g. .tower/comms/MISSIONS.md). Not a dialog, a tool result, or a prompt.',
  'dev-surface': 'The engine’s own CLI/REPL front end. The product terminal UI is apps/kimi-code’s TUI, which resolves its copy through the tui.* catalog.',
  'deferred': 'Genuinely user-facing, translation not yet done. The only category that is a real TODO.',
};

const SKIP_DIRS = new Set(['locales', 'target']);

/**
 * Whole files whose content is expected-output data rather than code.
 *
 * `events_map_golden.rs` holds the differential-acceptance expectations
 * produced by running v2's real mappers; every prose string in it is a
 * recorded *expected value*, and several are v2's English UI copy that the
 * fixture must reproduce byte for byte. It is test data that happens to live
 * outside a `#[cfg(test)]` module, so the module cut does not reach it.
 */
const FIXTURE_FILES = new Set(['acp/events_map_golden.rs']);

// ── literal extraction ──────────────────────────────────────────────────────

/** Byte offset of the first `#[cfg(test)]`, or -1. Everything from there is test code. */
function testModuleStart(content) {
  const m = content.match(/^[ \t]*#\[cfg\(test\)\]/m);
  return m === null ? -1 : m.index;
}

/**
 * Strip a trailing line comment without eating a `//` that lives inside a
 * string (a URL, or the `https://` in a doc example).
 */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

const LITERAL_RE = /"(?:\\.|[^"\\])*"/g;

/**
 * Does this read as a sentence a user could be shown?
 *
 * The test is shape-only and deliberately strict: two or more alphabetic
 * words, real whitespace, mostly letters, and nothing that marks it as code.
 * A false negative costs a missed string; a false positive costs review
 * attention, so the bias is toward rejecting.
 */
function isProse(text) {
  // 10, not 12: "Plan Review" is an 11-character header the user reads in the
  // plan-approval dialog. The two-character window below it is filled by
  // bare status words ("Pending", "Rejected"), which the word-shape test
  // already rejects.
  if (text.length < 10 || text.length > 400) return false;

  const words = text.match(/[A-Za-z]{2,}/g);
  if (!words || words.length < 2) return false;
  if (!/\s/.test(text)) return false;

  // At least 55% letters-and-spaces; the rest of a sentence is punctuation.
  if ((text.match(/[A-Za-z ]/g) || []).length / text.length < 0.55) return false;

  // Code-ish: paths, flags, globs, identifiers, interpolation, escapes.
  if (/^[a-z0-9_./\\-]+$/i.test(text)) return false;
  if (/^[A-Z0-9_ ]+$/.test(text)) return false;
  if (/^[\d\s.,:%()-]+$/.test(text)) return false;

  // Interpolation braces are prose, not scaffolding: "Total lines in file:
  // {total_lines}." and "Filtered {{count}} sensitive file(s): {{list}}" are
  // both user-facing copy that happens to carry placeholders. An earlier draft
  // rejected any string containing `{}<>|\^\`$`, which silently dropped every
  // interpolated message in the crate — including the whole Read status
  // block. What *is* scaffolding is a string that is nothing but placeholders
  // and separators: "{prefix} {prompt}", "{value} {unit_str}". Those carry no
  // words of their own, so the two tests below reject them — a string with no
  // letter outside a brace group has nothing for a reader to read.
  if (/^(?:\s*\{[^{}]*\}\s*)+$/.test(text)) return false;
  if (!/[A-Za-z一-鿿]/.test(text.replace(/\{[^{}]*\}/g, ''))) return false;

  // SQL.
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|PRAGMA|WITH|BEGIN|COMMIT|REPLACE)\b/i.test(text))
    return false;
  // JSON / record literal.
  if (/^\s*[{[]/.test(text) && /[":,]\s*["'\d]/.test(text)) return false;

  // A bare two-word lowercase token is a status value, not copy.
  if (/^[a-z]+ [a-z]+$/.test(text) && text.length < 20) return false;

  return true;
}

/** Is this literal already on the localized path? */
function onCatalogSeam(line) {
  return (
    /LocalizedText::(new|with_params)\s*\(/.test(line) ||
    /\.render(_with)?\s*\(/.test(line) ||
    /translate_embedded\s*\(/.test(line)
  );
}

/**
 * Tracks which macro (if any) encloses the scan position.
 *
 * Two facts about a literal cannot be read off its own line, because in both
 * cases the macro opens earlier and the literal sits inside it:
 *
 *   tracing::warn!(
 *       %role,
 *       "dropping unparseable {what}: {error}"
 *   );
 *
 * and the same shape inside a tool's `json!({ "description": "…" })`, where the
 * value is the tool's input-schema help — the model's manual, not copy.
 *
 * Paren depth from the macro's opening bracket is the objective signal, and it
 * needs no list of call sites. Returns the innermost macro name, or null.
 */
function makeMacroTracker() {
  let open = null;
  let depth = 0;
  const MACROS = [
    ['json', /(?:\bjson|serde_json::json)!\s*\(/],
    ['log', /(?:\btracing|\blog)::(?:trace|debug|info|warn|error)!\s*\(/],
  ];
  return {
    /** Call once per line, before extracting literals from it. */
    enter(line) {
      if (open === null) {
        for (const [name, re] of MACROS) {
          if (re.test(line)) {
            open = name;
            depth = parenBalance(line.slice(line.search(re) + line.slice(line.search(re)).match(re)[0].length - 1));
            break;
          }
        }
        return open;
      }
      depth += parenBalance(line);
      if (depth <= 0) open = null;
      return open;
    },
  };
}

/** Net paren balance of a line, ignoring parens inside string literals. */
function parenBalance(line) {
  let balance = 0;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"') quote = c;
    else if (c === '(') balance++;
    else if (c === ')') balance--;
  }
  return balance;
}

/**
 * A literal used as a comparison operand is a protocol token by construction.
 *
 * `.contains("does not support state bridge")`, `== "approve"`, and a `match`
 * arm all read the string back rather than showing it, so translating it would
 * break the comparison instead of helping a reader. This is the same reasoning
 * the TypeScript scanner applies to `ENGINE_WIRE_TOKENS`, applied here by
 * shape rather than by an enumerated list — which also means
 * `exit_plan_mode.rs`'s `"Approve (Recommended)" => Answer::Approved` is
 * correctly recognized as load-bearing instead of being reported as copy that
 * should move into the catalog.
 *
 * Containment, not just equality, because sentinels are routinely defined with
 * a prefix and matched without one: `callbacks.rs` raises
 * `"host does not support state bridge"` while `exit_plan_mode.rs` tests
 * `error.contains("does not support interactive questions")`. Equality would
 * miss every one of that family and report each sentinel as untranslated copy.
 *
 * Collected over the whole crate first, then applied: a sentinel is often
 * defined in one module and matched in another.
 */
function collectComparisonOperands(files) {
  const tokens = new Set();
  // Only shapes that genuinely *read a string back*. An earlier draft also
  // collected `"…",` at end of line to catch enum-ish lists, but that matches
  // the last element of any multi-line vec/array literal — it swept up SQL,
  // format strings and long prose, and silently marked 327 real findings as
  // protocol tokens. A `match` arm already ends in `=>`, which is covered.
  const patterns = [
    /\.contains\s*\(\s*"((?:[^"\\]|\\.)*)"/g,
    /\.starts_with\s*\(\s*"((?:[^"\\]|\\.)*)"/g,
    /\.ends_with\s*\(\s*"((?:[^"\\]|\\.)*)"/g,
    /==\s*"((?:[^"\\]|\\.)*)"/g,
    /"((?:[^"\\]|\\.)*)"\s*==/g,
    /^\s*"((?:[^"\\]|\\.)*)"\s*=>/gm,
  ];
  for (const file of files) {
    const raw = readFileSync(file, 'utf-8');
    // Test modules may assert on a string without making it a protocol token.
    const testStart = testModuleStart(raw);
    const content = testStart === -1 ? raw : raw.slice(0, testStart);
    for (const re of patterns) {
      for (const m of content.matchAll(re)) {
        tokens.add(unescapeRust(m[1]));
      }
    }
  }
  // Comparison operands are sentinels, not copy. An operand long enough to be a
  // sentence is a literal being *compared for similarity*, and treating it as a
  // token would hide the finding it should be.
  return [...tokens].filter((t) => t.length >= 8 && t.length <= 120);
}

const unescapeRust = (s) => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');

/**
 * Is `literal` a protocol token? True when it equals an operand, or when an
 * operand is a substantial substring of it (the sentinel prefix case above).
 * The substring must be at least 8 characters so a short incidental overlap
 * cannot silence a real finding.
 */
function isWireToken(literal, tokens) {
  for (const t of tokens) {
    if (literal === t) return true;
    if (t.length >= 8 && literal.includes(t)) return true;
  }
  return false;
}

// ── extraction ──────────────────────────────────────────────────────────────

/**
 * Prose literals in one file, excluding its test module.
 *
 * Multi-line raw-string blocks (`const X: &str = r#"…"#;`) are attributed to
 * the block's first line rather than reported per row — a 40-line tool
 * description is one decision, not forty.
 */
function scanFile(file, relPath, wireTokens) {
  if (FIXTURE_FILES.has(relPath)) return [];
  const raw = readFileSync(file, 'utf-8');
  const testStart = testModuleStart(raw);
  const content = testStart === -1 ? raw : raw.slice(0, testStart);
  const lines = content.split('\n');
  const findings = [];

  // A literal that is also read back by a comparison is a protocol token.
  const push = (line, text, localized, category) => {
    const flat = text.replace(/\s+/g, ' ').trim();
    findings.push({
      file: relPath,
      line,
      text: flat,
      localized: localized || isWireToken(flat, wireTokens),
      category,
      context: text.slice(0, 120),
    });
  };

  const macros = makeMacroTracker();
  for (let i = 0; i < lines.length; i++) {
    const src = lines[i];
    const macro = macros.enter(src);
    if (/^\s*(\/\/|\*|\/\*)/.test(src)) continue;
    const code = stripComment(src);
    if (!code.includes('"')) continue;

    for (const m of code.matchAll(LITERAL_RE)) {
      const text = m[0].slice(1, -1);
      const unescaped = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
      if (!isProse(unescaped)) continue;
      // A `"description"` value inside a `json!` is a tool's input-schema help.
      // The embedded marketplace manifest in server/plugins.rs also uses that
      // key, but it lives in a `_JSON` raw block rather than a `json!`, so the
      // two stay apart — the first is the model's manual, the second is copy a
      // user reads on a plugin card.
      const before = code.slice(0, m.index);
      const isSchemaDoc =
        macro === 'json' && /"(?:description|title|summary)"\s*:\s*$/.test(before);
      const category =
        macro === 'log' ? 'diagnostic' : isSchemaDoc ? 'model-input' : undefined;
      push(i + 1, unescaped, onCatalogSeam(code), category);
    }
  }

  const rawBlockRe = /(?:const|static)\s+([A-Z0-9_]+)\s*:[^=]*=\s*r#*"/g;
  let bm;
  while ((bm = rawBlockRe.exec(content)) !== null) {
    const constName = bm[1];
    const startLine = content.slice(0, bm.index).split('\n').length;
    const close = content.indexOf('"#;', bm.index + bm[0].length);
    if (close === -1) continue;
    const body = content.slice(bm.index + bm[0].length, close);
    // A block that is itself on the catalog seam is the localized path.
    const seam = /LocalizedText|\.render\(/.test(bm[0] + body.slice(0, 200));
    // A `*_DESCRIPTION` / `*_SCHEMA` / `*_PROMPT` / `*_TEMPLATE` const is the
    // model's manual, whatever module it sits in. Keying on the const's own
    // name rather than on the file is what makes this precise: `tools/` holds
    // both `core_tool_defs.rs` (107 description lines, must stay English) and
    // `exit_plan_mode.rs` (a dialog the user reads), so any file-level rule
    // gets one of the two wrong. The same rule then covers `task_tools.rs`'s
    // TASK_WAIT_DESCRIPTION and every other tool that declares its help text
    // this way, with no list to maintain.
    const isModelDoc = MODEL_DOC_CONST_RE.test(constName);
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!isProse(t)) continue;
      push(startLine, t, seam, isModelDoc ? 'model-input' : undefined);
    }
  }

  return findings;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.name.endsWith('.rs')) {
      yield full;
    }
  }
}

// ── seeding ─────────────────────────────────────────────────────────────────

/**
 * A raw-string const whose name declares it to be the model's help text.
 *
 * This is the rule that replaces a file list. `tools/` holds both
 * `core_tool_defs.rs` — 107 lines of tool descriptions the model reads, which
 * the root AGENTS.md rules out of translation — and `exit_plan_mode.rs`, where
 * the same shape of prose is a dialog the user answers. Any rule keyed on the
 * path gets one of those two wrong; the const's own name is the signal that
 * actually separates them, and it covers every tool that declares help text
 * this way without a list to maintain.
 */
const MODEL_DOC_CONST_RE = /(?:^|_)(?:DESCRIPTION|SCHEMA|PROMPT|TEMPLATE|INSTRUCTIONS?)$/;

/**
 * Modules that build prompt text without a descriptively named const — the
 * debate coordinator assembles its stage prompts from `format!` fragments and
 * the injection layer composes reminders the same way.
 *
 * Paths are relative to the repository root, matching a finding's `file`.
 */
const MODEL_INPUT_FILES = new Set([
  'packages/kimi-agent/src/team/coordinator.rs', // debate-agent prompts
  'packages/kimi-agent/src/team/context.rs',
  'packages/kimi-agent/src/swarm/agent_run_batch.rs',
  'packages/kimi-agent/src/injection/goal_plan.rs',
  'packages/kimi-agent/src/injection/permission_mode.rs',
  'packages/kimi-agent/src/injection/swarm_mode.rs',
  'packages/kimi-agent/src/injection/reminder.rs',
  'packages/kimi-agent/src/prompt/init.rs',
  'packages/kimi-agent/src/prompt/environment.rs',
  'packages/kimi-agent/src/prompt/system.rs',
  'packages/kimi-agent/src/compaction/micro.rs', // the truncation marker's shape is protocol
]);

/**
 * Imperative addressed to the model about how to drive a tool. AGENTS.md calls
 * this "tool-protocol instructions … part of the tool's contract, not UI".
 */
const TOOL_PROTOCOL_RE =
  /\b(?:call|use|retry|pass|omit|set|provide|include|re-?run|narrow|specify)\b[^.]{0,40}\b(?:tool|again|Read|Grep|Glob|Write|Edit|Bash|offset|head_limit|glob|pattern|region|full_resolution|parameter|argument)\b|Do NOT call|instead of|\bvia Bash\b/i;

/**
 * An HTTP status line or a raw protocol frame. These are the wire, not prose:
 * `Bad Gateway` is what `http::Status::from_u16` renders, and
 * `HTTP/1.1 {} {}\r\n…` is the response the socket writes. Both are compared
 * or parsed rather than read, and a client that localized them would break
 * every status-code lookup.
 */
const HTTP_STATUS_RE =
  /^(?:Bad Request|Unauthorized|Forbidden|Not Found|Method Not Allowed|Conflict|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|Request Timeout|Payload Too Large|Unsupported Media Type|Expectation Failed|ImATeapot)$|^HTTP\/|^Content-Length is not|^\[native-http-timing\]|^\[\w+\] \{/;

/**
 * Modules whose rendered output is a file in the user's workspace rather than
 * anything a person reads in a terminal.
 *
 * `tower/store.rs`'s `render_missions_index` writes `.tower/comms/MISSIONS.md`
 * (paths.rs) — a markdown index the tower system regenerates on every
 * mutation, for other agents and tools to consume. It is not a dialog, not a
 * tool result, and not injected into a prompt, so there is no reader to
 * localize it for; translating it would only make the workspace artifact
 * disagree with the code that parses it back.
 */
const WORKSPACE_ARTIFACT_FILES = new Set(['packages/kimi-agent/src/tools/tower/store.rs']);

/**
 * The engine's own command-line front ends, not a product surface.
 *
 * `repl/mod.rs` is the `--repl` developer entry (`bun run dev:native:rust`
 * drives it) and `main.rs` is the CLI binary's startup and self-test output.
 * The user-facing terminal UI is `apps/kimi-code`'s TUI, which resolves its
 * copy through the `tui.*` catalog and has its own slash-command registry;
 * nothing here is reachable from it.
 */
const DEV_SURFACE_FILES = new Set([
  'packages/kimi-agent/src/repl/mod.rs',
  'packages/kimi-agent/src/main.rs',
]);

/**
 * Assigns the reason an existing literal is allowed to stay English.
 *
 * Deliberately conservative: it only claims a category it can justify from the
 * literal's role, and leaves everything it cannot place as `deferred` — which
 * is the only category that means "a real TODO". `--seed` prints the residue so
 * that set is reviewed rather than absorbed.
 */
function seedReason(f) {
  // A category the extractor already decided from the literal's own site —
  // a logging macro, a `*_DESCRIPTION` const — is evidence, not a guess, and
  // outranks the heuristics below.
  if (f.category && f.category in CATEGORY) return f.category;
  if (MODEL_INPUT_FILES.has(f.file)) return 'model-input';
  if (WORKSPACE_ARTIFACT_FILES.has(f.file)) return 'workspace-artifact';
  if (DEV_SURFACE_FILES.has(f.file)) return 'dev-surface';
  if (/^\s*<system>|^\s*<\/?[a-z-]+>/.test(f.text)) return 'format-scaffolding';
  if (HTTP_STATUS_RE.test(f.text)) return 'wire-token';
  if (TOOL_PROTOCOL_RE.test(f.text)) return 'tool-protocol';
  return 'deferred';
}

// ── ratchet ─────────────────────────────────────────────────────────────────

/** Stable identity of a finding: location + text. Line numbers move on edit. */
const keyOf = (f) => `${f.file}:${f.text}`;

const ALLOWLIST_NOTE =
  'Hardcoded prose literals in packages/kimi-agent that are allowed to stay English. ' +
  'Two-way ratchet: a new unrecorded literal fails, and so does a recorded one that is gone ' +
  'or has moved onto the catalog seam. Re-record with `bun run scan:hardcoded:rust -- --update`; ' +
  're-seed categories with `-- --seed`. `reason` must be one of the CATEGORY values documented ' +
  'in scripts/scan-hardcoded-rust.mjs. `deferred` is the only category that means a real TODO.';

const sortEntries = (obj) =>
  Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : 1)));

function loadAllowlist() {
  try {
    const raw = JSON.parse(readFileSync(ALLOWLIST, 'utf-8'));
    return { entries: raw.entries ?? {}, note: raw.note ?? '' };
  } catch {
    return { entries: {}, note: '' };
  }
}

function main() {
  const update = process.argv.includes('--update');
  const seed = process.argv.includes('--seed');
  const list = process.argv.includes('--list');

  const files = [...walk(CRATE)];
  // Two passes: a sentinel is often defined in one module and matched in
  // another, so the comparison operands have to be known crate-wide before
  // any file can classify its own literals.
  const wireTokens = collectComparisonOperands(files);
  const all = files.flatMap((file) =>
    scanFile(file, relative(ROOT, file).replaceAll('\\', '/'), wireTokens),
  );

  // A literal already on the catalog seam is the localized path.
  const hardcoded = all.filter((f) => !f.localized);
  const found = new Map(hardcoded.map((f) => [keyOf(f), f]));
  const { entries } = loadAllowlist();

  const newViolations = [...found.keys()].filter((k) => !(k in entries));
  const stale = Object.keys(entries).filter(
    (k) => !found.has(k) || found.get(k).localized,
  );
  // A `reason` outside CATEGORY is a typo, and a typo is indistinguishable from
  // a deliberate exemption to anyone reading the allowlist later — which is the
  // one thing the record exists to prevent.
  const badReason = Object.entries(entries)
    .filter(([, v]) => typeof v?.reason !== 'string' || !(v.reason in CATEGORY))
    .map(([k, v]) => [k, v?.reason]);

  const byCategory = {};
  // Count the deduplicated map, not the finding array. The same `file:text` can
  // be reported on several lines — a message reused across call sites — and
  // counting the array made the breakdown sum to more than the entry total,
  // which is the one thing a backlog figure must never do.
  for (const [k] of found) {
    const cat = entries[k]?.reason ?? 'UNRECORDED';
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
  }

  console.log(`scanned ${files.length} .rs files under packages/kimi-agent/src`);
  console.log(`prose literals: ${all.length} (${all.length - hardcoded.length} on the catalog seam)`);
  console.log('');
  console.log('--- by allowlist category ---');
  for (const [cat, n] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${cat}`);
  }
  console.log('');
  console.log(`recorded: ${Object.keys(entries).length}   found: ${found.size}`);
  console.log(`new (unrecorded): ${newViolations.length}   stale (recorded but gone): ${stale.length}`);

  if (list) {
    console.log('\n--- unrecorded ---');
    for (const k of newViolations) {
      const f = found.get(k);
      console.log(`  ${f.file}:${f.line}  ${JSON.stringify(f.text.slice(0, 90))}`);
    }
  }

  if (seed) {
    // Re-derive every category from the rules. Preserving what was already
    // recorded would make `--seed` a no-op the moment a rule changes, which is
    // the one time it is needed: the recorded value is a *result* of the rules,
    // not an independent decision. An entry a human deliberately reclassified
    // survives by carrying `manual: true`.
    const next = {};
    let changed = 0;
    for (const [k, f] of found) {
      const prev = entries[k];
      if (prev?.manual === true) {
        next[k] = prev;
        continue;
      }
      const reason = seedReason(f);
      if (prev && prev.reason !== reason) changed++;
      next[k] = { file: f.file, text: f.text, reason };
    }
    const deferred = Object.entries(next).filter(([, v]) => v.reason === 'deferred');
    writeFileSync(ALLOWLIST, `${JSON.stringify({ note: ALLOWLIST_NOTE, entries: sortEntries(next) }, null, 2)}\n`);
    const byReason = {};
    for (const v of Object.values(next)) byReason[v.reason] = (byReason[v.reason] ?? 0) + 1;
    console.log(`\nallowlist seeded: ${Object.keys(next).length} entries (${changed} category changed)`);
    for (const [r, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(5)}  ${r}`);
    }
    console.log(`\n  deferred (review these): ${deferred.length}`);
    const byFile = new Map();
    for (const [k, v] of deferred) {
      if (!byFile.has(v.file)) byFile.set(v.file, []);
      byFile.get(v.file).push(k);
    }
    for (const [file, list] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 15)) {
      console.log(`    ${String(list.length).padStart(4)}  ${file}`);
    }
    return;
  }

  if (update) {
    const next = {};
    for (const [k, f] of found) {
      const prev = entries[k];
      next[k] = prev?.reason && !prev.note?.startsWith('UNREVIEWED')
        ? prev
        : { file: f.file, text: f.text, reason: 'deferred', note: 'UNREVIEWED — needs a category' };
    }
    const unreviewed = Object.values(next).filter((v) => v.note?.startsWith('UNREVIEWED'));
    writeFileSync(ALLOWLIST, `${JSON.stringify({ note: ALLOWLIST_NOTE, entries: sortEntries(next) }, null, 2)}\n`);
    console.log(`\nallowlist written: ${Object.keys(next).length} entries`);
    if (unreviewed.length > 0) {
      console.log(
        `WARNING: ${unreviewed.length} entries carry reason "deferred" and must be reviewed — ` +
          'a genuine user-facing TODO and an upstream exemption are not the same thing.',
      );
      process.exit(1);
    }
    return;
  }

  let failed = false;
  if (newViolations.length > 0) {
    failed = true;
    console.log(`\nFAIL: ${newViolations.length} hardcoded literal(s) not recorded.`);
    for (const k of newViolations.slice(0, 20)) {
      const f = found.get(k);
      console.log(`  ${f.file}:${f.line}  ${JSON.stringify(f.text.slice(0, 90))}`);
    }
    if (newViolations.length > 20) console.log(`  ... and ${newViolations.length - 20} more`);
    console.log('\n  Record with a category:');
    console.log('    bun run scan:hardcoded:rust -- --list');
    console.log('    bun run scan:hardcoded:rust -- --update');
  }
  if (stale.length > 0) {
    failed = true;
    console.log(`\nFAIL: ${stale.length} recorded literal(s) no longer hardcoded — re-record:`);
    for (const k of stale.slice(0, 20)) console.log(`  ${k}`);
    console.log('    bun run scan:hardcoded:rust -- --update');
  }
  if (badReason.length > 0) {
    failed = true;
    console.log(`\nFAIL: ${badReason.length} allowlist entr(ies) with an unknown reason.`);
    for (const [k, r] of badReason.slice(0, 20)) console.log(`  ${k}  reason=${JSON.stringify(r)}`);
    console.log(`  valid reasons: ${Object.keys(CATEGORY).join(', ')}`);
  }
  process.exit(failed ? 1 : 0);
}

main();
