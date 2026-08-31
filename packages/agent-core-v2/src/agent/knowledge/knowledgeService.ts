import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventBus } from '#/app/event/eventBus';
import { LifecycleScope } from '#/app/scopes';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import {
  IAgentKnowledgeService,
  type KnowledgeAddInput,
  type KnowledgeEntry,
  type KnowledgeSearchResult,
  type KnowledgeStats,
} from './knowledge';
import { KnowledgeInjection } from './knowledgeInjection';
import { KnowledgeLearner } from './knowledgeLearner';

let nativeKnowledge:
  | {
      nativeKnowledgeOpen(dbPath: string): void;
      nativeKnowledgeClose(dbPath?: string | null): void;
      nativeKnowledgeAdd(input: {
        title: string;
        category: string;
        content: string;
        tags: string;
        scope?: string | null;
        source: string;
        confidence: number;
        status?: string | null;
      }): string;
      nativeKnowledgeSearch(options: {
        query: string;
        scopePath?: string | null;
        tags?: string | null;
        limit: number;
        minConfidence: number;
      }): string;
      nativeKnowledgeRemove(id: string): boolean;
      nativeKnowledgeConfirm(id: string): boolean;
      nativeKnowledgeReject(id: string): boolean;
      nativeKnowledgeStats(): string;
      nativeKnowledgeImport(markdown: string): string;
    }
  | undefined;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const candidate = require('@moonshot-ai/kimi-native-tools') as
    | Record<string, unknown>
    | undefined;
  // A stale native binary predating the knowledge functions must degrade to
  // "module unavailable" instead of failing on every call below.
  if (candidate && typeof candidate['nativeKnowledgeOpen'] === 'function') {
    nativeKnowledge = candidate as NonNullable<typeof nativeKnowledge>;
  }
} catch (error) {
  void error;
}

export class AgentKnowledgeService extends Disposable implements IAgentKnowledgeService {
  declare readonly _serviceBrand: undefined;

  private initialized = false;
  private currentDbPath: string | null = null;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentLifecycleService lifecycle: IAgentLifecycleService,
    @IEventBus eventBus: IEventBus,
    @IAgentContextMemoryService contextMemory: IAgentContextMemoryService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    if (!nativeKnowledge) {
      this.log.warn('Knowledge native module not available — knowledge features disabled');
    }
    this.initDatabase();
    if (this.scopeContext.agentId === 'main') {
      this._register(new KnowledgeLearner(this, eventBus, contextMemory));
      this._register(
        new KnowledgeInjection(this, this.scopeContext, lifecycle, contextMemory),
      );
    }
  }

  private initDatabase(): void {
    if (!nativeKnowledge || this.initialized) return;
    const projectDb = `${this.bootstrap.cwd}/.kimi-code/knowledge.db`;
    try {
      nativeKnowledge.nativeKnowledgeOpen(projectDb);
      this.initialized = true;
      this.currentDbPath = projectDb;
    } catch (error) {
      this.log.warn('Failed to open project knowledge DB, falling back to user DB', {
        error: error,
        projectDb,
      });
      try {
        const userDb = `${this.bootstrap.homeDir}/knowledge.db`;
        nativeKnowledge.nativeKnowledgeOpen(userDb);
        this.initialized = true;
        this.currentDbPath = userDb;
      } catch (error) {
        this.log.error('Failed to open user knowledge DB — knowledge features disabled', error);
      }
    }
  }

  open(projectDbPath: string, userDbPath: string): void {
    if (!nativeKnowledge) return;
    try {
      if (this.currentDbPath !== null) {
        try {
          nativeKnowledge.nativeKnowledgeClose(this.currentDbPath);
        } catch {
        }
      }
      nativeKnowledge.nativeKnowledgeOpen(projectDbPath);
      this.initialized = true;
      this.currentDbPath = projectDbPath;
    } catch (error) {
      this.log.warn('open(projectDbPath) failed, trying userDbPath', {
        error: error,
        projectDbPath,
      });
      try {
        nativeKnowledge.nativeKnowledgeOpen(userDbPath);
        this.initialized = true;
        this.currentDbPath = userDbPath;
      } catch (error) {
        this.initialized = false;
        this.log.error('open() failed for both project and user DB paths', error);
      }
    }
  }

  search(query: string, scopePath?: string, tags?: string[], limit = 5): KnowledgeSearchResult[] {
    if (!nativeKnowledge || !this.initialized) return [];
    try {
      const json = nativeKnowledge.nativeKnowledgeSearch({
        query,
        scopePath: scopePath ?? null,
        tags: tags?.join(',') ?? null,
        limit,
        minConfidence: 0.5,
      });
      const results: KnowledgeSearchResult[] = JSON.parse(json);
      return results.filter((r) => r.entry.status !== 'pending');
    } catch (error) {
      this.log.error('knowledge.search failed', { error: error, query });
      return [];
    }
  }

  add(input: KnowledgeAddInput): KnowledgeEntry | null {
    if (!nativeKnowledge || !this.initialized) return null;
    try {
      const json = nativeKnowledge.nativeKnowledgeAdd({
        title: input.title,
        category: input.category,
        content: input.content,
        tags: input.tags?.join(',') ?? '',
        scope: input.scope ?? null,
        source: input.source ?? 'ai-learned',
        confidence: input.confidence ?? 0.7,
        status: input.status ?? (input.source === 'human' ? 'confirmed' : 'pending'),
      });
      return JSON.parse(json);
    } catch (error) {
      this.log.warn('knowledge.add failed (may be a duplicate)', {
        error: error,
        title: input.title,
      });
      return null;
    }
  }

  confirm(id: string): boolean {
    if (!nativeKnowledge || !this.initialized) return false;
    try {
      return nativeKnowledge.nativeKnowledgeConfirm(id);
    } catch (error) {
      this.log.error('knowledge.confirm failed', { error: error, id });
      return false;
    }
  }

  reject(id: string): boolean {
    if (!nativeKnowledge || !this.initialized) return false;
    try {
      return nativeKnowledge.nativeKnowledgeReject(id);
    } catch (error) {
      this.log.error('knowledge.reject failed', { error: error, id });
      return false;
    }
  }

  remove(id: string): boolean {
    if (!nativeKnowledge || !this.initialized) return false;
    try {
      return nativeKnowledge.nativeKnowledgeRemove(id);
    } catch (error) {
      this.log.error('knowledge.remove failed', { error: error, id });
      return false;
    }
  }

  stats(): KnowledgeStats {
    if (!nativeKnowledge || !this.initialized)
      return { total: 0, by_category: {}, by_source: {}, by_status: {}, avg_confidence: 0 };
    try {
      return JSON.parse(nativeKnowledge.nativeKnowledgeStats());
    } catch (error) {
      this.log.error('knowledge.stats failed', error);
      return { total: 0, by_category: {}, by_source: {}, by_status: {}, avg_confidence: 0 };
    }
  }

  importMarkdown(markdown: string): KnowledgeEntry[] {
    if (!nativeKnowledge || !this.initialized) return [];
    try {
      const json = nativeKnowledge.nativeKnowledgeImport(markdown);
      const parsed = JSON.parse(json) as
        | { entries: KnowledgeEntry[]; skipped: string[] }
        | KnowledgeEntry[];
      if (Array.isArray(parsed)) return parsed;
      if (parsed.skipped && parsed.skipped.length > 0) {
        this.log.warn('knowledge.importMarkdown skipped some entries', { skipped: parsed.skipped });
      }
      return parsed.entries ?? [];
    } catch (error) {
      this.log.error('knowledge.importMarkdown failed', error);
      return [];
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentKnowledgeService,
  AgentKnowledgeService,
  ScopeActivation.OnScopeCreated,
  'knowledge',
);
