export const LLM_HEADERS_TIMEOUT_ENV = 'KIMI_CODE_LLM_HEADERS_TIMEOUT_MS';
export const LLM_BODY_TIMEOUT_ENV = 'KIMI_CODE_LLM_BODY_TIMEOUT_MS';

const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const NO_TIMEOUT_MS = 0;

type Env = Readonly<Record<string, string | undefined>>;

export function resolveLlmHeadersTimeoutMs(env: Env = process.env): number | undefined {
  const raw = env[LLM_HEADERS_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new Error(
      `${LLM_HEADERS_TIMEOUT_ENV} must be a positive integer no greater than ${MAX_TIMEOUT_MS}, got ${JSON.stringify(raw)}.`,
    );
  }
  return value;
}

export function resolveLlmBodyTimeoutMs(env: Env = process.env): number | undefined {
  const raw = env[LLM_BODY_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < NO_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new Error(
      `${LLM_BODY_TIMEOUT_ENV} must be an integer between ${NO_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}, got ${JSON.stringify(raw)}.`,
    );
  }
  return value;
}
