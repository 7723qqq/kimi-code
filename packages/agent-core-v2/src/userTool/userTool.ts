import { createDecorator } from "#/_base/di";
import type { ToolResult } from '#/toolRegistry';

export interface UserToolRegistration {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface UserToolServiceOptions {
  readonly executeUserTool?: (
    input: {
      readonly turnId: number;
      readonly toolCallId: string;
      readonly args: unknown;
    },
    options?: { readonly signal?: AbortSignal },
  ) => Promise<ToolResult> | ToolResult;
}

export interface IUserToolService {
  readonly _serviceBrand: undefined;

  register(input: UserToolRegistration): void;
  unregister(name: string): void;
}

export const IUserToolService = createDecorator<IUserToolService>('agentUserToolService');
