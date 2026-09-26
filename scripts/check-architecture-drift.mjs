#!/usr/bin/env node
/**
 * Architecture drift detector.
 *
 * Reads architecture.json (the formal module tree + dependency rules) and
 * checks the actual codebase against it. Fail-closed: any violation is an
 * error that blocks the pre-commit gate.
 *
 * Checks:
 *   A. Every module's source directory exists.
 *   B. Every module's deps are declared in the model (no undeclared deps).
 *   C. Dependency direction follows layerOrder (app -> sdk -> engine -> shared).
 *   D. No circular dependencies.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

/**
 * Check an architecture model against the actual codebase. Returns diagnostics;
 * the caller decides how to report them. Exported for testing.
 */
export async function checkArchitecture(model, rootDir) {
  const diagnostics = [];
  const diag = (severity, code, message, subject, evidence) =>
    diagnostics.push({ severity, code, message, subject, evidence });

  // Check A: source directories exist
  for (const mod of model.modules) {
    const dir = resolve(rootDir, mod.source);
    if (!existsSync(dir)) {
      diag('error', 'structure/missing-source', `Module "${mod.id}" source directory does not exist`, mod.id, mod.source);
    }
  }

  // Check B: deps declared in the model
  const declaredIds = new Set(model.modules.map((m) => m.id));
  for (const mod of model.modules) {
    for (const dep of mod.deps ?? []) {
      if (!declaredIds.has(dep)) {
        diag('error', 'deps/undeclared-target', `Module "${mod.id}" depends on "${dep}" which is not declared in the model`, mod.id, dep);
      }
    }
  }

  // Check C: dependency direction follows layerOrder
  const layerIndex = new Map(model.rules.layerOrder.map((l, i) => [l, i]));
  const layerOf = new Map(model.modules.map((m) => [m.id, m.layer]));

  /** Coerce a layer value to string for safe template interpolation. */
  function str(v) {
    return v === null || v === undefined ? '' : String(v);
  }

  for (const mod of model.modules) {
    const fromLayer = layerOf.get(mod.id);
    if (fromLayer === undefined) continue;
    const fromIdx = layerIndex.get(fromLayer);
    for (const dep of mod.deps ?? []) {
      const toLayer = layerOf.get(dep);
      if (toLayer === undefined) continue;
      const toIdx = layerIndex.get(toLayer);
      if (fromIdx === undefined || toIdx === undefined) continue;
      if (toIdx < fromIdx) {
        const rule = model.rules.forbid.find((f) => f.from === fromLayer && f.to === toLayer);
        const reason = rule?.reason ?? `${str(fromLayer)} must not depend on ${str(toLayer)}`;
        diag('error', 'deps/layer-violation', `Module "${mod.id}" (${str(fromLayer)}) depends on "${dep}" (${str(toLayer)}), violating layer order`, mod.id, reason);
      }
    }
  }

  // Check D: no circular dependencies
  function hasCycle() {
    const state = new Map();
    const path = [];
    function visit(id) {
      const s = state.get(id) ?? 0;
      if (s === 1) return path.slice(path.indexOf(id)).concat(id);
      if (s === 2) return null;
      state.set(id, 1);
      path.push(id);
      const mod = model.modules.find((m) => m.id === id);
      for (const dep of mod?.deps ?? []) {
        const cycle = visit(dep);
        if (cycle) return cycle;
      }
      path.pop();
      state.set(id, 2);
      return null;
    }
    for (const mod of model.modules) {
      const cycle = visit(mod.id);
      if (cycle) return cycle;
    }
    return null;
  }
  const cycle = hasCycle();
  if (cycle) diag('error', 'deps/cycle', `Circular dependency detected: ${cycle.join(' -> ')}`, cycle[0], cycle.join(' -> '));

  // ── Check E: fingerprint drift ────────────────────────────────────────────
  // Each module's source files are fingerprinted (SHA-256 of sorted path+content).
  // If the code changed but the stored fingerprint didn't, the architecture model
  // is stale — report drift so the model is refreshed before proceeding.
  const { createHash } = await import('node:crypto');
  function fingerprintOf(sourceDir) {
    const files = [];
    function walk(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          if (['node_modules', 'target', '.git'].includes(entry.name)) continue;
          walk(full);
        } else if (entry.isFile()) {
          const ext = extname(entry.name);
          if (['.ts', '.tsx', '.js', '.mjs', '.rs', '.json', '.md'].includes(ext)) {
            files.push(full);
          }
        }
      }
    }
    walk(sourceDir);
    files.sort((a, b) => a.localeCompare(b));
    const hash = createHash('sha256');
    for (const f of files) {
      hash.update(relative(sourceDir, f));
      hash.update(readFileSync(f));
    }
    return hash.digest('hex').slice(0, 16);
  }

  for (const mod of model.modules) {
    if (!mod.fingerprint) continue;
    const dir = resolve(rootDir, mod.source);
    if (!existsSync(dir)) continue; // already reported in Check A
    const current = fingerprintOf(dir);
    if (current !== mod.fingerprint) {
      diag('error', 'drift/fingerprint', `Module "${mod.id}" source changed but architecture model fingerprint is stale`, mod.id, `stored=${mod.fingerprint} current=${current}`);
    }
  }

  return diagnostics;
}

// ── Main block (runs when executed directly) ────────────────────────────────

if (import.meta.main) {
  const model = JSON.parse(readFileSync(resolve(root, 'architecture.json'), 'utf8'));
  const diagnostics = await checkArchitecture(model, root);

  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');

  for (const d of diagnostics) {
    const prefix = d.severity === 'error' ? '✗' : '⚠';
    console.log(`${prefix} [${d.code}] ${d.message}`);
    if (d.evidence) console.log(`    subject: ${d.subject}  evidence: ${d.evidence}`);
  }

  if (errors.length > 0) {
    console.log(`\n✗ Architecture check failed: ${errors.length} error(s), ${warnings.length} warning(s)`);
    process.exit(1);
  } else {
    console.log(`\n✓ Architecture check passed: ${model.modules.length} modules, ${warnings.length} warning(s)`);
    process.exit(0);
  }
}
