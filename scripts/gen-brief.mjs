#!/usr/bin/env node
/**
 * Pre-development brief generator.
 *
 * Reads architecture.json and, for a target module or task description,
 * outputs a development contract: target module, its API surface, who
 * depends on it (impact), architecture rules it must respect, and an
 * acceptance checklist. The AI calls this before implementing, so it
 * writes to a contract rather than blindly.
 *
 * Usage:
 *   bun scripts/gen-brief.mjs --module <id>
 *   bun scripts/gen-brief.mjs --task "<description>"
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const model = JSON.parse(readFileSync(resolve(root, 'architecture.json'), 'utf8'));

// ── Parse args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let moduleId = null;
let taskDesc = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--module' && args[i + 1]) moduleId = args[++i];
  else if (args[i] === '--task' && args[i + 1]) taskDesc = args[++i];
}

if (!moduleId && !taskDesc) {
  console.error('Usage: bun scripts/gen-brief.mjs --module <id> | --task "<description>"');
  console.error(`Available modules: ${model.modules.map((m) => m.id).join(', ')}`);
  process.exit(1);
}

// ── Resolve target module ───────────────────────────────────────────────────

let target = null;
if (moduleId) {
  target = model.modules.find((m) => m.id === moduleId);
  if (!target) {
    console.error(`Unknown module: ${moduleId}`);
    console.error(`Available: ${model.modules.map((m) => m.id).join(', ')}`);
    process.exit(1);
  }
} else {
  // Match task description against module names/descriptions.
  const q = taskDesc.toLowerCase();
  const scored = model.modules
    .map((m) => {
      const hay = `${m.id} ${m.name}`.toLowerCase();
      const score = q.split(/\s+/).filter((w) => w.length > 2 && hay.includes(w)).length;
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) {
    console.error(`No module matches task: "${taskDesc}"`);
    process.exit(1);
  }
  target = scored[0].m;
}

// ── Compute impact (who depends on target) ──────────────────────────────────

const dependents = model.modules.filter((m) => (m.deps ?? []).includes(target.id));

// ── Compute rules that apply to target ──────────────────────────────────────

const applicableForbid = model.rules.forbid.filter((f) => f.from === target.layer);

// ── Output ──────────────────────────────────────────────────────────────────

console.log('# Development Brief\n');
console.log(`> Generated from architecture.json — the architecture contract, not a suggestion.\n`);

console.log(`## Target module\n`);
console.log(`- **id**: \`${target.id}\``);
console.log(`- **name**: ${target.name}`);
console.log(`- **layer**: ${target.layer} (order: ${model.rules.layerOrder.join(' → ')})`);
console.log(`- **source**: \`${target.source}\`\n`);

console.log(`## Dependencies (what ${target.id} may use)\n`);
if (target.deps?.length) {
  for (const dep of target.deps) {
    const depMod = model.modules.find((m) => m.id === dep);
    console.log(`- \`${dep}\` (${depMod?.layer ?? '?'})`);
  }
} else {
  console.log('- (none — leaf module)');
}
console.log('');

console.log(`## Impact (who depends on ${target.id})\n`);
if (dependents.length) {
  for (const d of dependents) {
    console.log(`- \`${d.id}\` (${d.layer})`);
  }
} else {
  console.log('- (none — safe to change freely)');
}
console.log('');

console.log(`## Architecture rules (must respect)\n`);
console.log(`- Layer order: \`${model.rules.layerOrder.join(' → ')}\` — a module may only depend on same-or-lower layers.`);
if (applicableForbid.length) {
  for (const f of applicableForbid) {
    console.log(`- **FORBID**: ${f.from} → ${f.to} — ${f.reason}`);
  }
} else {
  console.log('- No forbidden dependency directions from this layer.');
}
if (model.rules.acyclic) {
  console.log('- **ACYCLIC**: dependencies must not form a cycle.');
}
console.log('');

console.log(`## Acceptance checklist\n`);
console.log('- [ ] Implementation stays within the declared `source` directory.');
console.log('- [ ] No new dependency on a higher layer (see FORBID above).');
console.log('- [ ] No circular dependency introduced.');
console.log('- [ ] If the module\'s public API changed, all dependents (see Impact) are updated.');
console.log('- [ ] `bun run check:architecture` passes after the change.');
console.log('');

console.log(`## Suggested workflow\n`);
console.log('1. Read the target module source and its dependents before writing.');
console.log('2. Implement within the declared source directory.');
console.log('3. Run `bun run check:architecture` — must pass.');
console.log('4. If API changed, update dependents and re-run the check.');
