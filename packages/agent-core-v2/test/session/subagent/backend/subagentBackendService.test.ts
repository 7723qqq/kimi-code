import { describe, expect, it } from 'vitest';

import { acpStopReason } from '#/session/subagent/backend/acpBackend';
import { SubagentBackendService } from '#/session/subagent/backend/subagentBackendService';
import type { IConfigService } from '#/app/config/config';
import type { ISessionProcessRunner } from '#/session/process/processRunner';

describe('acpStopReason', () => {
  it('maps ACP stop reasons to backend stop reasons', () => {
    expect(acpStopReason('end_turn')).toBe('completed');
    expect(acpStopReason('max_tokens')).toBe('max-tokens');
    expect(acpStopReason('refusal')).toBe('refusal');
    expect(acpStopReason('cancelled')).toBe('aborted');
    expect(acpStopReason('max_turn_requests')).toBe('error');
  });
});

describe('SubagentBackendService', () => {
  it('registers the three external backends and serves lookups by name', () => {
    const service = new SubagentBackendService(
      {} as ISessionProcessRunner,
      { get: () => undefined } as unknown as IConfigService,
    );
    expect(service.list().map((backend) => backend.name).toSorted()).toEqual(['acp', 'claude-code', 'codex']);
    expect(service.get('codex')?.name).toBe('codex');
    expect(service.get('claude-code')?.name).toBe('claude-code');
    expect(service.get('acp')?.name).toBe('acp');
  });
});
