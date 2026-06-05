/**
 * `SessionServiceImpl` — adapter between protocol-shaped REST surface and
 * agent-core's `CoreAPI` session methods (Chain 2 / P1.2).
 *
 * Wraps `IHarnessBridge.rpc.{createSession, listSessions, closeSession,
 * renameSession, updateSessionMetadata, getSessionMetadata}` and translates:
 *
 *   agent-core (camelCase + number ms)  ←→  protocol (snake_case + ISO 'Z')
 *
 * Field mapping (agent-core → protocol):
 *
 *   SessionSummary.id              →  Session.id
 *   SessionSummary.title?          →  Session.title (default "" or echoed)
 *   SessionSummary.workDir         →  Session.metadata.cwd
 *   SessionSummary.createdAt       →  Session.created_at (ISO)
 *   SessionSummary.updatedAt       →  Session.updated_at (ISO)
 *   SessionSummary.metadata?       →  Session.metadata (merged into {cwd})
 *
 *   SessionMeta.title              →  Session.title (overrides Summary if get-after-fetch)
 *   SessionMeta.lastPrompt         →  no protocol field today (drop)
 *   SessionMeta.custom             →  merged into Session.metadata
 *
 * Fields the daemon FILLS WITH DEFAULTS (CoreAPI does not surface them today —
 * documented in `packages/protocol/src/session.ts` header + W6 STATUS):
 *
 *   Session.status                 →  'idle'  (no agent-core surface yet)
 *   Session.usage                  →  emptySessionUsage()  (no surface)
 *   Session.permission_rules       →  []      (no enumeration surface)
 *   Session.message_count          →  0       (no surface)
 *   Session.last_seq               →  0       (no surface)
 *   Session.agent_config.model     →  echoed from create or '' default
 *
 * Future chains (W7+) backfill these as agent-core surfaces grow. The wire
 * stays stable.
 *
 * **CoreAPI gap — `get(id)`**: agent-core does NOT expose a single-session
 * read returning a full `SessionSummary`. `get(id)` is implemented as
 * `listSessions({}) + .find(s => s.id === id)` and throws
 * `SessionNotFoundError` (→ 40401) when missing. Documented in W6 STATUS
 * Decisions.
 *
 * **DI wiring**: this class takes `IHarnessBridge` via ctor positional arg.
 * `defaultServicesModule()` adds a `SyncDescriptor(SessionServiceImpl)` entry,
 * but W2's container has no ctor-arg DI, so the daemon's `start.ts` wires it
 * via `ix.createInstance(SessionServiceImpl, a.get(IHarnessBridge))` then
 * `services.set(ISessionService, instance)` — same pattern as HarnessBridge
 * in W4. The descriptor entry is the canonical declaration; the daemon's
 * manual wiring is the runtime path.
 *
 * **Anti-corruption**: this file imports from `@moonshot-ai/agent-core` only
 * for type-only `SessionSummary` / `SessionMeta`. Runtime calls go through
 * `IHarnessBridge.rpc.<method>`, not direct CoreAPI consumption.
 */

import { Disposable } from '@moonshot-ai/agent-core';
import type { JsonObject, SessionMeta, SessionSummary } from '@moonshot-ai/agent-core';
import {
  emptySessionUsage,
  type PageResponse,
  type Session,
  type SessionCreate,
  type SessionUpdate,
} from '@moonshot-ai/protocol';

import { IHarnessBridge } from '../bridge/harness-bridge';
import {
  ISessionService,
  SessionNotFoundError,
  type SessionListQuery,
} from '../interfaces/session-service';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Treat the incoming `metadata` object — schema-validated by zod as
 * `{cwd: string}` plus arbitrary `unknown` keys — as a JSON-safe object for
 * agent-core's `JsonObject` slot. We don't deep-validate here; clients can
 * send non-JSON-serializable values and agent-core will reject at the RPC
 * boundary. This cast keeps the adapter narrow and the wire stable.
 */
function asJsonObject(value: Record<string, unknown>): JsonObject {
  return value as unknown as JsonObject;
}

/**
 * Convert agent-core's `SessionSummary` + optional `SessionMeta` into the
 * protocol-level `Session` shape. The optional `meta` argument is the result
 * of `getSessionMetadata` — when present, its `title` / `custom` enrich the
 * baseline summary; when absent, defaults are used.
 *
 * `cwd` overrides apply in this priority order:
 *   1. `meta.custom.cwd` (set by daemon when update wrote a new cwd).
 *   2. `summary.metadata.cwd` (when caller-supplied during create).
 *   3. `summary.workDir` (agent-core canonical field).
 *
 * The merged `Session.metadata` keeps `cwd` plus anything in `meta.custom`
 * (excluding daemon-internal `goal` plumbing — that's not protocol surface).
 */
export function toProtocolSession(
  summary: SessionSummary,
  meta?: SessionMeta | undefined,
): Session {
  const summaryMetadata = (summary.metadata ?? {}) as Record<string, unknown>;
  const customMetadata = (meta?.custom ?? {}) as Record<string, unknown>;
  const cwd =
    (typeof customMetadata['cwd'] === 'string' && (customMetadata['cwd'] as string)) ||
    (typeof summaryMetadata['cwd'] === 'string' && (summaryMetadata['cwd'] as string)) ||
    summary.workDir;

  // Strip the internal "goal" key — that's daemon-side runtime state, not
  // protocol surface (SCHEMAS §2 doesn't expose it).
  const { goal: _drop, ...customWithoutGoal } = customMetadata;

  const mergedMetadata: Session['metadata'] = {
    ...customWithoutGoal,
    cwd,
  };

  const title = meta?.title ?? summary.title ?? '';

  return {
    id: summary.id,
    title,
    created_at: new Date(summary.createdAt).toISOString(),
    updated_at: new Date(summary.updatedAt).toISOString(),
    status: 'idle',
    metadata: mergedMetadata,
    agent_config: {
      // CoreAPI doesn't surface a session's effective model on the listSessions
      // path; we leave it empty and let later chains populate via getModel
      // (chain 3+). Empty string keeps the schema valid for downstream
      // consumers that only inspect known keys.
      model: '',
    },
    usage: emptySessionUsage(),
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
  };
}

export class SessionServiceImpl extends Disposable implements ISessionService {
  constructor(@IHarnessBridge private readonly bridge: IHarnessBridge) {
    super();
  }

  async create(input: SessionCreate): Promise<Session> {
    // SessionCreate.metadata.cwd is REQUIRED by Zod; agent-core's createSession
    // also calls `requiredWorkDir(...)` which throws if missing.
    const metadataForCore = asJsonObject(input.metadata as Record<string, unknown>);
    const summary = await this.bridge.rpc.createSession({
      workDir: input.metadata.cwd,
      metadata: metadataForCore,
      ...(input.agent_config?.model !== undefined ? { model: input.agent_config.model } : {}),
    });
    // agent-core's createSession ignores any caller-supplied title — newly
    // created sessions get the default `SessionMeta.title = 'New Session'`.
    // When the caller supplied a title we apply it via `renameSession` so the
    // post-create get reflects it.
    if (input.title !== undefined) {
      try {
        await this.bridge.rpc.renameSession({ sessionId: summary.id, title: input.title });
      } catch {
        // If rename fails (e.g. session closed/race), continue with the
        // default — the response shape is unchanged.
      }
    }
    const meta = await this.tryGetMeta(summary.id);
    return toProtocolSession(summary, meta);
  }

  async list(query: SessionListQuery): Promise<PageResponse<Session>> {
    const all = await this.bridge.rpc.listSessions({});
    // Sort by createdAt desc per REST §1.6 "最近 N 条（按 created_at desc）".
    const sorted = [...all].sort((a, b) => b.createdAt - a.createdAt);

    // Cursor: anchor on id. before_id = older than that id; after_id = newer.
    // Because the underlying list is desc, "older" = AFTER in the array.
    let pivotIndex = -1;
    if (query.before_id !== undefined) {
      pivotIndex = sorted.findIndex((s) => s.id === query.before_id);
    } else if (query.after_id !== undefined) {
      pivotIndex = sorted.findIndex((s) => s.id === query.after_id);
    }

    let slice: typeof sorted;
    if (query.before_id !== undefined && pivotIndex >= 0) {
      // before_id = older entries → tail of the desc array, exclusive of pivot
      slice = sorted.slice(pivotIndex + 1);
    } else if (query.after_id !== undefined && pivotIndex >= 0) {
      // after_id = newer entries → head of the desc array, exclusive of pivot
      slice = sorted.slice(0, pivotIndex);
    } else {
      slice = sorted;
    }

    const requestedSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
    const pageSummaries = slice.slice(0, pageSize);
    const hasMore = slice.length > pageSize;

    // Hydrate each summary with its metadata. We do these in parallel —
    // `getSessionMetadata` is in-memory once the session is loaded, so the
    // round-trip count is what matters, not bandwidth.
    const items = await Promise.all(
      pageSummaries.map(async (s) => toProtocolSession(s, await this.tryGetMeta(s.id))),
    );

    // Apply post-hydration status filter if requested. Today all sessions
    // are mapped to 'idle' (see header note); the filter is wired now so the
    // wire contract is stable when agent-core surfaces a real status enum.
    const filtered =
      query.status !== undefined ? items.filter((s) => s.status === query.status) : items;

    return { items: filtered, has_more: hasMore };
  }

  async get(id: string): Promise<Session> {
    const all = await this.bridge.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }
    const meta = await this.tryGetMeta(id);
    return toProtocolSession(summary, meta);
  }

  async update(id: string, input: SessionUpdate): Promise<Session> {
    // Existence check first — gives a deterministic 40401 if the id is wrong.
    const all = await this.bridge.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }

    // 1) title goes through renameSession.
    if (input.title !== undefined) {
      await this.bridge.rpc.renameSession({ sessionId: id, title: input.title });
    }

    // 2) metadata patches go through updateSessionMetadata. agent-core's
    //    SessionMeta has top-level `title` + `custom`; we route protocol's
    //    `metadata` (catchall) into `custom` so it round-trips on the next get.
    const metadataPatch = input.metadata;
    if (metadataPatch !== undefined && Object.keys(metadataPatch).length > 0) {
      await this.bridge.rpc.updateSessionMetadata({
        sessionId: id,
        metadata: { custom: metadataPatch as Record<string, unknown> },
      });
    }

    // 3) agent_config + permission_rules: no CoreAPI surface yet — we accept
    //    the input (schema-validated) but the daemon doesn't persist them
    //    in this chain. W7+ wires this. Documented in W6 STATUS.

    // Re-fetch to return the post-update Session.
    const allAfter = await this.bridge.rpc.listSessions({});
    const summaryAfter = allAfter.find((s) => s.id === id) ?? summary;
    const meta = await this.tryGetMeta(id);
    return toProtocolSession(summaryAfter, meta);
  }

  async delete(id: string): Promise<{ deleted: true }> {
    // Existence check — deterministic 40401 even on close.
    const all = await this.bridge.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }
    await this.bridge.rpc.closeSession({ sessionId: id });
    return { deleted: true };
  }

  /**
   * Pull a session's metadata; swallow errors (session may not be loaded into
   * the active session map yet, in which case `sessionApi(id)` throws). The
   * caller falls back to defaults from the summary alone.
   */
  private async tryGetMeta(id: string): Promise<SessionMeta | undefined> {
    try {
      const meta = await this.bridge.rpc.getSessionMetadata({ sessionId: id });
      return meta;
    } catch {
      return undefined;
    }
  }
}
