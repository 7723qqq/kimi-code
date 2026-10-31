import fs from 'node:fs';
import path from 'node:path';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const TARGET_DIR = path.join(PACKAGE_ROOT, 'src', 'features', 'gitMemory');
const EXEMPT_FILES = new Set(['flag.ts']);
const FORBIDDEN = [
  ['llm-adapter', /llm-adapter/],
  ['human/llm', /human\/llm/],
  ['kosong', /kosong/],
  ['provider', /provider/i],
  ['model-requester', /model-requester/],
  ['agentRuntime', /agentRuntime/],
];

export function extractImportSpecifiers(source) {
  const specifiers = [];
  const pattern = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  let match = pattern.exec(source);
  while (match !== null) {
    specifiers.push(match[1]);
    match = pattern.exec(source);
  }
  return specifiers;
}

export function findViolations(relPath, source) {
  if (EXEMPT_FILES.has(path.basename(relPath))) return [];
  const violations = [];
  for (const specifier of extractImportSpecifiers(source)) {
    for (const [label, pattern] of FORBIDDEN) {
      if (pattern.test(specifier)) {
        violations.push({ file: relPath, specifier, label });
      }
    }
  }
  return violations;
}

function collectSources(dir, rel = '') {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...collectSources(full, relPath));
      continue;
    }
    if (!/\.(ts|tsx|mts|mjs)$/.test(entry.name)) continue;
    files.push({ relPath, full });
  }
  return files;
}

function main() {
  const violations = [];
  let count = 0;
  for (const file of collectSources(TARGET_DIR)) {
    count += 1;
    const source = fs.readFileSync(file.full, 'utf8');
    violations.push(...findViolations(file.relPath, source));
  }
  if (violations.length > 0) {
    console.error('check-git-memory-injection: FAILED');
    for (const violation of violations) {
      console.error(
        `  ${violation.file}: imports ${violation.specifier} (${violation.label}) — the git memory injection path must stay free of model and provider code`,
      );
    }
    process.exit(1);
  }
  console.log(`check-git-memory-injection: OK (${count} files)`);
}

if (import.meta.main) main();
