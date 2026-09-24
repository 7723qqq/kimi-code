# @moonshot-ai/kimi-code-sdk

The TypeScript SDK for Kimi Code.

Part of the [Kimi Code](https://github.com/MoonshotAI/kimi-code) monorepo (personal fork: [7723qqq/kimi-code](https://github.com/7723qqq/kimi-code)).

## What is it

A programmatic interface to the Kimi Code agent: create a harness (`KimiHarness`), point it at a config home, and drive sessions — send prompts, stream events, manage config, auth, providers, and session lifecycle — without launching the interactive TUI.

## Install

This package is **not published** to npm (`"private": true`) — it is an
in-workspace package consumed via the Bun workspace:

```sh
bun install   # from the repo root; resolve via the workspace, e.g. "workspace:^"
```

Requires Bun >= 1.4 (the package rides the native `kimi-agent` addon, built from `packages/kimi-agent`).

## Quick start

```ts
import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';
import { homedir } from 'node:os';
import { join } from 'node:path';

// `~` is not expanded — pass an absolute path (omit homeDir to default to ~/.kimi-code).
const harness = createKimiHarness({ homeDir: join(homedir(), '.kimi-code') });
const session = await harness.createSession({ prompt: 'Hello!' });
```

The harness exposes:

- **Config** — read/write `config.toml` (`getConfig` / `setConfig`), provider and model catalogs
- **Auth** — Kimi Code OAuth and API-key flows (`auth.ts`)
- **Sessions** — create, cancel, export, rename, resume, and steer sessions (`session.ts`)
- **Events** — subscribe to the session event stream (`events.ts`)
- **RPC client** — the native Rust-engine client via the napi addon (`native/sdk-rpc-client-native.ts`, facade in `sdk-rpc-client-v2.ts`)

## Examples

See [examples/](./examples/) for runnable smoke scripts covering auth, config, cancel, export, list, rename, set-model, and logging flows.

## License

MIT
