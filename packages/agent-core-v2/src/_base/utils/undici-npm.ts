import * as undiciNpm from 'undici/index.js';

/**
 * The installed npm `undici` package, not Bun's built-in shim.
 *
 * Bun resolves the bare `undici` specifier ahead of node_modules to a stub
 * whose Agent has no dispatcher pipeline and whose fetch ignores the
 * `dispatcher` option — silently disabling DNS-pinned fetching
 * (oven-sh/bun#38840; fix proposed in oven-sh/bun#36102). Mirrors
 * `@moonshot-ai/kosong`'s `src/http/undici-npm.ts`; remove both once Bun
 * prefers the installed package natively.
 */
const {
  Agent,
  EnvHttpProxyAgent,
  ProxyAgent,
  buildConnector,
  fetch,
  setGlobalDispatcher,
} = undiciNpm;

export { Agent, EnvHttpProxyAgent, ProxyAgent, buildConnector, fetch, setGlobalDispatcher };

/**
 * Instance-type spelling of {@link Agent}, so call sites can keep using
 * `Agent` in type positions exactly as against raw undici.
 */
export type Agent = InstanceType<typeof Agent>;
/**
 * Instance-type spelling of {@link EnvHttpProxyAgent}, as against raw
 * undici.
 */
export type EnvHttpProxyAgent = InstanceType<typeof EnvHttpProxyAgent>;
/**
 * Instance-type spelling of {@link ProxyAgent}, as against raw undici.
 */
export type ProxyAgent = InstanceType<typeof ProxyAgent>;
/**
 * The undici {@link Dispatcher} interface, as against raw undici.
 */
export type Dispatcher = undiciNpm.Dispatcher;
