/**
 * Config-file inspection RPC — the SDK's own port of v1's `createRPC` pair
 * (the in-memory "network" simulation over structured-cloned payloads) plus
 * the localized config-document layer, so no `agent-core` import is needed.
 * The `createRPC` port is trimmed to the config RPC's needs; the error
 * serialization rides the SDK's localized `KimiError` payload helpers.
 */
import { z } from 'zod';

import {
  ErrorCodes,
  KimiError,
  fromKimiErrorPayload,
  toKimiErrorPayload,
  type KimiErrorPayload,
} from '#/legacy';
import { parseConfigString, resolveConfigPath } from '#/config-local';

export type KimiConfigValidationPathSegment = string | number;

export interface KimiConfigValidationIssue {
  readonly path: readonly KimiConfigValidationPathSegment[];
  readonly message: string;
}

export interface ResolveKimiConfigPathInput {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
}

export interface ValidateKimiConfigTomlInput {
  readonly text: string;
  readonly filePath?: string | undefined;
}

export interface KimiConfigRpc {
  resolveConfigPath(input?: ResolveKimiConfigPathInput): Promise<string>;
  validateConfigToml(input: ValidateKimiConfigTomlInput): Promise<void>;
}

interface KimiConfigCoreRpc {
  resolveConfigPath(input: ResolveKimiConfigPathInput): string;
  validateConfigToml(input: ValidateKimiConfigTomlInput): void;
}

interface KimiConfigClientRpc {}

/* ------------------------------------------------------------------ */
/*  In-memory RPC pair (port of v1's `createRPC`)                      */
/* ------------------------------------------------------------------ */

type Promisify<T> = T extends Promise<unknown> ? T : Promise<T>;

export type RPCMethods<T> = {
  [K in keyof T]: T[K] extends (payload: infer Payload) => infer Return
    ? (payload: Payload) => Promisify<Return>
    : never;
};

type RPCClient<Self extends object, Other extends object> = (
  self: Self,
) => Promise<RPCMethods<Other>>;

function createRPC<
  Left extends object,
  Right extends object,
>(): [RPCClient<Left, Right>, RPCClient<Right, Left>] {
  let left: Left | undefined;
  let right: Right | undefined;
  const leftWaiters: ((value: Left) => void)[] = [];
  const rightWaiters: ((value: Right) => void)[] = [];

  type RpcResponse =
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: KimiErrorPayload };

  function simulateNetwork<T>(data: T): Promise<T> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(data === undefined ? (undefined as T) : structuredClone(data));
      }, 0);
    });
  }

  function mapRpcFunction(
    fn: (...args: unknown[]) => unknown,
  ): (...args: unknown[]) => Promise<unknown> {
    return async (payload: unknown) => {
      const rpcPayload = await simulateNetwork(payload);
      let response: RpcResponse;
      try {
        const value = await Promise.resolve(fn(rpcPayload));
        response = { ok: true, value };
      } catch (error) {
        response = { ok: false, error: toKimiErrorPayload(error) };
      }
      const remoteResponse = await simulateNetwork(response);
      if (remoteResponse.ok) return remoteResponse.value;
      throw fromKimiErrorPayload(remoteResponse.error);
    };
  }

  async function client<Other>(
    waiters: ((value: Other) => void)[],
    getOther: () => Other | undefined,
  ): Promise<RPCMethods<Other>> {
    const build = (other: Other): RPCMethods<Other> => {
      const out: Record<string, unknown> = {};
      // Walk the prototype chain (class methods live on the prototype, not
      // as own enumerable properties) and bind every function — the same
      // `bindAllFunctions` the v1 createRPC port performed.
      let current: object | null = other as object;
      while (current !== null && current !== Object.prototype) {
        for (const key of Object.getOwnPropertyNames(current)) {
          if (key === 'constructor' || Object.hasOwn(out, key)) continue;
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (typeof descriptor?.value === 'function') {
            out[key] = mapRpcFunction(
              descriptor.value.bind(other) as (...args: unknown[]) => unknown,
            );
          }
        }
        current = Object.getPrototypeOf(current);
      }
      return out as RPCMethods<Other>;
    };
    const existing = getOther();
    if (existing !== undefined) return build(existing);
    return new Promise((resolve) => {
      waiters.push((value) => resolve(build(value)));
    });
  }

  return [
    (self: Left) => {
      left = self;
      for (const waiter of leftWaiters.splice(0)) waiter(left);
      return client<Right>(rightWaiters, () => right);
    },
    (self: Right) => {
      right = self;
      for (const waiter of rightWaiters.splice(0)) waiter(right);
      return client<Left>(leftWaiters, () => left);
    },
  ];
}

class KimiConfigCoreRpcImpl implements KimiConfigCoreRpc {
  resolveConfigPath(input: ResolveKimiConfigPathInput): string {
    return resolveConfigPath(input);
  }

  validateConfigToml(input: ValidateKimiConfigTomlInput): void {
    try {
      parseConfigString(input.text, input.filePath);
    } catch (error) {
      const validationIssues = extractValidationIssues(error);
      if (validationIssues !== undefined) {
        throw toConfigValidationError(error, validationIssues);
      }
      throw error;
    }
  }
}

export class KimiConfigRpcClient implements KimiConfigRpc {
  private readonly ready: Promise<RPCMethods<KimiConfigCoreRpc>>;

  constructor() {
    const [coreRpc, clientRpc] = createRPC<KimiConfigCoreRpc, KimiConfigClientRpc>();
    void coreRpc(new KimiConfigCoreRpcImpl());
    this.ready = clientRpc({});
  }

  async resolveConfigPath(input: ResolveKimiConfigPathInput = {}): Promise<string> {
    const rpc = await this.ready;
    return rpc.resolveConfigPath(input);
  }

  async validateConfigToml(input: ValidateKimiConfigTomlInput): Promise<void> {
    const rpc = await this.ready;
    await rpc.validateConfigToml(input);
  }
}

export function createKimiConfigRpc(): KimiConfigRpc {
  return new KimiConfigRpcClient();
}

function toConfigValidationError(
  error: unknown,
  validationIssues: readonly KimiConfigValidationIssue[],
): KimiError {
  const details =
    error instanceof KimiError && error.details !== undefined
      ? { ...error.details, validationIssues }
      : { validationIssues };

  if (error instanceof KimiError) {
    return new KimiError(error.code, error.message, { details });
  }

  const message = error instanceof Error ? error.message : String(error);
  return new KimiError(ErrorCodes.CONFIG_INVALID, message, { details });
}

function extractValidationIssues(error: unknown): readonly KimiConfigValidationIssue[] | undefined {
  const zodError = findZodError(error);
  if (zodError === undefined) return undefined;
  return zodError.issues.map((issue) => ({
    path: issue.path.map((segment) =>
      typeof segment === 'number' ? segment : String(segment),
    ),
    message: issue.message,
  }));
}

function findZodError(error: unknown): z.ZodError | undefined {
  if (error instanceof z.ZodError) return error;
  if (error instanceof Error && error.cause instanceof z.ZodError) return error.cause;
  return undefined;
}
