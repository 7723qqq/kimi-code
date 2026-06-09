# @moonshot-ai/daemon-e2e

Wire-level test client for the kimi-code daemon (HTTP + WS). This package is
**private** — it ships scenario scripts that double as smoke tests and a small
typed `DaemonClient` you can reuse in vitest e2e files.

## When to use this

- You want to drive a real, running daemon process from a Node script and
  observe HTTP + WS behavior end to end.
- You're writing a vitest e2e that covers daemon REST + WS lifecycle as a
  whole — not a single in-process unit (those belong in `packages/daemon/test/`).
- You need a reference for the wire shape of approval / question / events.

## When NOT to use this

- You're testing the WS gateway in isolation — keep using
  `packages/daemon/test/ws-*.e2e.test.ts` (in-process `startDaemon` boots are
  faster and assert on the daemon's internal services directly).
- You want a typed in-process facade over the daemon for user-facing code —
  use `@moonshot-ai/node-sdk` instead (`KimiHarness`, `Session`).

## Quick start

```ts
import { DaemonClient } from '@moonshot-ai/daemon-e2e';

const client = new DaemonClient(); // http://127.0.0.1:7878 by default

const session = await client.createSession({ metadata: { cwd: process.cwd() } });
await client.connect();              // server_hello + client_hello ack
await client.subscribe(session.id);

client.onApprovalRequested(() => ({ decision: 'approved' }));

const { prompt_id, finalFrame } = await client.submitAndWait(session.id, {
  content: [{ type: 'text', text: 'Echo hello' }],
});

await client.close();
await client.deleteSession(session.id);
```

## Scripts

```sh
pnpm --filter @moonshot-ai/daemon-e2e typecheck
pnpm --filter @moonshot-ai/daemon-e2e test            # vitest self-tests
pnpm --filter @moonshot-ai/daemon-e2e test:scenarios  # run every scenarios/*.ts
pnpm --filter @moonshot-ai/daemon-e2e docker:e2e      # run daemon + scenarios in docker
```

Both `test` and `test:scenarios` require a running daemon (set `DAEMON_URL`
to override the default `http://127.0.0.1:7878`). The vitest suite skips its
live-dependent cases when no daemon is reachable so CI stays green. Scenarios
are run via `tsx` because they execute TypeScript directly.

Both commands write a browser-readable report to
`packages/daemon-e2e/reports/latest/index.html` (override with
`DAEMON_E2E_REPORT_DIR`). The report groups events by case and shows a compact
timeline of case logs, HTTP request / response envelopes, WebSocket frames, and
test results. JSON payloads are kept in collapsed detail blocks so the terminal
can stay concise while the full wire trace remains available.

`docker:e2e` builds `kimi-daemon:dev` from the root `Dockerfile`, layers
`packages/daemon-e2e/Dockerfile` on top, then runs a one-shot Docker container.
The container starts the daemon on container-local `127.0.0.1:7878` and runs
`pnpm test:scenarios` in the same container. The launcher intentionally does
not pass `-p` / `--publish`, so it does not expose a daemon port on the host and
can coexist with the `docker-compose.yml` daemon that publishes host port 7878.
Reports are written under
`~/.kimi-code-daemon-dev/daemon-e2e-reports/docker/<run-id>/latest/index.html`;
the daemon log is written beside them as `daemon.log`.

The Docker workflow uses an isolated KIMI home at
`~/.kimi-code-daemon-dev/docker-e2e/<run-id>/kimi-code-home` to avoid sharing
daemon locks with Compose. `<run-id>` is deterministic by default:
`<repo-basename>-<cksum-of-repo-path>`, so different worktrees do not collide.
On first run it seeds `config.toml` and `credentials/` from
`~/.kimi-code-daemon-dev/kimi-home/kimi-code-home` when those files exist.
Override the namespace with `DAEMON_E2E_RUN_ID`, or override paths with
`DAEMON_E2E_STATE_ROOT`, `DAEMON_E2E_KIMI_HOME_HOST`,
`DAEMON_E2E_SEED_KIMI_HOME_HOST`, or `DAEMON_E2E_REPORT_DIR_HOST`.

## Public API summary

| Symbol | Purpose |
|---|---|
| `DaemonClient` | Main facade — HTTP + WS, handshake plumbing, reverse-RPC handlers. |
| `HttpClient` | REST helpers only (no WS). Useful when you don't need event observation. |
| `WsClient` | Raw WS wrapper — queue, waiters, ack correlation. |
| `EnvelopeError` | Thrown by `unwrap()` / HTTP helpers when `envelope.code !== 0`. |
| `fetchWithReport` / `writeHtmlReport` | Capture direct fetch calls and render the JSONL trace as a single HTML report. |
| `installReverseRpcHandler` | Uniform helper powering `onApprovalRequested` / `onQuestionAsked`. |
| `waitForFrame` / `waitForSessionStatus` | Standalone wait helpers reused by scenarios. |

See `scenarios/README.md` for the executable script catalog and conventions.

## Scope notes

- **No in-process daemon bootstrap** — point at an already-running daemon.
  An in-process `startDaemon(port:0)` helper is intentionally out of scope.
- **No auto-discovery** — the WS endpoint is hard-coded to `${apiPrefix}/ws`.
  Override via `apiPrefix` only.
- **Not published** — `private: true`. Internal tooling only.
