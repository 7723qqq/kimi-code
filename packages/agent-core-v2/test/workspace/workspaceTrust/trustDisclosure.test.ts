import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';

import type { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import type { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IConfigService } from '#/app/config/config';
import type { ILogService } from '#/_base/log/log';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IWorkspaceSkillCatalog } from '#/features/skill/workspace/workspaceSkillCatalog';
import type { IWorkspaceAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader';
import type { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import type { IWorkspaceInstructionsService } from '#/workspace/workspaceInstructions/workspaceInstructions';
import type { IWorkspaceTrust } from '#/workspace/workspaceTrust/workspaceTrust';
import { WorkspaceTrustDisclosureService } from '#/workspace/workspaceTrust/trustDisclosureService';

const missing = async (path: string): Promise<never> => {
  throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
};

function fsStub(): IHostFileSystem {
  return {
    _serviceBrand: undefined,
    readText: missing,
    writeText: missing,
    appendText: missing,
    readBytes: missing,
    writeBytes: missing,
    readLines: missing as never,
    createExclusive: missing,
    stat: missing,
    lstat: missing,
    readdir: missing,
    mkdir: missing,
    remove: missing,
    realpath: async (path: string) => {
      try {
        return await realpath(path);
      } catch {
        return path;
      }
    },
  } as unknown as IHostFileSystem;
}

function service(
  cwd: string,
  sharedAdditionalDirs: readonly string[],
): WorkspaceTrustDisclosureService {
  return new WorkspaceTrustDisclosureService(
    { _serviceBrand: undefined, workspaceId: 'wd_test', cwd } as unknown as IWorkspaceContext,
    fsStub(),
    { homeDir: cwd, osHomeDir: cwd, args: {} } as unknown as IBootstrapService,
    { get: () => undefined } as unknown as IConfigService,
    {
      readAdditionalDirs: async () => ({
        projectRoot: cwd,
        additionalDirs: [],
        configPath: join(cwd, 'settings.local.json'),
      }),
      resolveAdditionalDirs: async (_baseDir: string, additionalDirs: readonly string[]) => [
        ...additionalDirs,
      ],
    } as unknown as IProjectLocalConfigService,
    {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      sharedAdditionalDirs,
    } as unknown as IWorkspaceDirs,
    { get: async () => false } as unknown as IWorkspaceTrust,
    {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      reloadSources: async () => {},
      catalog: { listSkills: () => [], getSkillRoots: () => [] },
    } as unknown as IWorkspaceSkillCatalog,
    { ready: Promise.resolve() } as unknown as IWorkspaceAgentProfileLoader,
    { entries: () => [] } as unknown as IAgentProfileRegistry,
    {
      ready: Promise.resolve(),
      snapshot: { agentsMdPaths: [] },
    } as unknown as IWorkspaceInstructionsService,
    { warn: () => {} } as unknown as ILogService,
  );
}

describe('WorkspaceTrustDisclosureService additional dirs', () => {
  it('discloses skill roots and directories from every shared workspace directory', async () => {
    const project = await mkdtemp(join(tmpdir(), 'trust-project-'));
    const extra = await mkdtemp(join(tmpdir(), 'trust-extra-'));
    await mkdir(join(extra, '.kimi-code', 'skills', 'review'), { recursive: true });
    await writeFile(
      join(extra, '.kimi-code', 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: review skill\n---\n',
    );

    try {
      const activation = await service(project, [extra]).describeGatedActivation();
      const resolved = await Promise.all(
        activation.additionalDirs.map(async (dir) => {
          try {
            return await realpath(dir);
          } catch {
            return dir;
          }
        }),
      );

      expect(resolved).toContain(await realpath(extra));
      expect(resolved).toContain(await realpath(join(extra, '.kimi-code', 'skills')));
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(extra, { recursive: true, force: true });
    }
  });

  it('keeps the disclosure empty for a workspace with no additional directories', async () => {
    const project = await mkdtemp(join(tmpdir(), 'trust-project-'));

    try {
      const activation = await service(project, []).describeGatedActivation();
      expect(activation.additionalDirs).toEqual([]);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it('discloses a directory that is about to be added but is not registered yet', async () => {
    const project = await mkdtemp(join(tmpdir(), 'trust-project-'));
    const pending = await mkdtemp(join(tmpdir(), 'trust-pending-'));
    await mkdir(join(pending, '.kimi-code', 'skills', 'draft'), { recursive: true });
    await writeFile(
      join(pending, '.kimi-code', 'skills', 'draft', 'SKILL.md'),
      '---\nname: draft\ndescription: draft skill\n---\n',
    );

    try {
      const activation = await service(project, []).describeGatedActivation([pending]);
      const resolved = await Promise.all(
        activation.additionalDirs.map(async (dir) => {
          try {
            return await realpath(dir);
          } catch {
            return dir;
          }
        }),
      );

      expect(resolved).toContain(await realpath(pending));
      expect(resolved).toContain(await realpath(join(pending, '.kimi-code', 'skills')));
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(pending, { recursive: true, force: true });
    }
  });
});
