/**
 * `llmRequester.asyncEventQueue` — backward-compat re-export.
 *
 * The class definition now lives in `_base/asyncEventQueue.ts` so that
 * App-scope code (e.g. the `Model` god-object's `request()`) can share the
 * same push-based stream primitive. This file is kept for existing imports
 * inside the Agent-scope llmRequester and will be removed with the Phase 5
 * consolidation.
 */

export { AsyncEventQueue } from '#/_base/asyncEventQueue';
