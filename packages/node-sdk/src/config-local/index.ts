/**
 * Localized v1 config-document layer (see the module headers) — the SDK's
 * own copies of `agent-core`'s config.toml schema and read/write machinery,
 * kept so the SDK keeps the v1 `KimiConfig` document contract (auth facade,
 * config RPC, host-side helpers) without importing `agent-core`.
 */
export * from './schema';
export * from './toml';
export * from './env-model';
export * from './secondary-model';
export * from './path';
