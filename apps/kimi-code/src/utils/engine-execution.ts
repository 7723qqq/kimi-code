/**
 * Which executor actually ran the last turn.
 *
 * The engine self-reports these counters, so the snapshot is a copy of facts
 * that already exist on the turn result — it adds no second source of truth.
 * Recorded by `cli/rust-engine.ts` (the layer that wires the engine) and read
 * synchronously by the `/status` report.
 */
export interface EngineExecution {
  /** The Rust engine is wired as the turn executor (the gate is rust-only;
   *  the TS engine is disabled for the rust migration). */
  readonly rust: boolean;
  /** Transport the adapter resolved to. Absent before its first turn — the
   *  adapter picks napi vs stdio lazily, and a status read must not force it. */
  readonly transport?: string;
  /** `native-http` / `host-proxy` / `multi`, reported by the LLM implementation. */
  readonly llmTransport?: string;
  /** Tool calls the engine executed in its own process rather than on the host. */
  readonly nativeToolCalls?: number;
  /** Why the LLM went through the host proxy instead of the native transport.
   *  Absent when the native transport served the turn. */
  readonly llmFallbackReason?: string;
}

let current: EngineExecution | undefined;

export function setEngineExecution(execution: EngineExecution): void {
  current = execution;
}

/** Merge into the recorded snapshot; a no-op before the engine is wired, when
 *  there is no executor to report about yet. */
export function patchEngineExecution(patch: Partial<EngineExecution>): void {
  if (current !== undefined) current = { ...current, ...patch };
}

/** `undefined` means no decision has been recorded — e.g. a host that never
 *  consults the Rust engine. Reporting `js` there would be a guess. */
export function engineExecution(): EngineExecution | undefined {
  return current;
}
