/**
 * `event` domain barrel — re-exports the event bus contract (`event`) and its
 * scoped service (`eventService`). Importing this barrel registers the
 * `IEventService` binding into the scope registry.
 */

export * from './event';
export * from './eventService';
