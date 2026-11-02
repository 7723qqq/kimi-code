import { t } from '@moonshot-ai/kimi-i18n';
import { z } from 'zod';

import type { IConfigService } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import type { ToolAccesses, ToolSideEffect } from '#/tool/toolContract';

export const SANDBOX_SECTION = 'sandbox';

export type SandboxMode = 'off' | 'read-only' | 'workspace-write';

export interface SandboxExecutionPolicy {
  readonly mode: SandboxMode;

  readonly workspaceRoot: string;
}

export const SandboxConfigSchema = z.object({
  mode: z.enum(['off', 'read-only', 'workspace-write']).default('off'),
});

registerConfigSection(SANDBOX_SECTION, SandboxConfigSchema, {
  defaultValue: { mode: 'off' },
});

export function resolveSandboxPolicy(
  config: IConfigService,
  workspaceRoot: string,
): SandboxExecutionPolicy {
  return {
    mode: config.get<{ mode?: SandboxMode } | undefined>(SANDBOX_SECTION)?.mode ?? 'off',
    workspaceRoot,
  };
}

export function isSandboxBackendAvailable(): boolean {
  return false;
}

export function sandboxWriteGuard(
  policy: SandboxExecutionPolicy,
  targetPath: string,
): string | undefined {
  if (policy.mode === 'off') return undefined;
  if (policy.mode === 'read-only') {
    return t('toolsV2.sandbox.writeBlockedReadOnly', { mode: policy.mode });
  }
  if (!isPathWithinWorkspace(targetPath, policy.workspaceRoot)) {
    return t('toolsV2.sandbox.writeBlockedOutsideWorkspace', {
      mode: policy.mode,
      path: targetPath,
      workspace: policy.workspaceRoot,
    });
  }
  return undefined;
}

export function sandboxToolVeto(
  policy: SandboxExecutionPolicy,
  toolName: string,
  sideEffect: ToolSideEffect | undefined,
  accesses: ToolAccesses | undefined,
): string | undefined {
  if (policy.mode === 'off') return undefined;
  if (sideEffect === undefined) {
    return t('toolsV2.sandbox.toolBlockedUndeclared', { tool: toolName, mode: policy.mode });
  }
  switch (sideEffect) {
    case 'read':
      return undefined;
    case 'execute':
      return t('toolsV2.sandbox.codeExecutionBlocked', { mode: policy.mode });
    case 'shell':
      return policy.mode === 'read-only'
        ? t('toolsV2.sandbox.shellBlockedReadOnly', { tool: toolName, mode: policy.mode })
        : t('toolsV2.sandbox.shellBlockedNoBackend', { tool: toolName, mode: policy.mode });
    case 'write':
      return sandboxWriteVeto(policy, toolName, accesses);
  }
}

function sandboxWriteVeto(
  policy: SandboxExecutionPolicy,
  toolName: string,
  accesses: ToolAccesses | undefined,
): string | undefined {
  const writePaths = (accesses ?? []).flatMap((access) =>
    access.kind === 'file' && (access.operation === 'write' || access.operation === 'readwrite')
      ? [access.path]
      : [],
  );
  if (policy.mode === 'read-only') {
    return writePaths.length > 0
      ? t('toolsV2.sandbox.writeBlockedReadOnly', { mode: policy.mode })
      : t('toolsV2.sandbox.toolBlockedReadOnly', { tool: toolName, mode: policy.mode });
  }
  if (writePaths.length === 0) {
    return t('toolsV2.sandbox.writeBlockedUnverifiable', { tool: toolName, mode: policy.mode });
  }
  for (const path of writePaths) {
    const error = sandboxWriteGuard(policy, path);
    if (error !== undefined) return error;
  }
  return undefined;
}

function isPathWithinWorkspace(targetPath: string, workspaceRoot: string): boolean {
  const normalizedTarget = normalizePathForComparison(targetPath);
  const normalizedRoot = normalizePathForComparison(workspaceRoot);
  if (normalizedRoot === '') return false;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

function normalizePathForComparison(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}
