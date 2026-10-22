/**
 * The e2e switches, decoded in one place.
 *
 * `KIMI_E2E` turns on the offline e2e suite: `bun run e2e` sets it, and so does
 * the CI `test:heavy` job (`scripts/run-test-heavy.mjs`).
 *
 * `KIMI_E2E_REAL` is a separate opt-in for the real-LLM smoke, which needs
 * network access and provider credentials. No offline script sets it, so that
 * suite is a job of its own — `bun run e2e:real`, or
 * `KIMI_E2E_REAL=1 bun run test:heavy` when a heavy run is allowed to reach the
 * network.
 */

export interface E2EFlags {
  readonly e2e: boolean;
  readonly real: boolean;
}

const isOn = (value: string | undefined): boolean => value === '1';

export function readE2EFlags(env: Record<string, string | undefined>): E2EFlags {
  return {
    e2e: isOn(env['KIMI_E2E']),
    real: isOn(env['KIMI_E2E_REAL']),
  };
}
