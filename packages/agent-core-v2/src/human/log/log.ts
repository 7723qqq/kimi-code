export interface LlmLogger {
  warn(message: string, payload?: unknown): void;
}
