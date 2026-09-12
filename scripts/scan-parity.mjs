#!/usr/bin/env bun
/**
 * Rust engine <-> TypeScript interface parity scan.
 *
 * The Rust engine (`packages/kimi-agent`) and the TypeScript side describe the
 * same interface in four places. This gate keeps them from drifting apart by
 * scanning both sides and diffing:
 *
 *   - REST endpoints: `packages/protocol/src/rest/*.ts` header manifests vs the
 *     routes in `packages/kimi-agent/src/server/{mod,router}.rs`.
 *   - WebSocket events: `packages/kimi-agent/ws-event-contract.json`
 *     (`webEvents` the client understands vs `serverEvents` we emit).
 *   - Tool names: `packages/kimi-agent/tool-name-contract.json` vs the tool
 *     definitions under `packages/kimi-agent/src/tools/`.
 *   - napi exports: `packages/kimi-agent/napi-contract.d.ts` vs the `#[napi]`
 *     functions in the crate's binding modules.
 *   - Config keys: `packages/node-sdk/src/config-local/schema.ts` top-level
 *     keys vs the `KimiConfig` fields/aliases in `src/config/mod.rs`.
 *
 * The client-facing event *vocabulary* is not duplicated here: it is already
 * pinned by `ws-event-contract.json` plus the Rust `web_events.rs` test and
 * `packages/protocol`'s event-contract test.
 *
 * Exit code 0 when every surface is in sync, 1 otherwise. The REST matcher is
 * heuristic (it understands literal routes and `starts_with`/`ends_with`/
 * `contains` guards); a genuine false positive should be fixed by teaching the
 * matcher, not by weakening the contract.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PROTOCOL_REST_DIR = join(ROOT, 'packages/protocol/src/rest');
const AGENT = join(ROOT, 'packages/kimi-agent');

const WsEventContract = JSON.parse(
  readFileSync(join(AGENT, 'ws-event-contract.json'), 'utf8'),
);
const ToolNameContract = JSON.parse(
  readFileSync(join(AGENT, 'tool-name-contract.json'), 'utf8'),
);

/**
 * Web events the client understands but marks as no-ops (mappers.ts
 * `_noop`): the server intentionally never emits them, so they are not a gap.
 * If the set changes on either side this gate fails until both move together.
 */
const KNOWN_CLIENT_NOOP_EVENTS = new Set([
  'event.assistant.tool_use_started',
  'event.assistant.tool_use_delta',
  'event.assistant.tool_use_completed',
  'event.assistant.completed',
  'event.tool.started',
]);

const read = (p) => readFileSync(p, 'utf8');
const readTree = (dir, ext) =>
  readdirSync(dir, { recursive: true })
    .filter((f) => String(f).endsWith(ext))
    .map((f) => read(join(dir, String(f))))
    .join('\n');
const normalizePath = (p) => p.replace(/\{[^}]+\}/g, '*');

/**
 * Top-level keys the TS config document schema accepts that the Rust engine
 * deliberately does not model. `raw` is the TS loader's own passthrough and
 * never a config-file key. A *new* key appearing here means drift — update
 * both sides.
 */
const KNOWN_TS_ONLY_CONFIG_KEYS = new Set(['raw']);

/** REST endpoints declared by the TS protocol header manifests. */
function collectTsRestEndpoints() {
  const endpoints = [];
  for (const file of readdirSync(PROTOCOL_REST_DIR).filter((f) => f.endsWith('.ts'))) {
    const text = read(join(PROTOCOL_REST_DIR, file));
    for (const m of text.matchAll(/^\s*\*\s+(GET|POST|PUT|PATCH|DELETE)\s+(\/v1\/\S+)/gm)) {
      endpoints.push({ file, method: m[1], path: '/api' + m[2].split('?')[0] });
    }
  }
  return endpoints;
}

/** The routes the Rust server actually serves. */
function collectRustRoutes() {
  const source = ['src/server/mod.rs', 'src/server/router.rs']
    .map((p) => join(AGENT, p))
    .filter(existsSync)
    .map(read)
    .join('\n');

  const literals = [];
  for (const m of source.matchAll(/\("([A-Z]+)",\s*"(\/api\/v[12][^"]*)"\)/g)) {
    literals.push({ method: m[1], path: m[2] });
  }
  const guards = [];
  for (const m of source.matchAll(/\(\s*"([A-Z]+)"\s*,\s*p\s*\)\s*if([\s\S]{0,260}?)=>\s*\{/g)) {
    // Drop negated clauses first: `!p.ends_with("/trust")` is a constraint on
    // what the route is *not*, not a suffix it must have.
    const cond = m[2]
      .replace(/!\s*p\.ends_with\([^)]*\)/g, '')
      .replace(/!\s*p\.contains\([^)]*\)/g, '');
    guards.push({
      method: m[1],
      starts: [...cond.matchAll(/starts_with\("(\/api\/v[12][^"]*)"\)/g)].map((x) => x[1]),
      ends: [...cond.matchAll(/ends_with\("([^"]+)"\)/g)].map((x) => x[1]),
      contains: [...cond.matchAll(/contains\("([^"]+)"\)/g)].map((x) => x[1]),
      action: cond.match(/extract_session_action\(\s*p\s*,\s*"(\w+)"/)?.[1],
    });
  }
  return { literals, guards };
}

function rustRouteFor(endpoint, routes) {
  const target = normalizePath(endpoint.path);
  for (const lit of routes.literals) {
    if (lit.method !== endpoint.method) continue;
    const shape = normalizePath(lit.path);
    if (target === shape || target.startsWith(shape + '/') || target.startsWith(shape + ':'))
      return lit;
  }
  for (const g of routes.guards) {
    if (g.method !== endpoint.method) continue;
    if (g.action) {
      if (endpoint.path.endsWith(':' + g.action)) return { method: g.method, path: ':' + g.action };
      continue;
    }
    if (!g.starts.length) continue;
    if (!g.starts.some((s) => target.startsWith(normalizePath(s)))) continue;
    const tail = target.slice(Math.max(...g.starts.map((s) => normalizePath(s).length)));
    const okEnd = g.ends.length === 0 || g.ends.some((e) => endpoint.path.endsWith(e) || tail.endsWith(e));
    const okContains = g.contains.every((c) => endpoint.path.includes(c));
    if (okEnd && okContains) return { method: g.method, path: g.starts[0] };
  }
  return null;
}

/** Rust `#[napi] pub (async) fn` names, by module. */
function collectRustNapiFns() {
  const names = new Set();
  for (const file of ['src/napi_bindings.rs', 'src/native/napi_bindings.rs']) {
    const lines = read(join(AGENT, file)).split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^\s*#\[napi\]\s*$/.test(lines[i])) continue;
      for (let j = i + 1; j < Math.min(i + 14, lines.length); j += 1) {
        const fn = lines[j].match(/^\s*pub\s+(?:async\s+)?fn\s+([a-z_0-9]+)/);
        if (fn) {
          names.add(fn[1]);
          break;
        }
        if (/^\s*pub\s+(struct|enum|const|static|mod)\b/.test(lines[j])) break;
      }
    }
  }
  return names;
}

const camelCase = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const normalizeKey = (s) => s.replace(/_/g, '').toLowerCase();

/** Control-frame op types the TS protocol declares as client -> server. */
function collectTsClientOps() {
  const text = read(join(ROOT, 'packages/protocol/src/ws-control.ts'));
  const ops = new Set();
  for (const m of text.matchAll(/type:\s*'([a-z_]+)',\s*direction:\s*'client_to_server'/g))
    ops.add(m[1]);
  return ops;
}

/** Control-frame types the Rust `parse_inbound` dispatcher handles. */
function collectRustInboundTypes() {
  const text = read(join(AGENT, 'src/server/ws_protocol.rs'));
  const body = text.match(/pub fn parse_inbound[\s\S]*?\n\}/)?.[0] ?? '';
  return new Set([...body.matchAll(/Some\("([a-z_]+)"\)/g)].map((m) => m[1]));
}

/** Top-level config keys the TS document schema accepts. */
function collectTsConfigKeys() {
  const text = read(join(ROOT, 'packages/node-sdk/src/config-local/schema.ts'));
  const block = text.match(/export const KimiConfigSchema = z\.object\(\{([\s\S]*?)\n\}\);/)?.[1] ?? '';
  return [...new Set([...block.matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1]))];
}

/** Top-level config keys the Rust `KimiConfig` deserializes (rename + alias). */
function collectRustConfigKeys() {
  const text = read(join(AGENT, 'src/config/mod.rs'));
  const struct = text.match(/pub struct KimiConfig \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const keys = new Set();
  for (const m of struct.matchAll(/#\[serde\(([^)]*)\)\]\s*pub\s+([a-z_0-9]+)/g)) {
    const rename = m[1].match(/rename\s*=\s*"([^"]+)"/);
    keys.add(rename ? rename[1] : m[2]);
    for (const a of m[1].matchAll(/alias\s*=\s*"([^"]+)"/g)) keys.add(a[1]);
  }
  for (const m of struct.matchAll(/^\s*pub\s+([a-z_0-9]+)\s*:/gm)) keys.add(m[1]);
  return keys;
}

function main() {
  /** @type {string[]} */
  const failures = [];

  // ── REST ────────────────────────────────────────────────────────────────
  const tsEndpoints = collectTsRestEndpoints();
  const routes = collectRustRoutes();
  const restMissing = tsEndpoints.filter((ep) => !rustRouteFor(ep, routes));
  for (const ep of restMissing) failures.push(`REST  ${ep.method} ${ep.path} (declared in rest/${ep.file})`);

  // ── WS events ───────────────────────────────────────────────────────────
  const webOnly = WsEventContract.webEvents.filter(
    (e) => !WsEventContract.serverEvents.includes(e),
  );
  const unexpectedWebOnly = webOnly.filter((e) => !KNOWN_CLIENT_NOOP_EVENTS.has(e));
  for (const e of unexpectedWebOnly) failures.push(`WS    ${e} (web expects it, server never emits it)`);
  const staleNoop = [...KNOWN_CLIENT_NOOP_EVENTS].filter(
    (e) => !WsEventContract.webEvents.includes(e) || WsEventContract.serverEvents.includes(e),
  );
  for (const e of staleNoop) failures.push(`WS    ${e} (stale KNOWN_CLIENT_NOOP_EVENTS entry — update the allowlist)`);

  // Prompt lifecycle vocabulary (`packages/protocol` event set): the Rust
  // server must actually emit these or a steered / settled prompt goes
  // nowhere. The golden `serverEvents` list does not carry them today, so
  // this checks the emitting source directly.
  const rustSources = readTree(join(AGENT, 'src'), '.rs');
  for (const e of ['prompt.submitted', 'prompt.completed', 'prompt.aborted', 'prompt.steered']) {
    if (!rustSources.includes(`"${e}"`))
      failures.push(`WS    ${e} (protocol event not emitted from packages/kimi-agent/src)`);
  }

  // ── WS control frames (client -> server) ────────────────────────────────
  const tsClientOps = collectTsClientOps();
  const rustInbound = collectRustInboundTypes();
  for (const op of tsClientOps) {
    if (!rustInbound.has(op))
      failures.push(
        `WSCTL ${String(op)} is declared client_to_server but parse_inbound does not handle it`,
      );
  }

  // ── Tools ───────────────────────────────────────────────────────────────
  const rustTools = readTree(join(AGENT, 'src/tools'), '.rs');
  const nativeGroups = ['v2Native', 'replOnlyNative', 'v2Github'];
  for (const group of nativeGroups) {
    for (const name of ToolNameContract[group] ?? []) {
      if (!rustTools.includes('"' + name + '"')) failures.push(`TOOL  ${group}: ${name} has no string in src/tools/**`);
    }
  }

  // ── napi ────────────────────────────────────────────────────────────────
  const rustNapi = collectRustNapiFns();
  const dtsNapi = new Set(
    [...read(join(AGENT, 'napi-contract.d.ts')).matchAll(/export declare function ([A-Za-z_0-9]+)/g)].map(
      (m) => m[1],
    ),
  );
  for (const declared of dtsNapi) {
    if (![...rustNapi].some((r) => camelCase(r) === declared))
      failures.push(`NAPI  ${declared} declared in napi-contract.d.ts but no #[napi] fn exports it`);
  }
  for (const exported of rustNapi) {
    if (!dtsNapi.has(camelCase(exported)))
      failures.push(
        `NAPI  #[napi] fn ${String(exported)} has no declaration in napi-contract.d.ts`,
      );
  }

  // ── Config document keys ────────────────────────────────────────────────
  const tsConfigKeys = collectTsConfigKeys();
  const rustConfigNorm = new Set([...collectRustConfigKeys()].map(normalizeKey));
  for (const key of tsConfigKeys) {
    if (!rustConfigNorm.has(normalizeKey(key)) && !KNOWN_TS_ONLY_CONFIG_KEYS.has(key))
      failures.push(
        `CONFIG ${key} is accepted by KimiConfigSchema but KimiConfig has no matching field/alias`,
      );
  }

  if (failures.length) {
    console.error('❌ Rust <-> TS interface parity check failed.\n');
    console.error('The two sides disagree on the following surface items:\n');
    for (const f of failures) console.error('  - ' + f);
    console.error('\nFix the Rust implementation or update the contract artifact, then re-run.');
    process.exit(1);
  }

  console.log('✅ Rust <-> TS interface parity OK:');
  console.log(
    `   REST ${tsEndpoints.length} endpoints | WS events server=${WsEventContract.serverEvents.length} (web-only no-ops=${webOnly.length}) | WS ctl ${tsClientOps.size} client ops | tools ${nativeGroups.reduce((n, g) => n + (ToolNameContract[g]?.length ?? 0), 0)} | napi ${dtsNapi.size} | config ${tsConfigKeys.length} keys`,
  );
}

main();
