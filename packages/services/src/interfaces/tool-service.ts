/**
 * `IToolService` — daemon-facing read-only tool surface (Chain 7 / P1.7, W9.1).
 *
 * Wraps `IHarnessBridge.rpc.getTools` and translates agent-core's `ToolInfo`
 * (camelCase, includes `'user'` source literal) into SCHEMAS §8 `ToolDescriptor`
 * (snake_case, `'skill'` literal). The adapter lives at
 * `packages/services/src/adapter/tool-adapter.ts`.
 *
 * **CoreAPI surface used**:
 *   - `bridge.rpc.getTools({}) => readonly ToolInfo[]` (packages/agent-core/src/rpc/core-api.ts:333).
 *
 * **REST.md §3.8 ?session_id behavior**: when caller passes a session_id the
 * route currently returns the same global list — agent-core's `getTools`
 * doesn't differentiate per-session, and `setActiveTools` is the only
 * per-session knob (W7+ wires that). Documented gap in `ToolServiceImpl`.
 *
 * **Anti-corruption**: imports `@moonshot-ai/agent-core` only for the
 * `createDecorator` value used to mint the service identifier.
 */

import { createDecorator } from '@moonshot-ai/agent-core';
import type { ToolDescriptor } from '@moonshot-ai/protocol';

export interface IToolService {
  /**
   * Return the available tool descriptors. When `sessionId` is supplied, the
   * impl may return a session-effective subset; today it returns the global
   * list (CoreAPI gap documented in the impl).
   */
  list(sessionId?: string): Promise<readonly ToolDescriptor[]>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IToolService = createDecorator<IToolService>('IToolService');
