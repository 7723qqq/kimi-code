/**
 * `externalHooks` domain (L6) barrel — re-exports the per-scope external-hooks
 * observer contract and implementation. The App-scope executor now lives in
 * the sibling `externalHooksRunner` domain (`#/app/externalHooksRunner`).
 */

import './configSection';

export * from './externalHooks';
export * from './externalHooksService';
