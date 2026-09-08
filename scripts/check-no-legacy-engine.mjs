// Terminal-state gate for the Rust engine migration (ROADMAP P161): fails
// when any retired engine package is still referenced from a live surface —
// dependency manifests, import/require specifiers, tsconfig program inputs,
// or the build/CI wiring. Prose mentions in comments and historical records
// (ROADMAP*.md, .changeset/, CHANGELOGs) are intentionally out of scope.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const RETIRED_PACKAGES = [
  'agent-core-v2',
  'kimi-native-tools',
  'klient',
  'acp-server',
];

const SPECIFIER_PATTERN = new RegExp(
  `['"]@moonshot-ai/(${RETIRED_PACKAGES.join('|')})['"]`,
);
const DEP_ENTRY_PATTERN = new RegExp(
  `["']@moonshot-ai/(${RETIRED_PACKAGES.join('|')})["']\\s*:`,
);
const PATH_PATTERN = new RegExp(
  `packages/(${RETIRED_PACKAGES.join('|')})(/|['"\\s)]|$)`,
);

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.mjs', '.rs', '.vue']);
const SKIP_DIRS = new Set([
  'node_modules',
  'target',
  'dist',
  'dist-web',
  'dist-native',
  'coverage',
  '.changeset',
  'docs',
  'graphify-out',
  '.tmp',
  '.worktrees',
  '.git',
  '.kimi',
  '.agents',
  '.arts',
  '.qoder',
  '.zcode',
  '.codeartsdoer',
  '.codegraph',
  '.workbuddy',
  'reports',
]);

function* walk(dir) {
  for (const entry of readdir(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

function readdir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const violations = [];

function scan(root, onFile) {
  for (const file of walk('.')) {
    const rel = relative('.', file).split(sep).join('/');
    if (rel.endsWith('.md') || rel.endsWith('.mdx')) continue;
    onFile(rel, file);
  }
}

scan('.', (rel, file) => {
  const base = file.split(sep).pop() ?? '';
  const text = readFileSync(file, 'utf8');

  if (base === 'package.json') {
    if (DEP_ENTRY_PATTERN.test(text)) {
      violations.push(`${rel}: dependency entry on a retired package`);
    }
    return;
  }

  const ext = base.split('.').pop() ?? '';
  if (CODE_EXTENSIONS.has(`.${ext}`) || base.endsWith('.d.ts')) {
    if (SPECIFIER_PATTERN.test(text)) {
      violations.push(`${rel}: retired package specifier in code`);
    }
    return;
  }

  if (
    base.startsWith('tsconfig') ||
    base === 'flake.nix' ||
    rel.startsWith('.github/workflows/') ||
    base === 'bun.lock'
  ) {
    const pathMatch = text.match(PATH_PATTERN);
    if (pathMatch) {
      violations.push(`${rel}: build/config reference to packages/${pathMatch[1]}`);
    }
  }
});

if (violations.length > 0) {
  console.error(`check-no-legacy-engine: ${violations.length} retired-engine reference(s):`);
  for (const violation of violations) console.log(`  - ${violation}`);
  process.exit(1);
}
console.log('check-no-legacy-engine: no retired-engine references in live surfaces.');