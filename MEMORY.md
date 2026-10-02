# Project memory — kimi-code fork

## Remote transports (user rule, 2026-10-01)

- **GitHub → SSH.** `origin` = `git@github.com:7723qqq/kimi-code.git`,
  `upstream` = `git@github.com:MoonshotAI/kimi-code.git`.
- **cnb stays as-is (HTTPS).** Do not convert it. It is a separate host; the rule is
  GitHub-specific.
- Why it matters here: **direct `github.com:443` is unreachable from this machine** —
  `git clone https://github.com/...` hangs ~20s then fails. SSH to github works and needs
  no extra env (key is in the default agent). So an HTTPS GitHub URL is not merely
  inelegant, it is broken on this box.
- Consequence: the upstream-v2-delta ratchet can be refreshed with the command the root
  `AGENTS.md` documents — `git fetch upstream main:refs/remotes/upstream/main --force`.
  Push target for everyday work is `origin` (per AGENTS.md, push every commit there).

## Upstream v2 reference checkout (`.tmp/v2-ref-upstream`)

Primary route (works now that `upstream` is SSH):

```sh
git fetch upstream main:refs/remotes/upstream/main --force     # refresh the ref first
sha=$(git rev-parse upstream/main)
ref=.tmp/v2-ref-upstream
[ -d $ref ] || git clone --filter=blob:none --no-checkout --single-branch \
  --branch main https://github.com/MoonshotAI/kimi-code.git $ref   # or borrow objects, below
git -C $ref sparse-checkout set packages/agent-core-v2 packages/kosong packages/transcript packages/minidb packages/oauth
git -C $ref checkout --detach $sha
```

Offline fallback (used 2026-10-01 when HTTPS to github was the only transport tried): `git init`
the dir, point `.git/objects/info/alternates` at the main repo's object store, then
`remote add origin https://github.com/MoonshotAI/kimi-code.git` so `git remote -v` names the
official origin.

It stays a reference only: `.tmp/` is gitignored (`.gitignore:36`) and no glob in the root
`workspaces` field covers it, so it never enters the Bun workspace or any gate. Re-read
`.tmp/v2-ref-upstream` before citing it — it is a checkout, and it drifts.

**Always pass `-C $ref` to every git command in that directory.** A failed `cd .tmp/...` followed by
a bare `git sparse-checkout set ...` runs in the *main* repo instead: it rewrites the main
worktree's sparse cone, and `git sparse-checkout disable` afterwards re-materializes every
index-clean-but-deleted file, silently resurrecting another task's uncommitted deletions
(here 43 deleted test files). Recovery: `git ls-files` the paths, confirm each is unmodified
(`git diff --quiet`), delete them again, then re-check `git diff --stat` against the baseline.

## Clearing `check:normify` (`evidence/fingerprint-drift`)

`bun run check:normify` runs `bun packages/normify/src/cli.ts normify_validate`. Every
`evidence/fingerprint-drift` error is cleared by the normify tool itself — **never** by hand-editing
`normify-kimi-code/tree.json`:

```sh
bun packages/normify/src/cli.ts normify_module_refresh \
  '{"project":"kimi-code","repoRoot":".","ids":["<module>", "<its parent>"]}'
```

Pass the **child and its parent together** (plus any other ancestor whose subtree moved), then
re-run `check:normify` — refreshing only the child leaves the parent's aggregate fingerprint stale
and the gate still red. The 60 `structure/leaf-too-coarse` / `evidence/root-no-source` warnings are
advisory and do not gate. `bun packages/normify/src/cli.ts --list` lists the tool set
(`normify_sync` is read-only: it only prints a rebuild plan).

One bad id in the `ids` array aborts the **whole** call (it returns
`module/not-found` and writes nothing) — so a typo in a guessed parent name silently costs a
full retry. Get the ids from the `check:normify` error output itself, and add only ancestors that
actually appear as ancestors in `normify-kimi-code/tree.json`.

`bun run check:architecture -- --update` is the equivalent for `architecture.json`'s Check E
fingerprints; it prints each module's old → new hash so the diff is reviewable.

## Skill scan roots: a root is a *container* of skill directories

`scan_directory(dir)` reads `dir/<skill>/SKILL.md`, so every scan root — project, user,
`extra_skill_dirs`, **plugin** — is a directory *containing* skill folders, never a skill
folder itself. The plugin-identity lookup therefore compares the plugin root against
`Path::new(&found.path).parent().and_then(Path::parent)` (skill dir → its parent), not against
the skill dir. Getting this off by one level silently yields `plugin: None`, and the
`<plugin-instructions>` prefix just disappears with no error.

A scan root is scanned **regardless of `merge_all_available_skills`**: that flag only collapses
the *brand* groups (`.agents/skills` + `.kimi-code/skills` → first existing). Extra and plugin
roots are walked one by one. So a precedence change among them is order-only.

Order is first-wins, and `roots_in_precedence_order()` is the single place that expresses it
(extra before plugin, i.e. v2's rank 10 > 5) — `SkillScanRoots::catalog()` and `scan_skill()` both
call it, because the `Skill` tool and the prompt must never disagree about what exists.

## A wire type with `[key: string]: any` hides producer gaps

`PluginInfo` carried `readonly [key: string]: any`, so the TUI plugin panel could read twelve
fields the engine never sent and **nothing failed to compile** — the panel's manifest lines,
`installedAt`, `github`, `diagnostics` were all silently blank. Any wire type that is a plain
`JSON.parse` of engine output should be typed field by field; the index signature is what turned a
missing producer into an invisible bug. When auditing a "dead read", check the producer's struct
before concluding the consumer is wrong — here the consumer was faithful to v2 and the engine was
behind.

The sharper version of the same trap is an **enum-valued field**: `PluginInfo.source` is compared
against `'github'` / `'zip-url'` by four separate host functions (provenance label, trust badge,
official-install check, the update notifier's identity key). The engine sent the raw catalog string,
so every comparison missed and all four took their "unknown" branch — every plugin was badged
third-party and the official-marketplace update notice could never fire. A vocabulary field is not
a display value: consumers branch on it, so a producer that skips it disables features silently.
Ask "what branches on this?" before treating a field as cosmetic.

## Two things about testing plugin code offline

- `harness.installPlugin(id)` on a **remote** catalog source performs a real download (it routes to
  the fetch-and-extract path), so a TS test cannot install a `github` / `zip-url` plugin without
  network. Those wire shapes are asserted at the Rust + serde level instead; the TS layer can only
  cover `local-path`.
- The whole `node-sdk` native suite tears its temp home dir down with a 10 × 200 ms `rmSync` retry
  (Windows file locks). Under a full 526-file parallel run that budget can be exhausted, producing
  an `EBUSY` failure **in `afterEach`** with the test body green. It passes in isolation. Do not
  "fix" it by enlarging the budget — 10 is the repo-wide convention (`removeTempDir` in
  `test/session-runtime-helpers.ts` uses the same), and the two such flakes seen so far
  (`footer-status-line` throttle timing, this one) are load, not logic.

## PowerShell round-trips corrupt line endings

`[System.IO.File]::WriteAllLines` writes `\r\n`, so using it to patch a source file converts the
**whole file** to CRLF while every other file in the tree is LF. `ReadAllText` / `WriteAllText`
preserve the string verbatim and are safe. After any bulk rewrite, check:
`git diff --stat` should show a plausible line count, and `cargo fmt --check` plus
`bun run check:*` will not catch it. To repair: strip CR bytes before LF.


## Plugin manifest paths are third-party input

`parse_plugin_manifest` enforces v2's rules (`app/plugin/manifest.ts:161-212`): every `skills` /
`agents` entry must start with `./`, is canonicalized, and must be **component-wise** inside the
plugin root (`isWithin` is not a string-prefix test — `/plugin-evil` is not within `/plugin`).
Before this, the fork did `root.join(rel.trim_start_matches("./"))` and additionally accepted an
absolute path outright, so a manifest could point the skill scan anywhere on the machine.

**Comparing a path against a canonicalized root canonicalizes neither side consistently.** The first
version canonicalized the *target* and fell back to "the path as written" when that failed, while
the root was canonicalized. Windows spells a path with an 8.3 short name (`C:\Users\ADMINI~1\...`)
and `canonicalize` expands it (`C:\Users\Administrator\...`), so a **missing** directory came back as
"resolves outside the plugin" — an error, on the most ordinary manifest there is. `canonicalize`
failing on a non-existent path is the trap; `canonicalize_allowing_missing()` (canonicalize the
deepest *existing* ancestor, re-append the tail) fixes it. Whenever a check compares a path against a
canonical reference, ask what that check returns for a path that does not exist.

Two Windows details worth remembering:
- `std::fs::canonicalize` returns the `\\?\` verbatim form. It works for every filesystem call and
  reads terribly everywhere else, so strip it (`without_verbatim_prefix`) before the value leaves
  the module — a plugin panel is not the place for `\\?\C:\...`. Keep the canonical form for the
  containment comparisons themselves.
- `#[serde(skip_serializing_if = "Vec::is_empty")]` means the host sees `undefined`, not `[]`. A
  host assertion written as `toEqual([])` fails; assert `toBeUndefined()` or normalize host-side.



## `packages/node-sdk` tests cannot observe model-facing turn content

The `@moonshot-ai/kosong` fake-provider mock in `packages/node-sdk/test/*` is never consumed by
an assertion: the native Rust engine builds its own providers, so a turn there makes no
provider call, `session.getContext()` comes back empty, and no `agents/main/wire.jsonl` is
written. Anything asserted about **what the model receives** (message part order, block
composition) cannot be pinned in that suite — it needs a fixture that really runs a model call.
Metadata-level facts (session title / lastPrompt in `session-meta.json`, SDK events) *are*
observable and are asserted there.