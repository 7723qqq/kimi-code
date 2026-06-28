/**
 * `gateway` domain barrel — re-exports the gateway contract (`gateway`) and its
 * scoped services (`gatewayService`). Importing this barrel registers the
 * `IRestGateway`, `IWSGateway`, and `IWSBroadcastService` bindings into the
 * scope registry.
 */

export * from './gateway';
export * from './gatewayService';
