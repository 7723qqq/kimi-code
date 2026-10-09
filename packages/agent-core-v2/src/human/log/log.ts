/**
 * The log port the llm kernel speaks.
 *
 * `human` is the pure LLM kernel and must not import v2 domains, so it cannot reach
 * `#/_base/log/log`. Callers pass a logger in when they want the kernel to report
 * something; the kernel treats it as optional and stays silent without one.
 */
export interface LlmLogger {
  warn(message: string, payload?: unknown): void;
}
