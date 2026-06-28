/**
 * `cron` domain (L3) — cron operational-config section env bindings.
 *
 * Declares the `KIMI_CRON_*` environment bindings for the cron operational
 * toggles (debug / jitter / stale / killswitch / manual tick / clock). Applied
 * to the effective `cron` value by `config`; operational overrides, never
 * persisted to `config.toml`.
 */

import { type ConfigStripEnv, type EnvBindings, envBindings } from '#/config';

export const CRON_SECTION = 'cron';

export interface CronConfig {
  readonly debug: boolean;
  readonly noJitter: boolean;
  readonly noStale: boolean;
  readonly disabled: boolean;
  readonly manualTick: boolean;
  readonly clock?: string;
}

export const DEFAULT_CRON_CONFIG: CronConfig = {
  debug: false,
  noJitter: false,
  noStale: false,
  disabled: false,
  manualTick: false,
};

const cronConfigSchema = { parse: (value: unknown): CronConfig => value as CronConfig };

const on = (raw: string): boolean => raw === '1';

export const cronEnvBindings: EnvBindings<CronConfig> = envBindings(cronConfigSchema, {
  debug: { env: 'KIMI_CRON_DEBUG', parse: on },
  noJitter: { env: 'KIMI_CRON_NO_JITTER', parse: on },
  noStale: { env: 'KIMI_CRON_NO_STALE', parse: on },
  disabled: { env: 'KIMI_DISABLE_CRON', parse: on },
  manualTick: { env: 'KIMI_CRON_MANUAL_TICK', parse: on },
  clock: 'KIMI_CRON_CLOCK',
});

export const stripCronEnv: ConfigStripEnv<CronConfig> = () => undefined;
