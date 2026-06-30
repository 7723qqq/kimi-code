/**
 * `process` domain barrel — re-exports the process contract (`process`) and
 * its scoped service (`processRunnerService`). Importing this barrel registers
 * the `IProcessRunner` binding into the scope registry.
 */

export * from './process';
export * from './processRunnerService';
