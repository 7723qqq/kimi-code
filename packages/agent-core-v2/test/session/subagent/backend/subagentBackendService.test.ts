import { describe, expect, it } from 'vitest';

import type { IConfigService } from '#/app/config/config';
import type { ISessionProcessRunner } from '#/session/process/processRunner';
import { acpStopReason } from '#/session/subagent/backend/acpBackend';
import { backendIncompatibility } from '#/session/subagent/backend/backendCompat';
import { stripSubagentBackendParameter } from '#/session/subagent/backend/configSection';
import { SubagentBackendService } from '#/session/subagent/backend/subagentBackendService';

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
    expect(
      service
        .list()
        .map((backend) => backend.name)
        .toSorted(),
    ).toEqual(['acp', 'claude-code', 'codex']);
    expect(service.getBackend('codex')?.name).toBe('codex');
    expect(service.getBackend('claude-code')?.name).toBe('claude-code');
    expect(service.getBackend('acp')?.name).toBe('acp');
  });
});

describe('backendIncompatibility', () => {
  it('accepts a plain backend request', () => {
    expect(backendIncompatibility({ backend: 'codex' })).toBeUndefined();
  });

  it('ignores requests without a backend', () => {
    expect(backendIncompatibility({})).toBeUndefined();
    expect(backendIncompatibility({ backend: '', resume: 'agent-1' })).toBeUndefined();
  });

  it('rejects each in-process-only parameter', () => {
    expect(backendIncompatibility({ backend: 'codex', resume: 'agent-1' })).toContain(
      'Cannot use backend with resume',
    );
    expect(backendIncompatibility({ backend: 'codex', subagent_type: 'explore' })).toContain(
      'Cannot use backend with subagent_type',
    );
    expect(backendIncompatibility({ backend: 'codex', model: 'provider/fast' })).toContain(
      'Cannot use backend with model',
    );
    expect(backendIncompatibility({ backend: 'codex', fork: true })).toContain(
      'Cannot use backend with fork',
    );
  });
});

describe('stripSubagentBackendParameter', () => {
  it('removes the backend property and required entry while keeping the rest', () => {
    const parameters = {
      type: 'object',
      properties: { prompt: { type: 'string' }, backend: { type: 'string' } },
      required: ['prompt', 'backend'],
    };

    const stripped = stripSubagentBackendParameter(parameters);

    expect(stripped['properties']).toEqual({ prompt: { type: 'string' } });
    expect(stripped['required']).toEqual(['prompt']);
    expect(parameters['properties']).toHaveProperty('backend');
  });

  it('returns the parameters untouched when backend is absent', () => {
    const parameters = { type: 'object', properties: { prompt: { type: 'string' } } };

    expect(stripSubagentBackendParameter(parameters)).toBe(parameters);
  });
});
