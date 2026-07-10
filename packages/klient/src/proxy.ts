/**
 * Typed proxy turning an `IChannel` (bound to one Service) into a value
 * satisfying that Service's interface `T`.
 *
 * Each property access becomes a `channel.call(method, arg)` — the method name
 * forwarded verbatim and invoked by reflection on the server. This is VS Code's
 * `ProxyChannel.toService`: the shared interface `T` is the whole contract; no
 * per-method allowlist, no renaming. Because it forwards by name, it also works
 * for interfaces whose members include `Event` / stream handles that an explicit
 * class could not faithfully implement.
 */

import type { IChannel } from './channel.js';

export function makeProxy<T extends object>(channel: IChannel): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      return (arg?: unknown) => channel.call(prop, arg);
    },
  });
}
