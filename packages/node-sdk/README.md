# @moonshot-ai/kimi-code-sdk

The TypeScript SDK for Kimi Code.

Part of the [Kimi Code](https://github.com/MoonshotAI/kimi-code) monorepo (personal fork: [7723qqq/kimi-code](https://github.com/7723qqq/kimi-code)).

## What is it

A programmatic interface to the Kimi Code agent: create a harness (`KimiHarness`), point it at a config home, and drive sessions — send prompts, stream events, manage config, auth, providers, and session lifecycle — without launching the interactive TUI.

## Install

```sh
npm install @moonshot-ai/kimi-code-sdk
```

Requires Node.js 22.19.0 or later.

## Quick start

```ts
import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';

const harness = createKimiHarness({ homeDir: '~/.kimi-code' });
const session = await harness.createSession({ prompt: 'Hello!' });
```

The harness exposes:

- **Config** — read/write `config.toml` (`getConfig` / `setConfig`), provider and model catalogs
- **Auth** — Kimi Code OAuth and API-key flows (`auth.ts`)
- **Sessions** — create, cancel, export, rename, resume, and steer sessions (`session.ts`)
- **Events** — subscribe to the session event stream (`events.ts`)
- **RPC client** — the v2 contract-driven client with zod validation (`sdk-rpc-client-v2.ts`)

## Examples

See [examples/](./examples/) for runnable smoke scripts covering auth, config, cancel, export, list, rename, set-model, and logging flows.

## License

MIT
