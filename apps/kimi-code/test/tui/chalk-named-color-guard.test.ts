import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(__dirname, '..', '..', 'src');

const NAMED_COLORS = [
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'gray',
  'grey',
  'black',
  'blackBright',
  'whiteBright',
  'redBright',
  'greenBright',
  'yellowBright',
  'blueBright',
  'magentaBright',
  'cyanBright',
  'dim',
];

// `chalk.red(` calls and bare references like `const dim = chalk.dim;` —
// a cached styled function escapes theme switching just as much as a call.
const CHALK_NAMED_PATTERN = new RegExp(`chalk\\.(${NAMED_COLORS.join('|')})(?!\\w)`);

// The theme system is the sanctioned home for raw chalk styles, and
// headless CLI printers (src/cli) never theme-switch.
const EXEMPT_DIRS = [join('tui', 'theme'), 'cli'];

// No try/catch here on purpose: a wrong `SRC_ROOT` must throw rather than
// degrade into an empty scan that reports "clean". The
// `scans a non-empty source tree` test below is the belt to that suspenders.
function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(p, files);
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.spec.ts')
    ) {
      files.push(p);
    }
  }
  return files;
}

/** The production files this guard actually inspects (exempt dirs removed). */
function scannedFiles(): string[] {
  return walk(SRC_ROOT).filter((file) => {
    const dir = relative(SRC_ROOT, file);
    return !EXEMPT_DIRS.some(
      (exempt) => dir.startsWith(exempt + sep) || dir === exempt || dir.startsWith(exempt),
    );
  });
}

describe('chalk named color guard', () => {
  // Walked inside a test rather than at module scope so a bad `SRC_ROOT`
  // fails a named test with its own message instead of erroring during
  // collection and reporting "no tests".
  it('scans a non-empty source tree', () => {
    expect(
      scannedFiles().length,
      `No TypeScript sources found under ${SRC_ROOT} outside the exempt dirs ` +
        `(${EXEMPT_DIRS.join(', ')}). A guard that inspects nothing passes vacuously — ` +
        `check SRC_ROOT and EXEMPT_DIRS before trusting a pass.`,
    ).toBeGreaterThan(0);
  });

  it('forbids chalk named colors in production source code', () => {
    const offenders: { file: string; line: number; snippet: string }[] = [];
    const files = scannedFiles();
    let inBlockComment = false;
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        const trimmed = line.trimStart();

        if (inBlockComment) {
          if (trimmed.includes('*/')) inBlockComment = false;
          continue;
        }

        if (trimmed.startsWith('/*')) {
          if (!trimmed.includes('*/')) inBlockComment = true;
          continue;
        }

        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

        CHALK_NAMED_PATTERN.lastIndex = 0;
        const m = CHALK_NAMED_PATTERN.exec(line);
        if (m) {
          offenders.push({
            file: relative(SRC_ROOT, file),
            line: i + 1,
            snippet: line.trim(),
          });
        }
      }
    }
    expect(
      offenders,
      `Found chalk named color usages. Use chalk.hex(colors.<token>) or theme styles instead.\n` +
        offenders.map((o) => `  ${o.file}:${String(o.line)}  ${o.snippet}`).join('\n'),
    ).toEqual([]);
  });
});
