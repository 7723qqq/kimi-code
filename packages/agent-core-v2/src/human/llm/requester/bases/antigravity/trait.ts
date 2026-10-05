/** Antigravity drives an external CLI subprocess rather than an HTTP protocol,
 *  so it consumes no protocol customization hooks. `thinking` is declared as
 *  permanently absent so the shared trait probes
 *  (`trait?.thinking !== undefined`) stay type-safe and correctly report that
 *  this protocol has no trait-driven thinking. */
export interface AntigravityTrait {
  readonly thinking?: undefined;
}
