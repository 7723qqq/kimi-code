import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface KnowledgeEntry {
  id: string;
  category: 'coding-style' | 'pitfall' | 'architecture' | 'workflow';
  title: string;
  content: string;
  tags: string[];
  scope: string | null;
  /**
   * Whether an entry counts as confirmed is expressed here rather than by a
   * `status` field: the store has no such column. `KnowledgeLearner` writes at
   * `LEARNED_CONFIDENCE`, `confirm()` raises it to 1.0, and `search` admits only
   * entries at or above `INJECTION_CONFIDENCE_FLOOR`.
   */
  confidence: number;
  source: 'human' | 'ai-learned' | 'ai-confirmed';
  created_at: string;
  updated_at: string;
}

export interface KnowledgeSearchResult {
  entry: KnowledgeEntry;
  relevance: number;
  match_source: string[];
}

export interface KnowledgeAddInput {
  title: string;
  category: 'coding-style' | 'pitfall' | 'architecture' | 'workflow';
  content: string;
  tags?: string[];
  scope?: string;
  source?: 'human' | 'ai-learned';
  confidence?: number;
}

export interface KnowledgeStats {
  total: number;
  by_category: Record<string, number>;
  by_source: Record<string, number>;
  avg_confidence: number;
}

export interface IAgentKnowledgeService {
  readonly _serviceBrand: undefined;

  open(projectDbPath: string, userDbPath: string): void;

  search(
    query: string,
    scopePath?: string,
    tags?: string[],
    limit?: number,
  ): KnowledgeSearchResult[];

  add(input: KnowledgeAddInput): KnowledgeEntry | null;

  confirm(id: string): boolean;

  remove(id: string): boolean;

  stats(): KnowledgeStats;

  importMarkdown(markdown: string): KnowledgeEntry[];
}

export const IAgentKnowledgeService: ServiceIdentifier<IAgentKnowledgeService> =
  createDecorator<IAgentKnowledgeService>('agentKnowledgeService');
