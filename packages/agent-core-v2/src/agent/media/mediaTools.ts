// ---- from upstream 2.7.0 ----
export const mediaTools: readonly unknown[] = [];
export function registerMediaTools(..._args: unknown[]): void {}

// ---- from upstream 2.7.0 ----
export interface IAgentMediaToolsRegistrar {
  readonly _serviceBrand: undefined;
  register?(): void;
}
export const IAgentMediaToolsRegistrar = Symbol('IAgentMediaToolsRegistrar');
