# bun-migrate

Translate a pnpm + Node project to Bun, with a journal that records every change.

The tool is deliberately split into layers by how provable each rewrite is. A
rewrite that cannot be shown equivalent is reported, not applied.

## Why the layers are separate

`bun install` already converts an existing `pnpm-lock.yaml`, `yarn.lock` or
`package-lock.json` into `bun.lock` on its own. Reimplementing that would be
strictly worse. So dependency resolution is not this tool's job — it deletes the
old lockfile and tells you to run `bun install --lockfile-only`.

What is left splits by risk:

| layer      | what it changes                                                                                                                             | how it is justified                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `config`   | `.npmrc`, `.nvmrc`, `engines.node`, pnpm/npm/npx in scripts, CI setup steps                                                                 | text transformations with a fixed target                       |
| `packages` | `pnpm-workspace.yaml` globs, lockfiles, `vitest.config.ts`, package `imports` → tsconfig paths, **and npm dependencies Bun now implements** | Bun's documented equivalents, member by member                 |
| `tests`    | `vitest` / `jest` imports to `bun:test`, `vi.fn` to `mock`                                                                                  | `bun:test` exports the same names                              |
| `source`   | `node:` calls to Bun APIs, through either `import` or `require`                                                                             | a per-call condition, plus a Node-versus-Bun differential test |

The `packages` layer covers two different things on purpose. The first is
workspace scaffolding: pnpm globs, lockfiles, vitest project configs. The second
is dependency removal — a package whose whole used surface Bun now implements
natively can leave `package.json` entirely, which is a bigger win than swapping
any single call.

Verified package replacements, each checked for equal output before being
offered:

| package        | Bun               | verified members                                                                                             |
| -------------- | ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `yaml`         | `Bun.YAML`        | `parse`, `stringify`                                                                                         |
| `js-yaml`      | `Bun.YAML`        | `load`, `dump`                                                                                               |
| `smol-toml`    | `Bun.TOML`        | `parse`, `stringify`                                                                                         |
| `json5`        | `Bun.JSON5`       | `parse`, `stringify`                                                                                         |
| `strip-ansi`   | `Bun.stripANSI`   | default export                                                                                               |
| `string-width` | `Bun.stringWidth` | default export                                                                                               |
| `which`        | `Bun.which`       | `sync`, which maps to `Bun.which(...)` directly because `Bun.which` is synchronous and has no `.sync` member |
| `semver`       | `Bun.semver`      | **report-only**: only `order` and `satisfies` exist; `sort`, `valid`, `gt`, `maxSatisfying` do not           |
| `marked`       | `Bun.markdown`    | **report-only**: only the simplest `parse` to html overlaps                                                  |

A replacement is offered only when _every_ imported member was verified. `import
{ satisfies } from 'semver'` is refused even though that one member works,
because a partial migration would leave the import removed and the remaining
call unresolved — a run-time failure instead of a build error.

## Module replacements that are not a rename

Two migrations change enough behaviour that they are reported, never applied.
Both are recorded in `src/modules-map.mjs` as measured facts rather than prose.

**`node:sqlite` -> `bun:sqlite`.** The everyday path matches — `exec`, `prepare`,
`all`, `get`, `iterate`, `run`, positional and named binding, and `transaction`
all produce equal results. Four things do not:

| behaviour                  | `node:sqlite`             | `bun:sqlite`                                                                |
| -------------------------- | ------------------------- | --------------------------------------------------------------------------- |
| `get()` on an empty result | `undefined`               | `null`                                                                      |
| integer above 2^53         | throws `ERR_OUT_OF_RANGE` | returns a **silently rounded number** unless `statement.safeIntegers(true)` |
| error code                 | `ERR_SQLITE_ERROR`        | `SQLITE_ERROR`                                                              |
| large-int opt-in           | `setReadBigInts(true)`    | `safeIntegers(true)`                                                        |

The integer row is the dangerous one. `9007199254740993` reads back as
`9007199254740992` on the Bun side with no error, so a port that does not add the
opt-in produces wrong data instead of failing. Nine `node:sqlite` methods have no
counterpart (`applyChangeset`, `createSession`, `setAuthorizer`, …).

**`node:http` -> `Bun.serve`.** Different programming model, not a faster
`node:http`: the handler takes a Web `Request` and returns a `Response`, there is
no `res.write`, and the port comes from the returned object rather than a
`listen` callback. Reported only.

Pure additions — `Bun.S3Client`, `Bun.redis`, `Bun.FFI`, `Bun.Terminal`,
`Bun.WebView`, `Bun.Archive`, `Bun.Image` — have no Node counterpart at all, so
there is nothing to migrate from and they are deliberately absent from both
tables.

`source` is the only layer that rewrites executable logic, so it is the only one
where a mistake silently changes behaviour. That is why its rules live in
`src/pairings.mjs` with an explicit `check`, and why `test/differential.test.mjs`
runs each rule's before-and-after under both runtimes.

## What `effect` means

Every rule records what the rewrite buys:

- **`speed`** — Bun's native implementation is on a faster path.
- **`report-only`** — never applied. The replacement would change control flow,
  the result type, or the bytes.

A third value, **`consistency`** ("the result is identical and the only gain is
that the codebase stops mixing two APIs for one job"), used to be documented here
and grouped by in `rules-report.mjs`. No rule ever carried it, so it was an empty
category that made the report promise a classification it did not have. It has been
removed; if a real consistency-only rule is ever added, the value comes back with it.

A `report-only` rule does **not** mean the code falls back to Node. Every
`node:` specifier resolves to Bun's own implementation, written in Bun's
C++/Rust binding layer — `node:fs` goes through `internal/fs/binding`,
`node:path` through `$cpp("Path.cpp")`. Leaving a `node:` call alone still runs
on Bun. `report-only` only means "the Bun-native API is not a drop-in
replacement for this call site", not "this call needs Node".

`report-only` is not a lesser category; it is where the tool records what it
found. Every entry below was proven by running both runtimes, not read off a doc:

| finding                             | why the Bun-native API is not a drop-in                                                                                                                                                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deflateSync`, `inflateSync`        | **Different format.** Node's `deflateSync` emits a zlib wrapper (`78 9c` header, adler32 tail); `Bun.deflateSync` emits raw deflate with neither. `Bun.inflateSync` rejects every stream `deflateSync` produces, and Node rejects every stream `Bun.deflateSync` produces. |
| `deflateRawSync`                    | Same format, different bytes. Identical up to 200 bytes, divergent from 500 up because the two pick different block boundaries. Both inflate correctly, but anything that hashes or compares the compressed output sees a different value.                                 |
| `isDeepStrictEqual`                 | **Ownership semantics differ.** `isDeepStrictEqual({a: undefined}, {})` is `false`; `Bun.deepEquals` returns `true` because it ignores an undefined-valued key.                                                                                                            |
| `readFile`, `writeFile`, `copyFile` | Measured slower or equal. `Bun.file().text()` ran at 0.57-0.86x of `readFile`, `Bun.write` at 0.34-0.78x of `writeFile` across the measured sizes. Both sides are Bun; the `node:` path happens to be the faster one here. |
| `pathToFileURL`                     | On Windows, Node's resolution gives `/tmp/x` -> `file:///D:/tmp/x`; Bun's gives `file:///tmp/x`. Different URL, different file.                                                                                                                                            |
| `readFileSync`, `writeFileSync`     | `Bun.file()` is lazy and `Bun.write` is async, so a sync call site would change timing or control flow.                                                                                                                                                                    |
| `spawnSync`                         | Node takes `(cmd, args, opts)` and returns `{status,stdout,stderr}`; Bun takes an argv array and returns `{exitCode,...}`. Both the call shape and the result fields differ.                                                                                               |
| `brotliCompressSync`, `util.format` | Bun exposes no equivalent API, so there is nothing to swap to. The call keeps running Bun's own `node:zlib` / `node:util` implementation.                                                                                                                                  |

The `speed` side is measured too, not assumed. Everything below is the same
process — `require('node:crypto')` inside Bun is Bun's own compiled
implementation, so timing both in one Bun process compares the two
implementations rather than two process start-ups:

| rule                                               | measured range                                      | note                                                                    |
| -------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| `gzipSync` -> `Buffer.from(Bun.gzipSync(...))`     | 3.0x at 1 MB up to 39.6x at 16 B                    | faster, wrapper preserves Node's Buffer type; see the byte caveat below |
| `stripVTControlCharacters` -> `Bun.stripANSI`      | 14.7x at 26 KB up to 16.4x at 260 B                 | flat across sizes                                                       |
| `gunzipSync` -> `Buffer.from(Bun.gunzipSync(...))` | 2.2x at 1 MB up to 33.3x at 16 B                    | wrapper preserves the Buffer type                                       |
| `zstdCompressSync` -> `Bun.zstdCompressSync`       | 1.4x at 100 KB up to 8.3x at 16 B                   | frames are byte-identical, unlike gzip                                  |
| `zstdDecompressSync` -> `Bun.zstdDecompressSync`   | 1.6x at 100 KB up to 80.7x at 16 B                  |                                                                         |
| `globSync` -> `Bun.Glob`                           | 2.0x-5.3x                                           | wider with directory size                                               |
| `createHash` / `createHmac` -> `Bun.CryptoHasher`  | 1.3x-1.8x for sha256/sha1, 1.0x-1.2x for sha512/md5 | 2.0x under 4 worker threads                                             |
| `fileURLToPath` -> `Bun.fileURLToPath`             | ~2.6x                                               |                                                                         |

`createHmac` is rewritten only when the key is provably a string, `Buffer`/typed
array/`ArrayBuffer`/`DataView`. Node also accepts a `KeyObject` or `CryptoKey`;
`Bun.CryptoHasher` throws `ERR_INVALID_ARG_TYPE` for those, so a key variable of
unknown type is reported instead of guessed at.

`createHash`/`createHmac` are also rewritten only when a local hasher reaches
exactly one `digest()` with no `update()` after it, and no `copy()` after it. After
a Hash digest Node throws while Bun returns an empty digest; HMAC is the reverse
(Node returns an empty digest, Bun throws), and Node's Hmac has no `copy()`.
Streaming hashes (`const h = createHash(...); h.update(...); h.digest()`) and a
Hash copied before its digest remain supported.

`gzipSync`, `gunzipSync` and `inflateRawSync` return a `Buffer` under Node. Bun's
`Bun.gzipSync`, `Bun.gunzipSync` and `Bun.inflateSync` return a `Uint8Array`, so the
rewrite wraps the result in `Buffer.from(...)`; `zstd*` and
`CryptoHasher.digest()` already return a Buffer.

### `gzip` is interoperable, not byte-identical

An earlier version of this file said the gzip output was "byte identical, verified".
That was wrong, and the way it was wrong matters.

Inside one Bun process, `require('node:zlib').gzipSync` and `Bun.gzipSync` do
produce the same bytes — because Bun's `node:zlib` _is_ `Bun.gzipSync`, so the
comparison is a tautology. Against a stream produced by real Node, they differ:
measured across ten payloads, eight differed, and the widest case
(`'compressible ' x 1000`) came out 76 bytes from Node against 125 bytes from Bun.

Both directions decode correctly, so a migrated program keeps working and any
stored archive stays readable. What breaks is a checksum over the compressed
bytes, or a stored fixture compared for equality. That is why the rule is still
`speed` — the decoded data is identical — but the claim is now "decodes in either
runtime", not "same bytes".

The `sha512`/`md5` rows sit close to parity, so treat "speed" there as "not
slower" rather than "much faster". Three runs at 300 iterations per round swung
the 16 B `md5` case between 0.91x and 1.14x; at 5000 iterations and nine rounds
it settles at 1.12x with no case below 1.0. The sub-1.0 readings were noise, and
stating that is more useful than reporting only the favourable run.

Full matrices — every algorithm, size and operation, with the iteration count for
each row — are in [`PERFORMANCE.md`](PERFORMANCE.md).

**The intent is that a rule cannot claim "faster" without a row there. It is not
met yet.** Measured against the current rule table, eleven `speed` rules have no
row in `PERFORMANCE.md`: `crypto-createHmac`, `zlib-zstdCompressSync`,
`zlib-zstdDecompressSync`, `zlib-inflateRawSync`, `url-fileURLToPath`,
`fs-globSync` (a Glob section exists, but its rows are not tied to this rule), and
the seven npm package rules (`yaml`, `js-yaml`, `smol-toml`, `json5`, `strip-ansi`,
`string-width`, `which`). The zstd row in the table above comes from a one-off run
on this machine and has no matrix entry; every one of these summaries says
"measured" on the strength of the probe in `test/performance.test.mjs`, which
asserts a direction, not a number.

That is stated here rather than fixed by deleting the rule, because the direction
is measured and the missing part is the matrix row. What the sentence above means
in practice today: a rule's claim is backed by a direction test, and only the six
`node:` entries in the table above have a size-by-size number behind them.

`gzipSync` and `gunzipSync` decode each other's output in both directions, which
is why they are rewritten while `deflate` is not: gzip carries its own header and
CRC, so the two runtimes agree on the format. They do **not** agree on the exact
bytes — against a stream Node produced, 8 of 10 measured payloads differed. See the
table in [`PERFORMANCE.md`](PERFORMANCE.md) before relying on a checksum over
compressed output.

### zstd does agree on the exact bytes

`zstdCompressSync` looks like the gzip case and is not. Measured across 25 payloads
from 1 byte to 32 MB — random bytes, ASCII text, JSON lines, long zero runs, this
file's own source — Node 24.9.0 and Bun 1.4.4 produced **identical frames every
time**, and each runtime decoded the other's output. So the rule may claim byte
identity, and a checksum over compressed output survives the migration.

The earlier wording said "cross-runtime frames decode but are not byte-identical".
That sentence was inherited from the gzip finding rather than measured for zstd; the
claim is now pinned by `differential.test.mjs`, which fails if the frames ever
diverge.

The measurement also produced two whole-project facts that no pairing captures,
and both argue against treating a migration as a strict win:

- Bun boots 1.49x faster (44.7 ms vs 66.4 ms), but the advantage disappears once
  a script does any work: a trivial script measures 0.99x.
- Bun's baseline RSS is 81.6 MB against Node's 33.8 MB — 2.4x, structural.

## Why nothing is hardcoded to a version

Any rule that depends on what Bun provides asks the runtime, not a table:

- `src/capabilities.mjs` probes `new Bun.CryptoHasher(alg)` and the HMAC form
  separately. They genuinely differ — `shake128` hashes but is not an HMAC
  algorithm — and a version-pinned list cannot express that.
- Digest encodings are probed the same way, so a future Bun that drops or adds
  one is handled without touching a rule.
- A rule whose probe fails is skipped with the reason, so the same tool stays
  correct when Bun or Node moves.

The only place a version appears is `packageManager: "bun@<running version>"`,
which is written from `Bun.version` rather than a literal.

## Usage

```
bun tools/bun-migrate/src/cli.mjs scan  --root <dir>     # dry run, writes nothing
bun tools/bun-migrate/src/cli.mjs apply --root <dir>     # write, and record a journal
bun tools/bun-migrate/src/cli.mjs revert <journal.json>  # undo
bun tools/bun-migrate/src/cli.mjs help                   # usage; --help works too
bun tools/bun-migrate/src/rules-report.mjs               # what the rules cover, right now
```

`rules-report.mjs` prints the live rule table grouped by `effect`, plus a sample
of the runtime capability probes. It reads the same `pairings.mjs` the migration
uses, so it cannot drift from what the tool will actually do.

`apply` refuses to run over uncommitted changes unless `--allow-dirty` is passed,
because a migration you cannot diff is a migration you cannot review. The same
refusal covers a directory that is not a git repository at all: measured, `apply`
in a plain directory used to write everything and exit 0, because the dirty
check only recognised the dirty state. `--allow-dirty` is the explicit way
through both.

Useful flags: `--only config,packages,tests,source`, `--no-source`, `--json`.

`--no-source` and `--only` turn off the rewrites, not the reports: a call to a
`node:` member Bun lacks throws on the first run, so the gap warning is recorded
even for a layer that was not requested. Measured before this split, `--only
config,packages` silenced the warning along with the rewrites and exited 0.

A bad flag is a usage error, not an empty run: `--only bogus`, `--only` with no
value, `--root` with no value and an unknown `--flag` all exit `2` with a message
naming the problem. A positional argument out of place is the same class of
error — measured, `bun cli.mjs --json revert journal.json` consumed `revert` as
an option value, ran `scan` on the working directory, and exited 0 without
reading the journal. The command must come first, and only `revert` takes a
positional. An unknown command is rejected the same way instead of falling back
to `scan`, `--help` is parsed wherever it appears, and `revert` without a journal
path is a usage error rather than a stack trace.

## The journal

Every `apply` writes two files under `.bun-migrate/`:

- `journal-<stamp>.json` — machine readable, what `revert` consumes
- `journal-<stamp>.md` — a readable summary with a diff per file and, for a
  source rewrite, the pairing and the condition that justified it

A diff longer than `DIFF_LINE_LIMIT` (40) lines is truncated, and the entry says so
with the full line count and a pointer to the `.json`. It used to cut silently,
which meant a journal could look complete while the change it was supposed to
justify was outside the visible window.

The journal is not optional bookkeeping. An automatic rewrite whose justification
is not recorded cannot be reviewed later, which defeats the point of automating it.

The journal is written **before** any change is applied, and each file is written
through a temp sibling and renamed into place. A crash during the write phase
therefore leaves a journal that can restore what was written; the previous order
applied the changes first, so a failure there left no record of how to undo them.

### Credentials in a removed `.npmrc`

The `.json` journal records removed files byte-for-byte so `revert` can restore
them. When the removed file is `.npmrc` and `.bun-migrate/` is not git-ignored,
`apply` prints a warning naming the file and the ignore entry to add. The markdown
summary never includes removed-file content; the machine-readable journal must,
because restoring the file is the point.

### Removal preserves what `revert` cannot bring back

A journal `remove` entry records the file's bytes, so restoring that file was never
the problem. The index was. The first version ran `git rm --force`, and with an edit
staged in the index — the state a user is in after `git add .` mid-refactor —
`--force` deletes the staged blob along with the worktree copy. Measured: after the
removal, `git show :pnpm-lock.yaml` reported _"neither on disk nor in the index"_,
and the content was reachable only as an unreachable blob no command pointed at. So
`--allow-dirty`, the flag that exists so a reviewer can inspect an in-progress
change, was turning a recoverable state into an unrecoverable one.

Removal now runs `git rm --ignore-unmatch` **without** `--force`, and unlinks the
worktree file when git refuses. Three states, each measured:

| state                    | `git rm`                      | result                                                                                                     |
| ------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| tracked and clean        | succeeds                      | deletion is staged (`D  pnpm-lock.yaml`)                                                                   |
| staged or unstaged edits | refuses                       | the worktree copy is unlinked, the index entry survives, `git checkout -- <path>` restores the staged text |
| untracked                | `--ignore-unmatch` is a no-op | the file is unlinked                                                                                       |

`revert` restores the bytes from the journal in all three cases. The same
guarantee covers what the migration _adds_: a `package.json` entry records the
disk bytes as the `before`, so a file that was not written in
`JSON.stringify(…, null, 2)` shape comes back exactly as it was — measured, a
single-line manifest used to revert to five lines and still show as modified. A
file the migration created (the timeout preload, a first `bunfig.toml`) is
removed by `revert` rather than skipped, with the same staged-edit protection:
an edit the user staged on top of a generated file survives in the index, and
`git checkout -- <path>` brings it back.

`revert` also re-stages a tracked file whose deletion the migration staged, so
undoing a clean removal does not leave a staged `D` plus an untracked file. A
journal entry whose path resolves outside the project root is refused with a
message instead of being written.

## Per-project exceptions

`.bun-migrate.toml` in the target project:

```toml
deny = ["packages/browser-safe", "apps/extension"]   # never write Bun.* here
auto-source = false                                   # skip the source layer
portable = true                                       # only apply rewrites that still run on Node
```

Packages that must run outside Bun (browser code, extension hosts) go in `deny`.
Every automatic rewrite layer enforces the list: `node:` calls, npm package
replacements, `vitest`/`jest` imports, and vitest config porting. Without an
entry, the tool assumes the package is Bun-hosted.

### `portable = true` stops every Bun-only rewrite

An `auto-applied` source rewrite replaces a `node:` call with a `Bun` global. That
is faster on Bun and is a **one-way door**: `new Bun.CryptoHasher('sha256')`
throws `ReferenceError: Bun is not defined` under Node, so a library that also
ships to Node stops working there. The npm package replacements and `bun:test`
imports are Bun-only for the same reason: `Bun.YAML` is undefined under Node and
Node cannot run a `bun:test` import.

All ten auto-applied source rules currently emit a `Bun.*` expression, so
`portable = true` leaves **zero** source rewrites to apply. It does not select a
portable subset — there is no such subset to select today. Package replacements,
test-runner imports and vitest config porting are declined for the same reason.
What it does is make the choice explicit and visible: instead of silently emitting
Bun-only code, the journal records why each rule was declined.

`portable` does not turn off the package-manager scaffolding — `.npmrc` to
`bunfig.toml`, workspaces, lockfile removal. Those describe the project's package
manager, not the runtime its code has to keep working on. If you need the whole
project to stay on Node, do not run `apply`; the `source` and `tests` layers with
`portable = true` are the two that rewrite code.

```toml
portable = true
```

```
[source] 0 change(s), 1 skipped
  crypto-createHash: keeps only on Bun (Bun.CryptoHasher); skipped because portable = true
```

The trade is stated rather than hidden: the file keeps working on both runtimes
and the speed gain is not taken. Without the flag the default is unchanged and the
rewrite is applied, so a project that ships to Node has to set it.

**If you need both runtimes and also want the speed**, the answer today is not a
config flag: leave `source` enabled, run it, and then review the diff — a call
that has a portable equivalent (`Bun.stripANSI` has none, but a `Buffer` encoding
change does) can be written by hand. The tool does not offer a per-rule override.

### `deny` adds to the built-in list; it does not replace it

`.bun-migrate.toml`'s `deny` is appended to a built-in list of packages that must
keep running outside Bun (`packages/pi-tui`, `packages/transcript`,
`packages/i18n-shared`, `apps/vscode`, `apps/vis`). Writing your own list does not
remove that protection — measured before this was fixed, `deny = ["packages/mine"]`
caused the tool to write `Bun.gzipSync` into `packages/transcript`. The list used
to be honoured by the source layer alone; the package, test and vitest-config
layers now consult it too.

`deny = []` is therefore not "deny nothing"; the built-in entries still apply. For
a third-party project those paths will not exist, so the list costs nothing.

## What "one command" does and does not cover

`apply` is one command, but it is not a complete port, and the difference is
worth stating because a migration that leaves a broken project is worse than one
that says what it left out.

**What `apply` does end to end, verified by running the result:**

- rewrites `.npmrc` into `bunfig.toml`, drops `.nvmrc`, sets `packageManager`,
  and **reports every `.npmrc` key it does not map** before deleting the file —
  a registry auth token or a proxy line is named in the journal instead of
  vanishing with the file. Quoted values are parsed before they are written, and
  the merged `bunfig.toml` is parsed back with `Bun.TOML`; if it would be invalid,
  the merge is refused and `.npmrc` is left in place
- merges into an existing `bunfig.toml` instead of appending a second `[install]`
  table, which TOML rejects with `Cannot redefine table 'install'`
- rewrites `pnpm`/`npm`/`npx` invocations and the **test-runner invocation** in
  the root **and every workspace member's** `package.json` scripts, so
  `vitest run` becomes `bun test` rather than a script that fails after the
  imports moved. A bare `pnpm <script>` / `npm <script>` call is rewritten too —
  `pnpm build` becomes `bun run build`, `npm test` becomes `bun run test` —
  because the CI layer deletes the step that provides the package manager.
  Package-manager operations (`npm publish`, `pnpm publish`, `npm ci`, …) are not
  mistaken for scripts. A `pnpm vitest run` in a script or workflow is claimed by
  the runner table before the bare-script rule can misread it as a script named
  "vitest". Only directories matched by the workspace globs are touched, so
  package.json files under test fixtures keep their contents
- **parses `pnpm-workspace.yaml` as YAML**: globs keep their meaning when a line
  has a trailing comment, the catalog is moved into `workspaces.catalog`, and any
  top-level key it does not translate (`onlyBuiltDependencies`, `hooks`,
  `peerDependencyRules`, overrides, patches) is named in the journal. The file is
  left in place whenever something in it was not translated, instead of being
  deleted while its contents are lost
- **mirrors package `imports` into tsconfig `paths`**: Bun 1.4.4 (commit
  `38afee6c8`) rejects a specifier that is exactly `#` or starts with `#/` before
  it consults the imports map (`src/resolver/resolver.rs:5052`), matching Node
  24's ESM rule. Node 26.8 and Vite resolve `#/foo` through a `#/*` entry, and
  the official project relies on that bundler resolution. Bun checks tsconfig
  `paths` before package imports (around `resolver.rs:2567` versus the
  package-imports branch at `:2609`), so copying each package's `imports` map
  into its `compilerOptions.paths` (comments preserved) makes the same source
  resolve under Bun; a nested package boundary with no tsconfig gets one. This is
  a Node version/spec bridge, not a code rewrite: the `#/` specifiers stay as
  they are
- **carries `vitest.config.ts` forward instead of deleting it**: `setupFiles`
  becomes `[test] preload` and a `coverage` block becomes `coverage = true` in
  `bunfig.toml`, and whatever cannot be ported (`environment: jsdom`,
  `resolve.alias`, `globals`) is named in the removal reason rather than dropped
  silently. Settings the tool does not know, and values that are computed rather
  than literal, are named the same way instead of disappearing with the file
- rewrites `vitest`/`jest` imports to `bun:test`, and **leaves the whole file
  alone** when it cannot do so safely — a default import, a `type`-only import, a
  namespace import, a CommonJS `require`, or a
  `vi.spyOn`/`vi.mock`/`vi.useFakeTimers` call all produce a file Bun cannot run,
  so those are reported instead of half-rewritten. A file whose only import is
  `vi` and whose only calls are `vi.fn()` keeps working: the rewrite removes the
  import, changes the calls to `mock()`, and adds `mock` to the `bun:test` import
- rewrites `await expect(promise).resolves.not.toThrow()` (and `toThrowError`)
  to `await promise` when it is an awaited expression statement. Vitest passes
  the resolved value through; `bun:test` treats it as the value that threw. Other
  forms of the assertion are reported and the file is left alone, because a
  promise that resolves to a function would have been invoked by Vitest
- **detects the snapshot forms a runner switch would silently change** and refuses
  the file. A `describe`-scoped `toMatchSnapshot`, a hinted `toMatchSnapshot`,
  `toThrowErrorMatchingSnapshot`, `toMatchFileSnapshot` and
  `expect.addSnapshotSerializer` each break differently under `bun:test`; see
  [Snapshots](#snapshots-are-a-blocker-not-a-rewrite) for the measurements
- rewrites `node:` calls only where a pairing's `check` proved the condition,
  through **either an `import` binding or a `require(...)` declaration**, and
  **refuses a call site whose name a local declaration shadows** — a file with
  `const gzipSync = fn` inside a function reaches the parameter through that
  call, and a rewrite that ignored the shadow would change which function the
  call reaches while the diff looked like a pure rename. A shadowed name with
  no pairing (a `resolve` shadowed by a Promise executor) is ordinary code and
  reports nothing
- **removes the `node:` binding the rewrite made dead** — an unused named import
  keeps the builtin in the module graph and misleads the diff, and the same is
  true of `const { createHash } = require('node:crypto')` left above code that no
  longer calls it
- **removes the npm import a package rewrite made dead**, including a wrapped
  clause, and keeps a default binding that sits beside the removed one. A call
  whose name is shadowed by a local declaration is refused, exactly as in the
  source layer, and a namespace import (`import * as yaml`) is reported instead of
  being left silently alone
- **rewrites the CI workflow**: drops `pnpm/action-setup` and `actions/setup-node`
  with their own `with:` blocks and adds `oven-sh/setup-bun` to **every job that
  lost one of them** — keeping an existing setup-bun step verbatim, version pin
  included, instead of loosening a `bun-version: 1.2.3` pin back to `latest` — and
  runs every `run:` line, including the body of a `run: |` block, through the same
  script rewrite that `package.json` gets
- **carries `testTimeout`/`hookTimeout` into a generated preload when the project
  has a single test configuration**, and appends `--parallel=N` for `maxWorkers`,
  rather than reporting both as unportable. A monorepo with several configs has
  one value per package, which a single root `preload` cannot represent; those
  values are reported instead of collapsing them into one deadline — see
  [Timeouts and workers](#timeouts-and-workers-have-no-bunfig-key)

**What it does not do, and does not pretend to:**

- It does not install dependencies or convert the lockfile. It prints the
  `bun install --lockfile-only` step and stops there.
- It does not remove a package from `package.json` after rewriting its last
  importer. It emits a note asking for confirmation, because whether the package
  is still needed is a judgement the tool cannot make.
- It does not port a test that depends on runner-internal behaviour. Fake timers
  and module mocking are reported; incompatible snapshots refuse the whole file.
- It does not make a `Bun.*` rewrite reversible. Use `portable = true` before
  applying, not after.
- It does not rewrite `require('node:...')` into `import`. It rewrites the _call_
  a `require` binding reaches and removes the binding once nothing uses it, but the
  statement stays CommonJS, because converting module syntax is a different change
  with different failure modes.
- It does not convert a vitest `pool` or `minWorkers` setting: Bun's `--parallel`
  is a worker count, not an isolation model, so those stay reported.
- It translates only the awaited `resolves.not.toThrow()` form described above.
  Other Vitest-specific `expect` semantics are not translated; a form the tool
  cannot prove equivalent is reported and the file is left on its current runner.

### Snapshots are a blocker, not a rewrite

`bun:test` has snapshots, so the first version of this tool treated them as
compatible and rewrote the runner import. That was wrong in a way that made a
suite greener without making it correct. Each row below was measured on Bun 1.4.4
against a vitest-written snapshot file:

| form                                | vitest                        | Bun                       | what the user sees                                                                                                                                                                          |
| ----------------------------------- | ----------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toMatchSnapshot` inside `describe` | key `outer > inner > works 1` | key `outer inner works 1` | the stored entry is not found, Bun **appends a new one and passes**. Measured: the asserted value was changed to `"TOTALLY-DIFFERENT"` and the test still passed with `snapshots: +1 added` |
| `toMatchSnapshot(hint)`             | key `name: hint 1`            | key `name hint 1`         | same absence, same silent append                                                                                                                                                            |
| `toThrowErrorMatchingSnapshot`      | stores `[Error: boom]`        | compares against `"boom"` | the test fails even though nothing changed                                                                                                                                                  |
| `toMatchFileSnapshot`               | exists                        | **not a function**        | `TypeError: toMatchFileSnapshot is not a function`                                                                                                                                          |
| `expect.addSnapshotSerializer`      | exists                        | throws `Not implemented`  | the file cannot run at all                                                                                                                                                                  |

The `describe` case is the dangerous one, because the same file passes locally and
fails in CI: Bun refuses to create snapshots when `CI` is set
(`Snapshot creation is disabled in CI environments unless --update-snapshots is
used`). A migration that produced that would look clean on the machine that ran it
and break the first pipeline.

`toMatchSnapshot` and `toMatchInlineSnapshot` outside a `describe`, with no hint,
are compatible in both directions and still migrate — measured, an inline snapshot
vitest wrote is read by Bun unchanged.

### Timeouts and workers have no bunfig key

`portVitestConfig` used to report `testTimeout`, `hookTimeout`, `pool` and
`maxWorkers` in one sentence: "set them per test or with `--timeout`". Two of those
have a verified mechanism, and losing them changes how a suite behaves without
saying so:

| setting              | measured in bunfig                                                       | what actually works                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `testTimeout`        | `[test] timeout = 50` is accepted and a 300 ms test still passes         | `setDefaultTimeout(100)` from `bun:test`, loaded through `[test] preload` — a 400 ms test fails with "this test timed out after 100ms" |
| `hookTimeout`        | same                                                                     | the same `setDefaultTimeout`, which also covers hooks: a slow `beforeEach` fails with "a beforeEach/afterEach hook timed out"          |
| `maxWorkers`         | `[test] parallel = 4` is accepted and four 500 ms files still take 2.2 s | `bun test --parallel=4`, which took 1.0 s on the same four files                                                                       |
| `pool`, `minWorkers` | no equivalent                                                            | reported, because `--parallel` is a worker count rather than an isolation model                                                        |

The migration writes `bun-migrate.timeout.ts` next to `bunfig.toml`, adds it to
`preload` (keeping any existing `setupFiles` entry), and appends `--parallel=N` to
every `bun test` script. `testTimeout` and `hookTimeout` are only carried when they
agree, because Bun has one default for both; when they disagree the file says so
instead of picking one.

**Across packages, no timeout is chosen at all.** A monorepo assigns a deadline per
package config (the official repository has 15 s and 30 s configs, and packages
with no config use the runner default). A single root `preload` has one
`setDefaultTimeout` for the whole process, so applying either value would impose
one package's deadline on every other. Picking the maximum only hides slow work in
the packages that chose a shorter deadline. The tool therefore writes the timeout
only when exactly one test config declares one; with several configs every value is
named in the journal and no global timeout is set. Configure it per package (or
keep Bun's default) rather than accepting an arbitrary global deadline.

Two things about the `preload` write are worth stating, because both were broken
and both were silent:

- **Every config contributes.** `preload` is a single array key, so two ported
  configs cannot each write their own line — the last one won. Each config's setup
  files are collected and written once, deduplicated, with paths rebased onto the
  root; a package's `test/setup.ts` is written as `./packages/x/test/setup.ts`,
  not as a root path that does not exist.
- **An existing list is preserved.** Measured, a project whose `bunfig.toml`
  already said `preload = ["./my-own-setup.ts"]` came out as
  `preload = ["./bun-migrate.timeout.ts"]`, dropping its own setup file. Existing
  entries are merged in front, so their order stays the project's.

A wrapped array (`preload = [` across lines) is a single value, and replacing only
its first line left the tail behind as orphan text that `Bun.TOML.parse` rejects. The
continuation is now consumed as part of the value, and every case is parsed back in
`silent-failures.test.mjs` rather than compared as a string.

The measured end-to-end result on a purpose-built Node project (ESM, `vitest`,
`node:crypto`, `node:fs`, `node:path`): `apply` succeeds, `bun run test` runs the
migrated suite, and `0` of the remaining test failures are caused by the
migration. That last number is checked by running the same test under Node before
the migration, which is the only way to separate "the migration broke it" from
"it was already broken".

## How long the migration itself takes

A migration tool that takes minutes on a real repo is a tool people run once and
then avoid. Measured on this machine (Windows x64, warm cache), `scan` — the
read-only pass — against a synthetic project of small ESM modules, median of three:

| files | total    | per file |
| ----- | -------- | -------- |
| 100   | 270 ms   | 2.70 ms  |
| 500   | 489 ms   | 0.98 ms  |
| 1 000 | 688 ms   | 0.69 ms  |
| 2 000 | 1 146 ms | 0.57 ms  |
| 5 000 | 2 529 ms | 0.51 ms  |

The per-file cost falls toward 0.5 ms because roughly 200 ms of every run is
process start-up and module loading, which is the dominant term only for tiny
projects. The growth from 1 000 to 5 000 files is 3.7x for 5x the input, so the
scan is close to linear with no accidental quadratic behaviour.

This is `scan`. `apply` additionally writes every changed file and a journal, and
those are the only extra costs.

## Validated on the official Node repository

Checked against `@moonshot-ai/kimi-code@2.4.1` — the official Node/pnpm release,
not a synthetic fixture — with Node 26.8.2 and pnpm 10.33.0:

- `packages/migration-legacy` before migration: **265 passed / 1 skipped**
- after `apply` and `bun test` on Bun 1.4.4: **265 passed / 1 skipped / 0 failed**

The migrated run exercises the tsconfig `paths` generated for `#/*` (16 workspace
packages plus the nested `src/human` boundary), per-member `bun test` scripts, and
the awaited `resolves.not.toThrow()` rewrite. The 16 vitest configs declare 15 s and
30 s deadlines; those are reported per package and **no global timeout is
generated**, so the package suite runs on Bun's default rather than an arbitrary
merged deadline. The full upstream suite was not run end to end: it is large, and
`packages/acp-server` already had two failures on the test machine before
migration, so this package is the pinned before/after comparison.

## Coverage, stated plainly

39 rules across four tables. That is a fraction of what Bun offers, so here is
the honest shape of it.

| table                                     | rules | auto-applied |
| ----------------------------------------- | ----- | ------------ |
| `node:` builtins                          | 23    | 10           |
| npm packages                              | 13    | 7            |
| module-level (`node:sqlite`, `node:http`) | 2     | 0            |
| capability-level (`sharp`)                | 1     | 0            |

Bun exposes 112 top-level members; 25 are referenced by a rule. The rest fall
into two groups, and only one of them is a gap:

- **No Node counterpart exists.** `Bun.S3Client`, `Bun.redis`, `Bun.sql`,
  `Bun.FFI`, `Bun.Terminal`, `Bun.WebView`, `Bun.Archive`, `Bun.cron`,
  `Bun.secrets`, `Bun.Transpiler`, `Bun.build`, `Bun.listen`, `Bun.connect`.
  There is nothing to migrate _from_, so a rule would have no source pattern.
  These are new capabilities, not replacements.
- **A counterpart exists and is not covered yet.** `Bun.openInEditor`, `Bun.peek`,
  `Bun.deepMatch`, `Bun.randomUUIDv7`, `Bun.hash`/`Bun.sha`, `Bun.escapeHTML`
  (covered as a package rule against `escape-html` and `he`, not as a `node:`
  rule), `Bun.serve` (covered as a module entry, not automatic).

The second list is where further work would go. Each addition needs the same
treatment as the existing entries: a verified differential, a stated condition,
and a measured or behavioural reason to prefer the Bun side.

## The failure mode that reports nothing

A missing export throws, and a throw is visible. Worse is an API that is present,
accepts its arguments, returns something plausible, and does nothing. Measured on
Bun 1.4.4, none of these throw:

| API                                 | what actually happens                                         |
| ----------------------------------- | ------------------------------------------------------------- |
| `async_hooks#createHook`            | `enable()` succeeds, callbacks **never fire**                 |
| `async_hooks#executionAsyncId`      | always `0`, so id-based correlation collapses into one bucket |
| `worker_threads#resourceLimits`     | accepted and ignored; the memory cap is never enforced        |
| `perf_hooks#eventLoopUtilization`   | always `{ idle: 0, active: 0, utilization: 0 }`               |
| `perf_hooks#performance.nodeTiming` | placeholder values, not real startup timings                  |
| `process#_getActiveHandles`         | always `[]`, even with a live timer                           |
| `bun:sqlite` wide integer           | `9007199254740993` reads back as `9007199254740992`, no error |
| `bun:sqlite` empty `get()`          | `null` where `node:sqlite` returns `undefined`                |

The consequence is specific: tracing, leak detection and saturation alarms built
on these instruments report "all clear" forever. Nothing in a log says the
instrument is not connected.

`src/silent-gaps.mjs` carries each entry with its impact, a workaround, and a
live probe. `bun tools/bun-migrate/src/rules-report.mjs` prints what was observed
on the running Bun rather than restating the table, so a fixed behaviour shows up
as a changed observation instead of a stale claim.

One entry is honest about its limits: `resourceLimits` is a documentation
cross-check, not a live spawn, and the entry says so.

## Constants with the same name and a different value

The quietest class of all. The key exists, the type matches, and the number is
wrong. `src/enumerate-constants.mjs` reads the values, not just the names, and
`src/compare-constants.mjs` diffs them:

```
value differs    17
kind differs      0
missing          13     the non-enumerable http2 constants
extra            19
```

Seventeen numeric mismatches, curated to four rows a caller can be hurt by:

| constant                                  | Node               | Bun          | why it matters                                                                |
| ----------------------------------------- | ------------------ | ------------ | ----------------------------------------------------------------------------- |
| `buffer.constants.MAX_LENGTH`             | `9007199254740991` | `4294967296` | a size guard accepts 8 PB on one runtime and 4 GB on the other                |
| `buffer.constants.MAX_STRING_LENGTH`      | `536870888`        | `2147483647` | a string-length guard changes threshold silently                              |
| `crypto.constants.OPENSSL_VERSION_NUMBER` | `810549311`        | `269488255`  | Bun is BoringSSL, so a version branch answers differently                     |
| `crypto.constants.SSL_OP_*` (14 flags)    | non-zero masks     | **all 0**    | `options \|= SSL_OP_NO_RENEGOTIATION` configures nothing and looks configured |

The `SSL_OP_*` row is the dangerous one: the OR succeeds, the options word stays
`0`, and the TLS behaviour you asked for never happens. No error, no warning.

## Function signatures: mostly noise, eight real cases

The fourth class. `fn.length` is the number of declared parameters before the
first default or rest, and code that branches on arity — curry helpers, argument
validators, `util.promisify` — takes a different path when it moves.

The raw diff is large: **123 arity differences** across 38 modules. Most of them
are not compatibility problems. Bun implements `fs.promises` as
`async function (...args)` forwarding to the callback implementation, so the
declared arity describes the wrapper rather than the API:

```js
// Bun's node:fs/promises readdir
async function(...args) {
  return fn.@apply(fs, args);
}
```

Measured: `fsp.readdir` called normally returns the expected entries, `readdir`
with `promisify` works, and the rest-argument wrapper absorbs any argument count.
So the difference is invisible unless something reads `.length`.

Eight entries do feed a decision, and they are recorded with both measured values:

| member                   | Node     | Bun | why it matters                                                    |
| ------------------------ | -------- | --- | ----------------------------------------------------------------- |
| `crypto.scrypt`          | 4 params | 5   | `promisify(crypto.scrypt)` produces a differently-shaped function |
| `crypto.scryptSync`      | 3        | 4   | a curry helper binds the wrong number of arguments                |
| `crypto.randomInt`       | 3        | 2   | the `(min, max, callback)` form loses a declared parameter        |
| `crypto.timingSafeEqual` | 0        | 2   | a forwarding wrapper passes arguments Node read from `arguments`  |
| `crypto.verify`          | 5        | 4   | positional forwarding drops the last argument                     |
| `crypto.hash`            | 3        | 2   | the `outputEncoding` parameter is no longer declared              |
| `fs/promises.open`       | 3        | 1   | rest wrapper collapses the arity to one                           |
| `fs/promises.opendir`    | 3        | 2   | same rest wrapper                                                 |

The negative result is the useful part: `SIGNATURE_DIFF_SUMMARY` records how the
123 split (95 where Bun declares more, 42 where Node declares none, 41 where Node
declares more) and why, so the table stays small without pretending the rest does
not exist.

## Error shapes: thirty cases, five confirmed divergences

The dimension every `try/catch` depends on. A catch block branches on the
constructor, the `.code`, `.errno`, `.syscall`, the `.name`, or whether something
threw at all — and a migration that moves any of them sends the catch down a
different path without a compile error.

Thirty cases run on both runtimes, synchronous and asynchronous:

```
fs         ENOENT, EISDIR, bad flag, error.path shape
crypto     unknown algorithm, range errors, length mismatch
json       SyntaxError
sqlite     bad SQL
url        invalid URL
buffer     unknown encoding
assert     AssertionError
child_proc missing binary, spawnSync result keys
stream     write after end (sync and event form)
promises   readFile, stat, readdir, realpath, mkdir, aborted read
dns        unresolvable host
zlib       non-gzip input
net        occupied port
```

**Twenty-five agree; five do not**, and the divergences are recorded with what
breaks and what to do instead:

| observable                                      | Node              | Bun                            | breaks                                                                                |
| ----------------------------------------------- | ----------------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| `err.constructor.name` for an aborted `fs` read | `AbortError`      | `Error`, with only `.name` set | `instanceof AbortError` and `constructor.name === 'AbortError'` are both false on Bun |
| `err.name` / `err.errno` for a failed lookup    | `Error` / `-3008` | `DNSException` / `4`           | a catch branching on `name`, any errno→symbol map                                     |
| `err.errno` for `EADDRINUSE`                    | `-4091`           | `10048` (raw Windows WSA)      | code switching on errno numerically                                                   |
| `err.path` for a relative path                  | resolved absolute | verbatim as passed             | a retry that re-reads `err.path` resolves a different file                            |
| `Object.keys(spawnSync())` order                | `error` first     | `signal` first                 | only key-order serialisation; the key set is identical                                |

The `AbortError` row is the one to act on: branch on
`err.name === 'AbortError' || err.code === 'ABORT_ERR'`, never on the class.

Message text is recorded but not compared, because Node and Bun phrase messages
differently without that being a compatibility problem.

`ERROR_GAPS` is asserted in two directions — the table must describe each gap, and
a live run must still reproduce it. A gap that silently heals fails the suite
rather than rotting in the table.

### Two corrections this produced

- An earlier version of this section said "all seventeen agree". It was written
  when the table had seventeen synchronous cases; the asynchronous half was added
  later and found all five divergences above. The heading said "clean" for as long
  as the probing was shallow.
- An earlier note claimed `node:sqlite` reports `SQLITE_ERROR` while Bun reports
  `ERR_SQLITE_ERROR`. Measured again: `bun:sqlite` reports `SQLITE_ERROR` and
  `node:sqlite` reports `ERR_SQLITE_ERROR`, including when `node:sqlite` runs
  inside Bun. The table in the module section is right; a later "correction" that
  said both report `ERR_SQLITE_ERROR` was wrong and is removed.

The lesson from both: a probe that reports a difference may be describing itself,
and a probe that reports agreement may be describing too little.

## The Bun-only surface, classified

The inverse question a shared package needs: _if I write `Bun.X`, does my package
still run on Node?_ `src/bun-surface.mjs` answers it in three tables covering all
112 top-level Bun exports, and a test fails if any export is unclassified.

| table                 | count | meaning                                                                  |
| --------------------- | ----- | ------------------------------------------------------------------------ |
| `HAS_NODE_EQUIVALENT` | 30    | a Node path exists today; 21 of them are unconditional, 9 carry a caveat |
| `BUN_ONLY_FUNCTIONS`  | 60    | no Node API does this                                                    |
| `BUN_ONLY_NAMESPACES` | 22    | object namespaces with no Node shape                                     |

30 + 60 + 22 = 112, which is every top-level `Bun` export.

`dependencySafety('Bun.CryptoHasher')` returns `{ safe: true }` because the
digests match. `dependencySafety('Bun.gzipSync')` returns `{ safe: false,
conditional: true }` — the output decodes in both runtimes but is not
byte-identical, so a checksum over compressed bytes differs.
`dependencySafety('Bun.pathToFileURL')` returns `{ safe: false, conditional: true
}` because Windows drive-letter resolution differs. `dependencySafety('Bun.serve')`
returns `{ safe: false }`. An unknown name returns
`{ safe: false, unknown: true }` rather than pretending to be safe.

The condition is an explicit `caveat` field on the entry. An earlier version
derived it from `note.includes('differs')`, which is a string match standing in
for a semantic: it reported `Bun.gzipSync` as safe because its note was phrased
"not to a stream produced by Node" rather than using the word "differs".

The Bun-only list is grouped by capability, so the answer is actionable:
`database` (`Bun.SQL`, `Bun.postgres`, `Bun.RedisClient`), `server` (`Bun.serve`),
`socket` (`Bun.listen`, `Bun.connect`), `bundler` (`Bun.build`), `archive`
(`Bun.Archive`), `image` (`Bun.Image`), `pty` (`Bun.Terminal`), `webview`
(`Bun.WebView`), `scheduler` (`Bun.cron`), `native` (`Bun.FFI`), and the text
helpers (`Bun.stringWidth`, `Bun.sliceAnsi`, `Bun.wrapAnsi`).

## The risk that runs the other way

Everything above asks "can this call move to a faster Bun API". There is a second
question, and getting it wrong fails at run time rather than at build time:
**after moving to Bun, does every `node:` member the source uses still exist?**

That question is answered from data, not memory. `src/enumerate-node.mjs`
enumerates every export of 55 `node:` modules on both runtimes, descending into
the nested constant bags (`constants`, `types`, `posix`, `win32`), and
`src/compare-node-surface.mjs` diffs the two reports. Running it against
Node 24.9.0 and Bun 1.4.4 gives:

```
module load gaps                 0
missing in Bun                 102     of which 17 are public functions
missing nested members          13     all in node:http2 constants
type mismatches                  1     a private member (_debug)
extra in Bun                    82
extra nested members in Bun     59
```

A finding worth keeping: the 13 http2 constants are **non-enumerable on Node**, so
`Object.keys()` shows 240 on both sides and the difference disappears. They are
genuinely absent on Bun (`constants.NGHTTP2_HCAT_REQUEST` is `undefined`), and a
key-by-key listing is the only way to see it. That is why the enumerator uses
`getOwnPropertyNames` and records nested bags instead of comparing flat key sets.

The 98 top-level misses break down as 3 uppercase constants, 15 private members
(`_` prefix or `prototype`), and 80 public members of which 17 are functions and
the rest are the ZSTD_* constant block that `node:zlib` exports and Bun does not.

The 17 functions are the ones that matter, and each has a workaround recorded:

| module         | members                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `node:module`  | `registerHooks`, `stripTypeScriptTypes`, `findPackageJSON`, `getSourceMapsSupport`, `setSourceMapsSupport`                |
| `node:util`    | `transferableAbortController`, `transferableAbortSignal`, `diff`, `getCallSite`                                           |
| `node:console` | `context`, `createTask`                                                                                                   |
| `node:crypto`  | `encapsulate`, `decapsulate`                                                                                              |
| `node:dns`     | `resolveTlsa`                                                                                                             |
| `node:domain`  | `Domain`                                                                                                                  |
| `node:http2`   | `constants.NGHTTP2_HCAT_*`, `constants.NGHTTP2_NV_FLAG_*`, `constants.NGHTTP2_ERR_*` (7), `constants.STREAM_OPTION_*` (2) |
| `node:v8`      | `queryObjects`                                                                                                            |

A missing export does not fail the build. It fails the first time that line runs,
so a migration can look green and still break in production.

The probe runs live and `test/node-surface.test.mjs` re-enumerates both runtimes
on every run: a gap that appears without an entry fails the suite, and a gap that
Bun closes prints a note telling you to retire the entry. That is why
`async_hooks#createHook` left this table — it exists on Bun, it just never fires,
which makes it a silent-degradation entry rather than a missing one.

The inverse list is there too. `BUN_ONLY_APIS` names the APIs with no Node
counterpart (`Bun.file`, `Bun.SQL`, `Bun.serve`, `Bun.YAML`, `Bun.FFI`, …), so a
package shared between both runtimes knows what it cannot use.

## What it deliberately does not do

- `node:fs`, `node:path`, `node:child_process` and friends stay as they are.
  Bun implements them natively, and its own docs point at `node:fs` for
  `mkdir`/`readdir`. Rewriting working code to a different API is churn.
- `readFileSync` and other synchronous reads are reported, never rewritten:
  `Bun.file()` is lazy, so the timing at a sync call site would change.
- `test.each` and `vi.mock(module)` are reported, not rewritten — both need a
  control-flow change that a text tool should not attempt.
- `pnpm` catalogs, overrides and `patchedDependencies` are reported, not
  translated: Bun's shape for them differs enough that guessing would produce a
  workspace that resolves differently.

## Tests

```
bun test --isolate tools/bun-migrate/test/
```

Twenty-five suites, each covering a different failure mode:

| file                           | what it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit.test.mjs`                | rule-table invariants: no rule claims a rewrite without a Bun target, every rule states a condition, no duplicate module/export pair                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `edge-cases.test.mjs`          | shadowed names (a local `const`, a parameter, a require of another module with the same binding name), aliased imports, two builtins from one module, computed arguments, options objects the rewrite must refuse, the five snapshot forms that must block a file, each `require` binding shape, tests-layer namespace/`vi`-only/CommonJS shapes, the awaited `resolves.not.toThrow()` rewrite (including a migrated file Bun runs) and the un-awaited form left for manual porting, `portable` and `deny` for the tests layer, plus TS syntax the parser must survive                                                                                                                                      |
| `differential.test.mjs`        | one worked example per rule — and a coverage assertion that fails if any pairing in the table has no case, so a rule added later cannot go untested                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `properties.test.mjs`          | many generated inputs per rule — hashes across 5 algorithms x 4 encodings x 7 payload shapes, HMAC across keys and payloads, gzip and raw deflate across sizes, ANSI across escape sequences, deep equality across 14 structure pairs                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `silent-failures.test.mjs`     | the layers that used to fail quietly: a bad `--only` or unknown command exits 2, `--help` is parsed, `vitest.config.ts` is ported into `bunfig.toml` instead of deleted and unknown/computed settings are named, per-package `setupFiles` are rebased onto the root preload and per-package timeouts are reported instead of collapsed into one deadline, package `imports` are mirrored into tsconfig `paths` (including nested package boundaries), every workspace member's scripts are rewritten while a non-member fixture is left alone, node-gap detection resolves a binding (including nested `constants.*`) instead of matching text, the CI workflow layer actually runs per job, rewrites `run: | `bodies, survives CRLF and keeps each step's own`with:`block,`testTimeout`is migrated for a single config and reported per package otherwise,`maxWorkers`becomes`--parallel`, a quoted or unmapped `.npmrc`key is handled without producing an invalid bunfig, and a bare`pnpm`/`npm` script call is rewritten rather than orphaned |
| `package-replacement.test.mjs` | npm dependency removal: binding collection, per-member safety, shared imports keeping their unrewritten members, removal of a single-line _and_ a wrapped import clause, shadowed and namespace imports refused, `portable`/`deny` honoured, `which.sync` executed against `Bun.which`, and a rewritten file that Bun actually executes end to end                                                                                                                                                                                                                                                                                                                                                          |
| `modules.test.mjs`             | `node:sqlite` and `node:http` divergences reproduce: empty `get()`, silent integer rounding, error-code shape, and `Bun.serve`'s Request/Response model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `performance.test.mjs`         | the direction of every speed claim, so a rule cannot silently stop being faster                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `project.test.mjs`             | whole-project behaviour: config, packages, tests and source layers together, plus `revert` restoring the original, deny-list and `auto-source` handling across layers, `portable` across package/test/source rewrites, a broken nested manifest, and the credential warning                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `error-shapes.test.mjs`        | 30 error cases on both runtimes, synchronous and asynchronous; 25 agree and 5 divergences are recorded with what breaks, and the comparison is tested against synthetic regressions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `bun-surface.test.mjs`         | all 112 Bun exports classified; every Node-equivalent claim reproduced live                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `signature-gaps.test.mjs`      | arity differences: 123 raw, 8 that feed a decision, plus proof the rest do not affect calling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `constant-values.test.mjs`     | same name, different number: buffer limits, zero-valued SSL_OP_* flags, OpenSSL version                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `silent-gaps.test.mjs`         | APIs that accept input and do nothing: createHook never fires, loop utilization is always zero, wide integers round                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `node-surface.test.mjs`        | re-enumerates 55 `node:` modules on both runtimes; an unrecorded gap fails, a closed gap prints a retire note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `node-gaps.test.mjs`           | the reverse risk: members Node has and Bun does not, verified by running both, plus the Bun-only API list                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `runtime-truth.test.mjs`       | a report-only rule never means "falls back to Node": every `node:` specifier resolves to Bun native code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `repository.test.mjs`          | runs against this repository: bounded rewrite count, build output and temp dirs skipped, denied packages untouched, working tree unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `revert.test.mjs`              | undo restores what a migration removed, and the three git states removal can meet: clean tracked, staged edits (the index entry must survive), and untracked; plus byte-exact restore of a reformatted manifest, removal of files the migration created, re-staging a clean removal's index entry, and refusing a path outside the project root                                                                                                                                                                                                                                                                                                                                                             |
| `report.test.mjs`              | the journal a human reads: a diff past the line limit is announced as truncated rather than cut silently, short diffs are not, notes and removes do not invent a diff, and every skip reason appears under its layer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `candidates.test.mjs`          | the rules added after probing coverage: zstd kept because the bytes matched and it is faster, `escape-html` kept report-only because one entity differs, `he` refused because all of them do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `capabilities.test.mjs`        | package-level capabilities that depend on an installed package; a missing package reports a skip rather than passing silently                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `portable.test.mjs`            | the end-to-end contract: a migrated project still parses, still runs, and stays runnable under Node when `portable = true`; the package, test and source layers all consult the same flag                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `upstream-shape.test.mjs`      | whole-project regressions found against a real upstream checkout: a package manager left behind, a catalog entry lost, a script Bun cannot resolve                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `self.test.mjs`                | **the suite is Bun-native**: every test imports from `bun:test` and nothing from vitest, jest or `node:test`; no `vi`/`jest` globals in test bodies; the source carries no test-framework coupling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

The `self.test.mjs` check matters more than it looks. A Node-to-Bun migration tool
whose own tests ran on a Node framework could not observe the differences it
exists to find. That suite parses each test file with the TypeScript AST and
reads its real import statements, so a framework name inside a fixture string is
not mistaken for a dependency.

Twelve suites compare two runtimes, and none of them skip when `node` is missing:
they throw, so a machine without Node reports failures instead of a clean run that
proved nothing. That change alone moved one suite from "all green" to
`0 pass / 1 fail` on a PATH with no Node.

The property suite is what caught the real bugs: `Bun.deflateSync` being raw
deflate rather than zlib-wrapped, `Bun.deepEquals` ignoring undefined-valued
keys, and the 200-to-500-byte boundary where raw deflate bytes diverge.
