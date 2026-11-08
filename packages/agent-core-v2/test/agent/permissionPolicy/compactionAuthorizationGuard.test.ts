import { describe, expect, it } from 'bun:test';

import type { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { PermissionPolicyContext } from '#/agent/permissionPolicy/types';
import { CompactionAuthorizationGuardPermissionPolicyService } from '#/agent/permissionPolicy/policies/compaction-authorization-guard';

function contextWith(messages: readonly ContextMessage[]): IAgentContextMemoryService {
  return { get: () => messages } as unknown as IAgentContextMemoryService;
}

function toolCallContext(name: string, args: unknown): PermissionPolicyContext {
  return {
    turnId: 1,
    signal: new AbortController().signal,
    toolCall: { type: 'function', id: 'call_1', name, arguments: JSON.stringify(args) },
    toolCalls: [],
    args,
  } as unknown as PermissionPolicyContext;
}

function compactionSummary(): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: 'compacted' }],
    toolCalls: [],
    origin: { kind: 'compaction_summary' },
  } as ContextMessage;
}

describe('CompactionAuthorizationGuardPermissionPolicyService', () => {
  it('asks before an irreversible command once the context has been compacted', async () => {
    const policy = new CompactionAuthorizationGuardPermissionPolicyService(
      contextWith([compactionSummary()]),
    );

    expect(await policy.evaluate(toolCallContext('Bash', { command: 'git push origin main' }))).toEqual(
      { kind: 'ask', reason: { compaction_authorization_required: true } },
    );
  });

  it('stays out of the way for a routine command after compaction', async () => {
    const policy = new CompactionAuthorizationGuardPermissionPolicyService(
      contextWith([compactionSummary()]),
    );

    expect(await policy.evaluate(toolCallContext('Bash', { command: 'ls -la' }))).toBeUndefined();
  });

  it('stays out of the way when nothing has been compacted', async () => {
    const policy = new CompactionAuthorizationGuardPermissionPolicyService(contextWith([]));

    expect(await policy.evaluate(toolCallContext('Bash', { command: 'git push origin main' }))).toBeUndefined();
  });

  it('only watches Bash commands', async () => {
    const policy = new CompactionAuthorizationGuardPermissionPolicyService(
      contextWith([compactionSummary()]),
    );

    expect(await policy.evaluate(toolCallContext('Write', { path: '/tmp/x', content: 'y' }))).toBeUndefined();
  });
});
