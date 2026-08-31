/**
 * Which executor actually ran the last turn.
 *
 * The engine self-reports these counters, so the snapshot is a copy of facts
 * that already exist on the turn result — it adds no second source of truth.
 * Recorded by `cli/rust-engine.ts` (the layer that wires the engine) and read
 * synchronously by the `/status` report.
 */
export interface EngineExecution {
  /** The Rust engine is wired as the turn executor (`agent.engine !== 'js'`). */
  readonly rust: boolean;
  /** Transport the adapter resolved to. Absent before its first turn — the
   *  adapter picks napi vs stdio lazily, and a status read must not force it. */
  readonly transport?: string;
  /** `native-http` / `host-proxy` / `multi`, reported by the LLM implementation. */
  readonly llmTransport?: string;
  /** Tool calls the engine executed in its own process rather than on the host. */
  readonly nativeToolCalls?: number;
}

let current: EngineExecution | undefined;

export function setEngineExecution(execution: EngineExecution): void {
  current = execution;
}

/** `undefined` means no decision has been recorded — e.g. a host that never
 *  consults the Rust engine. Reporting `js` there would be a guess. */
export function engineExecution(): EngineExecution | undefined {
  return current;
}
