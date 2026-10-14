import { isOpenPlatformId } from '@moonshot-ai/kimi-code-oauth';

import { DEFAULT_OAUTH_PROVIDER_NAME } from '#/constant/app';

/**
 * Who owns a provider record's identity.
 *
 * Three outside systems re-provision a record by looking it up BY ID: the login
 * flow (the `oauth` record under {@link isLoginAccountProviderId}), the Open
 * Platform refresh (the platform's own ids), and the custom-registry refresh
 * (`source`, matched against the registry's own ids). Renaming one of those
 * records does not move it — it orphans the credential and the store the record
 * points at, and the next refresh or login re-adds the original id beside the
 * copy, leaving two providers and two sets of aliases. That is why the id is
 * locked while the rest of the record stays editable, and why the two front ends
 * share this decision instead of each spelling out its own list.
 *
 * Editing `config.toml` by hand is unaffected.
 */
export interface ManagedProviderRecord {
  oauth?: unknown;
  source?: unknown;
}

/** The account `/login` and `/logout` own; `provider-manager.ts` hides its row. */
export function isLoginAccountProviderId(providerId: string): boolean {
  return providerId === DEFAULT_OAUTH_PROVIDER_NAME;
}

/**
 * Whether EVERY field is externally owned, so the form opens read-only: the
 * login account, an Open Platform id, or an `oauth` record under any id — the
 * three cases where a hand edit is undone or duplicated by the next refresh.
 */
export function isFormReadOnlyProvider(
  providerId: string,
  provider: ManagedProviderRecord | undefined,
): boolean {
  if (provider?.oauth !== undefined) return true;
  return isOpenPlatformId(providerId) || isLoginAccountProviderId(providerId);
}

/**
 * Whether the record's id — and only its id — may not be changed. A
 * custom-registry import (`source`) is the case this adds over
 * {@link isFormReadOnlyProvider}: its models are re-fetched from the registry,
 * but its id has to keep matching the registry entry.
 */
export function isProviderIdLocked(
  providerId: string,
  provider: ManagedProviderRecord | undefined,
): boolean {
  if (provider?.source !== undefined) return true;
  return isFormReadOnlyProvider(providerId, provider);
}
