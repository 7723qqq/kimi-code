# pi-tui

Vendored fork of [`earendil-works/pi`](https://github.com/earendil-works/pi) `packages/tui`. Keep the fork small so upstream syncs stay cheap.

**Syncing from upstream, adding a local patch, or reviewing a pi-tui diff:** read [UPSTREAM.md](./UPSTREAM.md). The fork is the diff against the pinned upstream commit; that file records why those diffs exist.

## Changing this package

Put TUI product behavior in `apps/kimi-code/src/tui` (composition, subclassing, existing host callbacks). Change this package only when the public API cannot express the behavior.

A patch that lands here must:

1. Be a library defect (crash, wrong render) or an extension point the app cannot reach (input state machine, render hot path, tokenizer).
2. Be additive: optional argument, callback, or default-off switch. Defaults match upstream.
3. Add an intent card in `UPSTREAM.md` and a test that fails without the change.

Skip step 3 and the change is not done. Do not rewrite a rendering strategy.

## Tests

- This package's tests are written for `node:test`, not vitest; the root `vitest run` does not execute them — CI covers them through the dedicated `test-pi-tui` job in `.github/workflows/ci.yml`.
- The `test` script goes through `scripts/test.mjs`, which dispatches on runtime: real Node spawns `node --test`, Bun (`bun --bun run test`) spawns `bun test` — Bun's `node --test` shim cannot arm the node:test harness. Both runtimes must stay green.
- Prefer adding new narrow-width tests to the existing test file of the corresponding component.

## Acceptance after syncing from upstream

- (`cd packages/pi-tui && bun run test`) must pass in full; any failure among the guarding tests referenced in `UPSTREAM.md` means a local divergence was overwritten and lost.
