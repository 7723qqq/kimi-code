/**
 * `kaos` domain barrel — re-exports the execution-environment contracts
 * (`kaos`) and the `IKaosFactory` binding (`kaosFactoryService`). Importing
 * this barrel registers the `IKaosFactory` binding into the scope registry.
 */

export * from './kaos';
export * from './kaosFactoryService';
