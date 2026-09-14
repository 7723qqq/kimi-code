// Helper for the Windows process-tree kill test (test/local.test.ts).
//
// Boots a parent → child → grandchild chain and writes the grandchild's pid
// to the path passed as `process.argv[2]`, then idles so the test can kill
// the parent and assert the grandchild is reaped too.
//
// Lives in a real file (rather than an inline `node -e` string) so the path
// travels via argv instead of being embedded in nested template literals —
// inline multi-line `node -e` with backslash paths gets mangled by Node's
// Windows arg-quoting and by JS string escapes (`\f` etc.).
//
// The pidfile path reaches the middle child via the KILLTREE_PIDFILE env var,
// not via `-e` argv: Node's `node -e code arg` maps arg to process.argv[1],
// but Bun's shim does not, and under the Bun test runtime `node` resolves to
// that shim — an argv-based pidfile made the write fail with
// ERR_INVALID_ARG_TYPE and the test read ENOENT.

const { spawn } = require('node:child_process');

const pidPath = process.argv[2];
if (!pidPath) {
  process.exit(2);
}

// Single-line child code: no newlines, no nested template literals, and the
// pid path comes from the environment (not an -e argv slot), so it survives
// Windows arg-quoting and both Node/Bun -e argv layouts intact.
const childCode = [
  "const { spawn } = require('node:child_process');",
  "const { writeFileSync } = require('node:fs');",
  "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);",
  'writeFileSync(process.env.KILLTREE_PIDFILE, String(g.pid));',
  'setInterval(() => {}, 1000);',
].join(' ');

spawn(process.execPath, ['-e', childCode], {
  stdio: 'inherit',
  env: { ...process.env, KILLTREE_PIDFILE: pidPath },
});
setInterval(() => {}, 1000);
