/**
 * Re-export the installed npm `undici` package.
 *
 * Bun resolves the bare `undici` specifier to its own built-in shim ahead of
 * node_modules (a hardcoded alias table; see `src/js/thirdparty/undici.js` in
 * oven-sh/bun). The shim's `Agent` is an inert stub — no dispatcher pipeline,
 * no `close()`/`dispatch()` — and its `fetch` ignores the `dispatcher` option
 * entirely, which silently disables DNS-pinned fetching and proxy dispatch
 * (oven-sh/bun#38840; resolution fix proposed in oven-sh/bun#36102). Import
 * undici through this module so every path that depends on real dispatcher
 * semantics gets the installed package under every runtime. Remove this
 * module once Bun prefers the installed package natively.
 */
export {
  Agent,
  EnvHttpProxyAgent,
  ProxyAgent,
  buildConnector,
  fetch,
  setGlobalDispatcher,
} from 'undici/index.js';
export type { Dispatcher } from 'undici/index.js';
