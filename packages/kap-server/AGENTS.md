# kap-server Agent Guide

The Kimi Code server shell (REST + WebSocket, `/api/v1` + `/api/v1/ws`), bootstrapped from `src/start.ts` on Fastify. Consumed by `apps/kimi-code` (`bun run dev:server` / the `web` subcommand).

## Engine decoupling

The `agent-core-v2` dependency is **retired** (physically deleted from the workspace). What remains here is the server shell plus a transitional compatibility layer:

- `src/compat/core.ts` keeps the old service identifiers (`createDecorator` / `Scope` / `bootstrap`) so the route and transport code compiles unchanged. `bootstrap()` builds a scope whose unseeded lookups return default no-op mocks; callers may seed real implementations via the `seeds` array (`apps/kimi-code` currently passes `seeds: []`).
- The **real serving surface is the native Rust server** in `packages/kimi-agent` (native HTTP/1.1 + RFC 6455, full `/api/v1` route set, ACP, PTY terminals). Per `packages/kimi-agent/ROADMAP.md` §P158, this package is slated to be reduced to a thin proxy over the Rust server or replaced by the `kimi-agent` binary outright — do not re-wire the compat mocks to new TS engine logic.
- Still-real subsystems (not mocks): auth (`src/services/auth` — token store, password hash, credential validation), global search (`src/search` — minidb-backed index with the worker/inline host seam), guiStore, server telemetry, the WS transport stack (`src/transport/ws` — broadcaster, bearer protocol, fs watch bridge), the transcript ops journal (`src/services/transcript/transcriptService.ts`), OpenAPI/AsyncAPI document generation, web asset hosting, and the envelope/error-code conventions.

## Comment conventions

No comments — no file headers, no section banners, no statement-level narration, no JSDoc (not even on exported symbols); the code is the source of truth. Lint-suppression directives (`oxlint-disable` / `eslint-disable`) are the only exception, allowed where they suppress an active rule for a deliberate pattern; other tooling directives (`@ts-expect-error`, `@ts-ignore`, …) stay banned — fix the underlying type problem instead. Enforced by `scripts/check-no-comments.mjs` (part of `bun run lint`).

## Typing conventions

The compat layer is deliberately loose: engine-facing service handles are typed `any` (`AnyService`, the event/summary aliases) and this package turns `noPropertyAccessFromIndexSignature` off in `tsconfig.json`. Everything outside `src/compat` stays strict — do not spread the looseness into routes, services, or transport code, and do not import compat types into new strict code.

## Wire conventions (still authoritative here)

Every response is wrapped in the `{ code, msg, data, request_id }` envelope with the business outcome in `code` (e.g. `40001` invalid query params, `40922` page_token mismatch) and the HTTP status reporting only server-/transport-level outcomes. `/api/v2` pagination is an opaque `page_token` (base64url JSON: version + sha256 query-condition fingerprint + keyset position) — any condition flip mid-pagination fails 40922. The Rust server mirrors these conventions; keep the two sides in sync when touching envelope or error-code shapes.