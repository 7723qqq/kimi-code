import { existsSync } from 'node:fs';

import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventBus } from '#/app/event/eventBus';
import { LifecycleScope } from '#/app/scopes';
import { IAgentReminderService } from '#/features/reminder/reminderService';

import {
  IAgentKnowledgeService,
  type KnowledgeAddInput,
  type KnowledgeEntry,
  type KnowledgeSearchResult,
  type KnowledgeStats,
} from './knowledge';
import { KnowledgeInjection } from './knowledgeInjection';
import { KnowledgeLearner } from './knowledgeLearner';

interface NativeKnowledgeApi {
  knowledgeOpen(dbPath: string): void;
  knowledgeClose(dbPath?: string | null): void;
  knowledgeAdd(
    title: string,
    category: string,
    content: string,
    tags: string,
    scope: string | null | undefined,
    source: string,
    confidence: number,
  ): string;
  knowledgeSearch(
    query: string,
    scopePath: string | null | undefined,
    tags: string | null | undefined,
    limit: number,
    minConfidence: number,
  ): string;
  knowledgeRemove(id: string): boolean;
  knowledgeConfirm(id: string): boolean;
  knowledgeReject?(id: string): boolean;
  knowledgeStats(): string;
  knowledgeImport(markdown: string): string;
}

function hasKnowledgeApi(candidate: unknown): candidate is NativeKnowledgeApi {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const api = candidate as Record<string, unknown>;
  const required = [
    'knowledgeOpen',
    'knowledgeAdd',
    'knowledgeSearch',
    'knowledgeRemove',
    'knowledgeConfirm',
    'knowledgeStats',
    'knowledgeImport',
  ];
  return required.every((name) => typeof api[name] === 'function');
}

let nativeKnowledge: NativeKnowledgeApi | undefined;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded: unknown = require('@moonshot-ai/kimi-native-tools');
  nativeKnowledge = hasKnowledgeApi(loaded) ? loaded : undefined;
} catch (error) {
  void error;
  nativeKnowledge = undefined;
}

export const INJECTION_CONFIDENCE_FLOOR = 0.5;

export class AgentKnowledgeService extends Disposable implements IAgentKnowledgeService {
  declare readonly _serviceBrand: undefined;

  private initialized = false;
  private currentDbPath: string | null = null;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IEventBus eventBus: IEventBus,
    @IAgentContextMemoryService contextMemory: IAgentContextMemoryService,
    @IAgentReminderService private readonly reminders: IAgentReminderService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    if (!nativeKnowledge) {
      this.log.warn(
        'Knowledge native API not available in this build — knowledge features disabled',
      );
    }
    if (this.scopeContext.agentId === 'main') {
      this._register(new KnowledgeLearner(this, eventBus, contextMemory, this.log));
      this._register(new KnowledgeInjection(this, this.reminders, contextMemory));
    }
  }

  private get native(): NativeKnowledgeApi {
    if (nativeKnowledge === undefined) {
      throw new Error('knowledge database is not open');
    }
    return nativeKnowledge;
  }

  private ensureDatabase(): boolean {
    if (this.initialized) return true;
    if (!nativeKnowledge) return false;

    const override = process.env['KIMI_KNOWLEDGE_DB'];
    if (override !== undefined && override.length > 0) {
      return this.openAt(override);
    }

    const projectDb = `${this.bootstrap.cwd}/.kimi-code/knowledge.db`;
    if (existsSync(projectDb) && this.openAt(projectDb)) return true;

    const userDb = `${this.bootstrap.homeDir}/knowledge.db`;
    return this.openAt(userDb);
  }

  private openExisting(): boolean {
    if (this.initialized) return true;
    if (!nativeKnowledge) return false;

    const override = process.env['KIMI_KNOWLEDGE_DB'];
    if (override !== undefined && override.length > 0) {
      return existsSync(override) ? this.openAt(override) : false;
    }

    const projectDb = `${this.bootstrap.cwd}/.kimi-code/knowledge.db`;
    if (existsSync(projectDb)) return this.openAt(projectDb);

    const userDb = `${this.bootstrap.homeDir}/knowledge.db`;
    return existsSync(userDb) ? this.openAt(userDb) : false;
  }

  private openAt(path: string): boolean {
    if (!nativeKnowledge) return false;
    try {
      nativeKnowledge.knowledgeOpen(path);
      this.initialized = true;
      this.currentDbPath = path;
      return true;
    } catch (error) {
      this.log.warn('failed to open knowledge database', { error: error, path });
      return false;
    }
  }

  open(projectDbPath: string, userDbPath: string): void {
    if (!nativeKnowledge) return;
    try {
      if (this.currentDbPath !== null) {
        try {
          nativeKnowledge.knowledgeClose(this.currentDbPath);
        } catch {}
      }
      nativeKnowledge.knowledgeOpen(projectDbPath);
      this.initialized = true;
      this.currentDbPath = projectDbPath;
    } catch (error) {
      this.log.warn('open(projectDbPath) failed, trying userDbPath', {
        error: error,
        projectDbPath,
      });
      try {
        nativeKnowledge.knowledgeOpen(userDbPath);
        this.initialized = true;
        this.currentDbPath = userDbPath;
      } catch (error) {
        this.initialized = false;
        this.log.error('open() failed for both project and user DB paths', error);
      }
    }
  }

  search(query: string, scopePath?: string, tags?: string[], limit = 5): KnowledgeSearchResult[] {
    if (!this.openExisting()) return [];
    try {
      const tagsStr = tags?.join(',') ?? null;
      const json = this.native.knowledgeSearch(
        query,
        scopePath ?? null,
        tagsStr,
        limit,
        INJECTION_CONFIDENCE_FLOOR,
      );
      const results: KnowledgeSearchResult[] = JSON.parse(json);
      return results.filter((r) => r.entry.confidence >= INJECTION_CONFIDENCE_FLOOR);
    } catch (error) {
      this.log.error('knowledge.search failed', { error: error, query });
      return [];
    }
  }

  add(input: KnowledgeAddInput): KnowledgeEntry | null {
    if (!this.ensureDatabase()) return null;
    try {
      const json = this.native.knowledgeAdd(
        input.title,
        input.category,
        input.content,
        input.tags?.join(',') ?? '',
        input.scope ?? null,
        input.source ?? 'ai-learned',
        input.confidence ?? 0.7,
      );
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
    if (!this.ensureDatabase()) return false;
    try {
      return this.native.knowledgeConfirm(id);
    } catch (error) {
      this.log.error('knowledge.confirm failed', { error: error, id });
      return false;
    }
  }

  reject(id: string): boolean {
    if (!this.ensureDatabase()) return false;
    try {
      const api = this.native;
      const reject = api.knowledgeReject?.bind(api) ?? api.knowledgeRemove.bind(api);
      return reject(id);
    } catch (error) {
      this.log.error('knowledge.reject failed', { error: error, id });
      return false;
    }
  }

  remove(id: string): boolean {
    if (!this.ensureDatabase()) return false;
    try {
      return this.native.knowledgeRemove(id);
    } catch (error) {
      this.log.error('knowledge.remove failed', { error: error, id });
      return false;
    }
  }

  stats(): KnowledgeStats {
    if (!this.openExisting())
      return { total: 0, by_category: {}, by_source: {}, avg_confidence: 0 };
    try {
      return JSON.parse(this.native.knowledgeStats());
    } catch (error) {
      this.log.error('knowledge.stats failed', error);
      return { total: 0, by_category: {}, by_source: {}, avg_confidence: 0 };
    }
  }

  importMarkdown(markdown: string): KnowledgeEntry[] {
    if (!this.ensureDatabase()) return [];
    try {
      const json = this.native.knowledgeImport(markdown);
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
