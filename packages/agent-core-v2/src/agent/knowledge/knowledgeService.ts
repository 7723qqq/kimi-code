import { existsSync } from 'node:fs';

import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventBus } from '#/app/event/eventBus';
import { LifecycleScope } from '#/app/scopes';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import {
  IAgentKnowledgeService,
  type KnowledgeAddInput,
  type KnowledgeEntry,
  type KnowledgeSearchResult,
  type KnowledgeStats,
} from './knowledge';
import { KnowledgeInjection } from './knowledgeInjection';
import { KnowledgeLearner } from './knowledgeLearner';
import { isAvailable, KnowledgeDatabase } from './sqliteKnowledge';

export const INJECTION_CONFIDENCE_FLOOR = 0.5;

export class AgentKnowledgeService extends Disposable implements IAgentKnowledgeService {
  declare readonly _serviceBrand: undefined;

  private connection: KnowledgeDatabase | undefined;
  private currentDbPath: string | undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IEventBus eventBus: IEventBus,
    @IAgentContextMemoryService contextMemory: IAgentContextMemoryService,
    @IAgentReminderService private readonly reminders: IAgentReminderService,
    @ILogService private readonly log: ILogService,
    @ISessionContext private readonly session: ISessionContext,
  ) {
    super();
    if (!isAvailable()) {
      this.log.warn(
        'Knowledge database backend not available in this build — knowledge features disabled',
      );
    }
    this._register(
      toDisposable(() => {
        this.connection?.close();
        this.connection = undefined;
      }),
    );
    if (this.scopeContext.agentId === 'main') {
      this._register(new KnowledgeLearner(this, eventBus, contextMemory, this.log));
      this._register(new KnowledgeInjection(this, this.reminders, contextMemory));
    }
  }

  private get native(): KnowledgeDatabase {
    if (this.connection === undefined || this.connection.closed) {
      throw new Error('Knowledge database is not open');
    }
    return this.connection;
  }

  private ensureDatabase(): boolean {
    if (this.connection?.closed === false) return true;
    if (!isAvailable()) return false;
    if (this.currentDbPath !== undefined) return this.openAt(this.currentDbPath);
    const override = process.env['KIMI_KNOWLEDGE_DB'];
    if (override !== undefined && override.length > 0) return this.openAt(override);
    const projectDb = `${this.session.cwd || this.bootstrap.cwd}/.kimi-code/knowledge.db`;
    if (existsSync(projectDb) && this.openAt(projectDb)) return true;
    return this.openAt(`${this.bootstrap.homeDir}/knowledge.db`);
  }

  private openExisting(): boolean {
    if (this.connection?.closed === false) return true;
    if (!isAvailable()) return false;
    if (this.currentDbPath !== undefined) {
      return this.currentDbPath === ':memory:' || existsSync(this.currentDbPath)
        ? this.openAt(this.currentDbPath)
        : false;
    }
    const override = process.env['KIMI_KNOWLEDGE_DB'];
    if (override !== undefined && override.length > 0) {
      return existsSync(override) ? this.openAt(override) : false;
    }
    const projectDb = `${this.session.cwd || this.bootstrap.cwd}/.kimi-code/knowledge.db`;
    if (existsSync(projectDb)) return this.openAt(projectDb);
    const userDb = `${this.bootstrap.homeDir}/knowledge.db`;
    return existsSync(userDb) ? this.openAt(userDb) : false;
  }

  private openAt(path: string): boolean {
    if (!isAvailable()) return false;
    try {
      const candidate = new KnowledgeDatabase(path);
      const previous = this.connection;
      this.connection = candidate;
      this.currentDbPath = path;
      previous?.close();
      return true;
    } catch (error) {
      this.log.warn('failed to open knowledge database', { error, path });
      return false;
    }
  }

  open(projectDbPath: string, userDbPath: string): void {
    if (!isAvailable()) return;
    if (this.openAt(projectDbPath)) return;
    this.log.warn('open(projectDbPath) failed, trying userDbPath', { projectDbPath });
    if (!this.openAt(userDbPath)) {
      this.log.error('open() failed for both project and user DB paths', {
        projectDbPath,
        userDbPath,
      });
    }
  }

  search(query: string, scopePath?: string, tags?: string[], limit = 5): KnowledgeSearchResult[] {
    return this.searchDatabase(query, scopePath, tags, limit);
  }

  searchForInjection(
    query: string,
    scopePath?: string,
    tags?: string[],
    limit = 5,
  ): KnowledgeSearchResult[] {
    return this.searchDatabase(
      query,
      scopePath,
      tags,
      limit,
      this.session.cwd || this.bootstrap.cwd,
    );
  }

  private searchDatabase(
    query: string,
    scopePath: string | undefined,
    tags: string[] | undefined,
    limit: number,
    projectRoot?: string,
  ): KnowledgeSearchResult[] {
    if (!this.openExisting()) return [];
    try {
      const json = this.native.search(
        query,
        scopePath ?? null,
        tags?.join(',') ?? null,
        limit,
        INJECTION_CONFIDENCE_FLOOR,
        projectRoot,
      );
      const results: KnowledgeSearchResult[] = JSON.parse(json);
      return results.filter((r) => r.entry.confidence >= INJECTION_CONFIDENCE_FLOOR);
    } catch (error) {
      this.log.error('knowledge.search failed', { error, query });
      throw error;
    }
  }

  add(input: KnowledgeAddInput): KnowledgeEntry | null {
    if (!this.ensureDatabase()) return null;
    try {
      return JSON.parse(
        this.native.add(
          input.title,
          input.category,
          input.content,
          input.tags?.join(',') ?? '',
          input.scope ?? null,
          input.source ?? 'ai-learned',
          input.confidence ?? 0.7,
        ),
      );
    } catch (error) {
      this.log.warn('knowledge.add failed (may be a duplicate)', { error, title: input.title });
      return null;
    }
  }

  confirm(id: string): boolean {
    if (!this.ensureDatabase()) return false;
    try {
      return this.native.confirm(id);
    } catch (error) {
      this.log.error('knowledge.confirm failed', { error, id });
      return false;
    }
  }

  reject(id: string): boolean {
    return this.remove(id);
  }

  remove(id: string): boolean {
    if (!this.ensureDatabase()) return false;
    try {
      return this.native.remove(id);
    } catch (error) {
      this.log.error('knowledge.remove failed', { error, id });
      return false;
    }
  }

  stats(): KnowledgeStats {
    if (!this.openExisting())
      return { total: 0, by_category: {}, by_source: {}, avg_confidence: 0 };
    try {
      return JSON.parse(this.native.stats());
    } catch (error) {
      this.log.error('knowledge.stats failed', error);
      return { total: 0, by_category: {}, by_source: {}, avg_confidence: 0 };
    }
  }

  importMarkdown(markdown: string): KnowledgeEntry[] {
    if (!this.ensureDatabase()) return [];
    try {
      const parsed = JSON.parse(this.native.importMarkdown(markdown)) as
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
