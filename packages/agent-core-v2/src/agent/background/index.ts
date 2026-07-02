/**
 * `background` domain barrel — re-exports the background contract
 * (`background`) and its scoped service (`backgroundService`), plus the
 * `backgroundTools` registrar. Importing this barrel registers the
 * `IAgentBackgroundService` and `IAgentBackgroundToolsService` bindings into the
 * scope registry.
 */

import './configSection';

export * from './background';
export * from './backgroundService';
export * from './backgroundTools';
export * from './backgroundToolsService';
