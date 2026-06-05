/**
 * Subpath barrel for `@moonshot-ai/agent-core/di/test`. Holds only the
 * test-time surface so the main `@moonshot-ai/agent-core` entry does not
 * carry test code into daemon bundles. Imported as:
 *
 * ```ts
 * import { TestInstantiationService } from '@moonshot-ai/agent-core/di/test';
 * ```
 *
 * Anything not test-specific (e.g. `InstantiationService`, decorators)
 * must continue to be exported from `./index.ts` — do NOT duplicate it
 * here.
 */

export { TestInstantiationService } from './testInstantiationService';
