import { t } from '@moonshot-ai/kimi-i18n';
import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import {
  detectType,
  extractTitle,
  memoryDir,
  projectIdFromCwd,
  scopeDir,
  type MemoryScope,
} from '#/app/memory/memoryPaths';
import { IMemoryRepo } from '#/app/memory/memoryRepo';
import { IMemoryStore } from '#/app/memory/memoryStore';
import { GIT_MEMORY_FLAG_ID } from '#/features/gitMemory/flag';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { AgentTool, ToolExecution } from '#/tool/toolContract';

import DESCRIPTION from './memory.md?raw';

const MemoryActionSchema = z.enum([
  'search',
  'read',
  'write',
  'list',
  'delete',
  'log',
  'revert',
]);

export const MemoryToolInputSchema = z
  .object({
    action: MemoryActionSchema.describe('The memory operation to perform. Required.'),
    query: z.string().optional().describe('Search query (for `search` action).'),
    path: z
      .string()
      .optional()
      .describe(
        'Memory file path (for `read`, `write`, `delete`). Can include or omit `.md` extension. For `read`/`delete`, this is the full relative path (e.g. `global/auth.md`). For `write`, this is the filename within the chosen scope.',
      ),
    scope: z
      .enum(['global', 'project', 'session'])
      .optional()
      .describe('Memory scope (for `write`, `list`). Defaults to `project`.'),
    content: z.string().optional().describe('Markdown content (for `write` action).'),
    sha: z
      .string()
      .optional()
      .describe('Memory repository commit sha (for `revert` action).'),
  })
  .strict();

export type MemoryToolInput = z.infer<typeof MemoryToolInputSchema>;

export interface IMemoryTool extends AgentTool<MemoryToolInput> {
  readonly _serviceBrand: undefined;
}

export const IMemoryTool = createDecorator<IMemoryTool>('memoryTool');

export class MemoryTool implements IMemoryTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Memory' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MemoryToolInputSchema);

  constructor(
    @IMemoryStore private readonly store: IMemoryStore,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IMemoryRepo private readonly repo: IMemoryRepo,
    @IFlagService private readonly flags: IFlagService,
    @IHostProcessService private readonly process: IHostProcessService,
  ) {}

  resolveExecution(args: MemoryToolInput): ToolExecution {
    const action = args.action;

    return {
      description: t('toolsV2.memory.memoryAction', { action: action }),
      approvalRule: this.name,
      execute: async () => {
        switch (action) {
          case 'search':
            return this.handleSearch(args);
          case 'read':
            return this.handleRead(args);
          case 'write':
            return this.handleWrite(args);
          case 'list':
            return this.handleList(args);
          case 'delete':
            return this.handleDelete(args);
          case 'log':
            return this.handleLog(args);
          case 'revert':
            return this.handleRevert(args);
          default:
            return { output: t('toolsV2.memory.unknownAction', { action }), isError: true };
        }
      },
    };
  }

  private async handleSearch(args: MemoryToolInput) {
    if (!args.query) {
      return { output: t('toolsV2.memory.searchQueryRequired'), isError: true };
    }
    const results = await this.store.search(args.query, 10);
    if (results.length === 0) {
      return { output: t('toolsV2.memory.noEntriesFound', { query: args.query }) };
    }
    const plural = results.length === 1 ? 'y' : 'ies';
    const lines = [
      t('toolsV2.memory.foundEntries', { count: String(results.length), plural }) + '\n',
    ];
    for (const r of results) {
      lines.push(`## ${r.title}`);
      lines.push(`  path: ${r.path}`);
      lines.push(`  scope: ${r.scope}${r.scopeId ? ` (${r.scopeId})` : ''}`);
      lines.push(`  type: ${r.type}`);
      lines.push(`  score: ${r.score.toFixed(3)}`);
      lines.push(`  snippet: ${r.snippet}`);
      lines.push('');
    }
    return { output: lines.join('\n') };
  }

  private async handleRead(args: MemoryToolInput) {
    if (!args.path) {
      return { output: t('toolsV2.memory.readPathRequired'), isError: true };
    }
    const path = normalizePath(args.path);
    const entry = await this.store.get(path);
    if (entry === undefined) {
      return { output: t('toolsV2.memory.notFound', { path }) };
    }
    const lines = [
      `# ${entry.title}`,
      `path: ${entry.path}`,
      `scope: ${entry.scope}${entry.scopeId ? ` (${entry.scopeId})` : ''}`,
      `type: ${entry.type}`,
      `updated: ${new Date(entry.updatedAt).toISOString()}`,
      '',
      entry.body,
    ];
    return { output: lines.join('\n') };
  }

  private async handleWrite(args: MemoryToolInput) {
    if (!args.path) {
      return { output: t('toolsV2.memory.writePathRequired'), isError: true };
    }
    if (!args.content) {
      return { output: t('toolsV2.memory.writeContentRequired'), isError: true };
    }

    const scope = args.scope ?? 'project';
    const scopeId = this.resolveScopeId(scope);
    const fileName = sanitizeFileName(args.path);
    if (fileName === undefined) {
      return {
        output: t('toolsV2.memory.invalidFilename', { path: args.path }),
        isError: true,
      };
    }
    const relPath = buildRelPath(scope, scopeId, fileName);

    if (this.gitMemoryEnabled() && !(await this.hasGitReference(args.content))) {
      return {
        output: t('toolsV2.memory.writeNeedsReference', { path: relPath }),
        isError: true,
      };
    }

    const { stat, mkdir, writeFile } = await import('node:fs/promises');
    const { join: joinPath } = await import('pathe');

    const baseDir = memoryDir(this.bootstrap.homeDir);
    const fullDir = scopeDir(baseDir, scope, scopeId);
    const fullPath = joinPath(fullDir, fileName);

    await mkdir(fullDir, { recursive: true });
    await writeFile(fullPath, args.content, 'utf-8');
    const statInfo = await stat(fullPath);

    const entry = {
      path: relPath,
      scope,
      scopeId,
      type: detectType(args.content),
      title: extractTitle(args.content, fileName),
      body: args.content,
      fingerprint: `${statInfo.size}-${statInfo.mtimeMs}`,
      updatedAt: statInfo.mtimeMs,
    };
    await this.store.put(entry);

    if (!this.gitMemoryEnabled()) {
      return {
        output: t('toolsV2.memory.written', { path: relPath, title: entry.title, type: entry.type }),
      };
    }

    const committed = await this.repo.commit(`remember: ${entry.title}`);
    if (!committed) {
      return {
        output: t('toolsV2.memory.writtenNotCommitted', {
          path: relPath,
          title: entry.title,
          type: entry.type,
        }),
      };
    }
    const commits = await this.repo.logCommits(1);
    const sha = commits[0]?.sha ?? '';
    return {
      output: t('toolsV2.memory.writtenCommitted', {
        path: relPath,
        title: entry.title,
        type: entry.type,
        sha,
      }),
    };
  }

  private async handleLog(_args: MemoryToolInput) {
    const commits = await this.repo.logCommits(20);
    const lines = [t('toolsV2.memory.logHeader', { count: String(commits.length) })];
    for (const commit of commits) {
      lines.push(
        t('toolsV2.memory.logLine', {
          sha: commit.sha.slice(0, 7),
          date: commit.date,
          message: commit.message,
        }),
      );
    }
    return { output: lines.join('\n') };
  }

  private async handleRevert(args: MemoryToolInput) {
    if (!args.sha) {
      return { output: t('toolsV2.memory.revertFailed', { sha: '' }), isError: true };
    }
    const reverted = await this.repo.revert(args.sha);
    if (!reverted) {
      return { output: t('toolsV2.memory.revertFailed', { sha: args.sha }), isError: true };
    }
    return { output: t('toolsV2.memory.reverted', { sha: args.sha }) };
  }

  private gitMemoryEnabled(): boolean {
    try {
      return this.flags.enabled(GIT_MEMORY_FLAG_ID);
    } catch {
      return false;
    }
  }

  private async hasGitReference(content: string): Promise<boolean> {
    const candidates = content.match(/\b[0-9a-f]{7,40}\b/g) ?? [];
    const repos = [this.sessionContext.cwd, memoryDir(this.bootstrap.homeDir)];
    for (const candidate of candidates) {
      for (const repo of repos) {
        if (await this.commitExists(repo, candidate)) return true;
      }
    }
    return false;
  }

  private async commitExists(repo: string, sha: string): Promise<boolean> {
    try {
      const child = await this.process.spawn(
        'git',
        ['-C', repo, 'cat-file', '-e', `${sha}^{commit}`],
        { cwd: repo },
      );
      try {
        child.stdin.end();
      } catch {}
      for await (const _chunk of child.stdout) {
        void _chunk;
      }
      const code = await child.wait();
      return code === 0;
    } catch {
      return false;
    }
  }

  private async handleList(args: MemoryToolInput) {
    const allPaths = await this.store.list();
    const scope = args.scope;

    const filtered = scope
      ? allPaths.filter((p) =>
          p.startsWith(
            `${scope === 'global' ? 'global' : scope === 'project' ? 'projects' : 'sessions'}/`,
          ),
        )
      : allPaths;

    if (filtered.length === 0) {
      return { output: t('toolsV2.memory.noFilesFound') };
    }

    const lines = [t('toolsV2.memory.listHeader', { count: String(filtered.length) }) + '\n'];
    const sorted = [...filtered].toSorted();
    for (const p of sorted) {
      const entry = await this.store.get(p);
      if (entry) {
        lines.push(`  ${p} — ${entry.title} [${entry.type}]`);
      } else {
        lines.push(`  ${p}`);
      }
    }
    return { output: lines.join('\n') };
  }

  private async handleDelete(args: MemoryToolInput) {
    if (!args.path) {
      return { output: t('toolsV2.memory.deletePathRequired'), isError: true };
    }
    const path = normalizePath(args.path);
    const entry = await this.store.get(path);
    if (entry === undefined) {
      return { output: t('toolsV2.memory.notFound', { path }) };
    }

    const fileName = sanitizeFileName(entry.path.split('/').pop() ?? '');
    if (fileName === undefined) {
      return { output: t('toolsV2.memory.invalidFilename', { path: args.path }), isError: true };
    }

    const { unlink } = await import('node:fs/promises');
    const { join: joinPath } = await import('pathe');
    const homeDir = this.sessionContext.sessionDir.split(/[\\/]sessions[\\/]/)[0]!;
    const fullPath = joinPath(scopeDir(memoryDir(homeDir), entry.scope, entry.scopeId), fileName);
    try {
      await unlink(fullPath);
    } catch {}

    await this.store.delete(path);
    return { output: t('toolsV2.memory.deleted', { path }) };
  }

  private resolveScopeId(scope: MemoryScope): string {
    if (scope === 'global') return '';
    if (scope === 'project') return projectIdFromCwd(this.sessionContext.cwd);
    return this.sessionContext.sessionId;
  }
}

function normalizePath(path: string): string {
  return path.endsWith('.md') ? path : `${path}.md`;
}

function normalizeFileName(name: string): string {
  return name.endsWith('.md') ? name : `${name}.md`;
}

function sanitizeFileName(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) return undefined;
  return normalizeFileName(trimmed);
}

function buildRelPath(scope: MemoryScope, scopeId: string, fileName: string): string {
  if (scope === 'global') return `global/${fileName}`;
  if (scope === 'project') return `projects/${scopeId}/${fileName}`;
  return `sessions/${scopeId}/${fileName}`;
}

registerAgentToolService(IMemoryTool, MemoryTool, {
  name: 'Memory',
  domain: 'memory',
  when: (accessor) => accessor.get(IAgentScopeContext).agentId === 'main',
});
