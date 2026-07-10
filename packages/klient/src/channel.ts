/**
 * Transport-agnostic channel contract for the `/api/v2` client.
 *
 * In the VS Code model the channel is bound to one Service (the URL carries the
 * scope + the Service's decorator id) and `command` is the method name, invoked
 * by reflection on the server. `listen` is for events over a persistent (WS)
 * transport; the HTTP channel only implements `call`.
 */

/** The client-facing channel contract (request/response + future events). */
export interface IChannel {
  call<T>(command: string, arg?: unknown): Promise<T>;
  listen(event: string, arg?: unknown): unknown;
}
