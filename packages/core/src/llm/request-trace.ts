/**
 * Live request provenance contract.
 *
 * Exposes the provider trace identifier of one logical LLM request while its
 * result is still pending. Pure contract (types only); no scoped service.
 */

export interface LLMRequestTrace {
  readonly requestId: string | undefined;
}
