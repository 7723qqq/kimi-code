/**
 * Benchmark: Rust native tools vs baseline operations.
 *
 * Tests: read, write, edit, grep, glob, bash
 * Each test runs N iterations and reports average time.
 */

const mod = require('./');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ITERATIONS = 100;
const WARMUP = 10;

// Create test fixtures
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-bench-'));

// Generate test files
function setup() {
  // Large file for read/grep benchmarks (1000 lines)
  const lines = [];
  for (let i = 0; i < 1000; i++) {
    lines.push(`// Line ${i + 1}: function compute${i}() { return ${i} * 2; }`);
  }
  fs.writeFileSync(path.join(tmpDir, 'large.ts'), lines.join('\n'));

  // File for edit benchmarks
  fs.writeFileSync(path.join(tmpDir, 'edit_target.ts'), 'const x = 1;\n'.repeat(100));

  // Many files for glob benchmarks
  const globDir = path.join(tmpDir, 'glob_test');
  fs.mkdirSync(globDir, { recursive: true });
  for (let i = 0; i < 50; i++) {
    fs.writeFileSync(path.join(globDir, `file_${i}.ts`), `// file ${i}`);
    fs.writeFileSync(path.join(globDir, `file_${i}.rs`), `// file ${i}`);
    fs.writeFileSync(path.join(globDir, `file_${i}.py`), `# file ${i}`);
  }

  // File for write benchmarks
  fs.writeFileSync(path.join(tmpDir, 'write_target.txt'), 'initial');
}

function bench(name, fn) {
  // Warmup
  for (let i = 0; i < WARMUP; i++) fn();

  // Actual benchmark
  const times = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }

  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const p95 = times[Math.floor(times.length * 0.95)];
  const min = times[0];
  const max = times[times.length - 1];

  return { name, median, mean, p95, min, max };
}

function formatMs(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(1)}μs`;
  return `${ms.toFixed(2)}ms`;
}

function printResult(r) {
  console.log(`  ${r.name.padEnd(40)} median=${formatMs(r.median).padStart(10)}  p95=${formatMs(r.p95).padStart(10)}  min=${formatMs(r.min).padStart(10)}`);
}

setup();

console.log(`Benchmark: ${ITERATIONS} iterations, ${WARMUP} warmup`);
console.log('='.repeat(80));

// ============================================================================
// nativeRead
// ============================================================================
console.log('\n--- Read ---');

printResult(bench('nativeRead (small file, 3 lines)', () => {
  mod.nativeRead(path.join(tmpDir, 'edit_target.ts'), { nLines: 3 });
}));

printResult(bench('nativeRead (large file, 1000 lines)', () => {
  mod.nativeRead(path.join(tmpDir, 'large.ts'));
}));

printResult(bench('nativeRead (tail -100)', () => {
  mod.nativeRead(path.join(tmpDir, 'large.ts'), { lineOffset: -100 });
}));

// ============================================================================
// nativeWrite
// ============================================================================
console.log('\n--- Write ---');

printResult(bench('nativeWrite (overwrite, 100 bytes)', () => {
  mod.nativeWrite(path.join(tmpDir, 'write_target.txt'), 'x'.repeat(100));
}));

printResult(bench('nativeWrite (append, 50 bytes)', () => {
  mod.nativeWrite(path.join(tmpDir, 'write_target.txt'), 'y'.repeat(50), { mode: 'append' });
}));

// ============================================================================
// nativeEdit
// ============================================================================
console.log('\n--- Edit ---');

printResult(bench('nativeEdit (single replace)', () => {
  mod.nativeEdit(path.join(tmpDir, 'edit_target.ts'), 'const x = 1', 'const x = 2');
}));

// ============================================================================
// nativeGrep
// ============================================================================
console.log('\n--- Grep ---');

printResult(bench('nativeGrep (content mode, single file)', () => {
  mod.nativeGrep('function', { path: path.join(tmpDir, 'large.ts'), outputMode: 'content' });
}));

printResult(bench('nativeGrep (files_with_matches, directory)', () => {
  mod.nativeGrep('file', { path: path.join(tmpDir, 'glob_test'), outputMode: 'files_with_matches' });
}));

printResult(bench('nativeGrep (count_matches, single file)', () => {
  mod.nativeGrep('Line', { path: path.join(tmpDir, 'large.ts'), outputMode: 'count_matches' });
}));

printResult(bench('nativeGrep (case insensitive)', () => {
  mod.nativeGrep('function', { path: path.join(tmpDir, 'large.ts'), caseInsensitive: true, outputMode: 'count_matches' });
}));

printResult(bench('nativeGrep (with context)', () => {
  mod.nativeGrep('function compute500', { path: path.join(tmpDir, 'large.ts'), context: 2, outputMode: 'content' });
}));

// ============================================================================
// nativeGlob
// ============================================================================
console.log('\n--- Glob ---');

printResult(bench('nativeGlob (*.ts, 50 files)', () => {
  mod.nativeGlob('*.ts', { path: path.join(tmpDir, 'glob_test') });
}));

printResult(bench('nativeGlob (*.{ts,rs}, brace expansion)', () => {
  mod.nativeGlob('*.{ts,rs}', { path: path.join(tmpDir, 'glob_test') });
}));

printResult(bench('nativeGlob (**/*.ts, recursive)', () => {
  mod.nativeGlob('**/*.ts', { path: tmpDir });
}));

// ============================================================================
// nativeBash
// ============================================================================
console.log('\n--- Bash ---');

printResult(bench('nativeBash (echo)', () => {
  mod.nativeBash('echo hello');
}));

printResult(bench('nativeBash (pwd)', () => {
  mod.nativeBash('pwd', { cwd: tmpDir });
}));

printResult(bench('nativeBash (ls | wc -l)', () => {
  mod.nativeBash('ls ' + path.join(tmpDir, 'glob_test') + ' | wc -l');
}));

// Cleanup
fs.rmSync(tmpDir, { recursive: true });

console.log('\n' + '='.repeat(80));
console.log('Done.');
