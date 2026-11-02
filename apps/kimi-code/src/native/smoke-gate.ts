/**
 * The single owner of the native-asset smoke trigger. `main.ts` reads this
 * gate to decide whether loading the smoke module (which pulls the native
 * search/index stack) is warranted; `smoke.ts` re-checks it before running.
 */
export function nativeAssetSmokeRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['KIMI_CODE_NATIVE_ASSET_SMOKE'] === '1';
}
