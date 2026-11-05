export type NodeType = 'atom' | 'concept' | 'procedure';

export type EdgeKind =
  | 'hebbian'
  | 'cooccurrence'
  | 'concept'
  | 'supersede'
  | 'inhibits'
  | 'procedure';

export type LabelSource = 'deterministic_v1' | 'llm';

export interface Atom {
  readonly id: string;
  readonly noteId: string;
  readonly scopeKey: string;
  readonly nodeType: 'atom';
  readonly text: string;
  readonly terms: readonly string[];
  readonly vector: Readonly<Record<string, number>>;
  readonly denseVector: readonly number[] | undefined;
  readonly conceptId: string | undefined;
  readonly baseWeight: number;
  readonly confidence: number;
  readonly replayPriority: number;
  readonly pinned: boolean;
  readonly suppressed: boolean;
  readonly validFrom: number;
  readonly validUntil: number | undefined;
  readonly isDeleted: boolean;
  readonly createdAt: number;
  readonly lastActivatedAt: number;
}

export interface Concept {
  readonly id: string;
  readonly scopeKey: string;
  readonly nodeType: 'concept';
  readonly label: string;
  readonly labelSource: LabelSource;
  readonly terms: readonly string[];
  readonly vector: Readonly<Record<string, number>>;
  readonly denseVector: readonly number[] | undefined;
  readonly atomIds: readonly string[];
  readonly load: number;
  readonly readiness: number;
  readonly pinned: boolean;
  readonly suppressed: boolean;
  readonly validFrom: number;
  readonly validUntil: number | undefined;
  readonly createdAt: number;
  readonly lastActivatedAt: number;
}

export interface Procedure {
  readonly id: string;
  readonly scopeKey: string;
  readonly label: string;
  readonly terms: readonly string[];
  readonly vector: Readonly<Record<string, number>>;
  readonly stepIds: readonly string[];
  readonly sourceNoteId: string;
  readonly frequency: number;
  readonly pinned: boolean;
  readonly suppressed: boolean;
  readonly createdAt: number;
  readonly lastActivatedAt: number;
}

export interface Edge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  readonly weight: number;
  readonly strengthenCount: number;
  readonly validFrom: number;
  readonly validUntil: number | undefined;
  readonly createdAt: number;
  readonly lastUsedAt: number;
}

export interface NoteRecord {
  readonly id: string;
  readonly scopeKey: string;
  readonly text: string;
  readonly atomIds: readonly string[];
  readonly createdAt: number;
}

export interface Cooccurrence {
  readonly key: string;
  readonly a: string;
  readonly b: string;
  readonly count: number;
  readonly lastAt: number;
}

export type MemoryEvent =
  | { readonly kind: 'note'; readonly noteId: string; readonly scopeKey: string; readonly text: string; readonly at: number }
  | { readonly kind: 'supersede'; readonly fromId: string; readonly toId: string; readonly at: number }
  | { readonly kind: 'forget'; readonly id: string; readonly at: number }
  | { readonly kind: 'pin'; readonly id: string; readonly at: number };

export interface WriteResult {
  readonly noteId: string;
  readonly atomIds: readonly string[];
  readonly blockedByCode: boolean;
  readonly scope: MemoryScopeSelector;
}

export type MemoryScopeSelector = 'project' | 'global' | 'all';

export interface RecallQuery {
  readonly cue: string;
  readonly limit: number | undefined;
  readonly maxTokens: number | undefined;
  readonly includeHistory: boolean;
  readonly scope?: MemoryScopeSelector;
}

export interface RecallItem {
  readonly id: string;
  readonly kind: 'atom' | 'concept' | 'procedure';
  readonly text: string;
  readonly score: number;
  readonly noteId: string;
  readonly conceptId: string | undefined;
  readonly confidence: number;
  readonly validFrom: number;
  readonly validUntil: number | undefined;
  readonly conflictGroup: string | undefined;
}

export interface RecallTraceNode {
  readonly id: string;
  readonly kind: 'seed' | 'spread' | 'inhibit';
  readonly score: number;
  readonly viaEdge:
    | { readonly from: string; readonly weight: number; readonly decayed: number }
    | undefined;
  readonly truncated: boolean;
}

export interface RecallResult {
  readonly items: readonly RecallItem[];
  readonly trace: readonly RecallTraceNode[];
}

export interface AssociativeMemoryStats {
  readonly atoms: number;
  readonly concepts: number;
  readonly procedures: number;
  readonly edges: number;
  readonly notes: number;
  readonly suppressed: number;
  readonly pinned: number;
}

export interface AssociativeMemoryList {
  readonly atoms: readonly Atom[];
  readonly concepts: readonly Concept[];
  readonly procedures: readonly Procedure[];
}

export interface ListOptions {
  readonly kind?: 'atom' | 'concept' | 'procedure';
  readonly limit?: number;
  readonly scope?: MemoryScopeSelector;
}

export interface AssociativeMemoryExport {
  readonly path: string;
  readonly atoms: number;
  readonly concepts: number;
  readonly notes: number;
}

export interface ReplayResult {
  readonly replayed: number;
}

export interface ReconsolidateResult {
  readonly noteId: string;
  readonly atomIds: readonly string[];
  readonly superseded: boolean;
}

export interface AssociativeMemoryParams {
  readonly maxAtomChars: number;
  readonly contextWindowMs: number;
  readonly baseLearningRate: number;
  readonly outWeightBudget: number;
  readonly maxEdgeWeight: number;
  readonly spreadHops: number;
  readonly spreadDecay: number;
  readonly inhibitionFactor: number;
  readonly baseK: number;
  readonly kDecay: number;
  readonly computeBudget: number;
  readonly seedTopM: number;
  readonly episodeTopN: number;
  readonly listLimit: number;
  readonly topK: number;
  readonly activationThreshold: number;
  readonly vectorThreshold: number;
  readonly clusterCoocThreshold: number;
  readonly clusterMinSize: number;
  readonly clusterMaxSize: number;
  readonly procedureMinSteps: number;
  readonly procedureThreshold: number;
  readonly loadRef: number;
  readonly conceptFormationRate: number;
  readonly powerLawDays: number;
  readonly halfLifeMs: number;
  readonly pruneThreshold: number;
  readonly injectionMaxTokens: number;
  readonly supersedeThreshold: number;
}

export type CodeAction = 'block_write' | 'block_recall' | 'pin' | 'supersede' | 'block_embed';

export type CodeScope = 'note' | 'atom' | 'recall';

export interface HardRule {
  readonly id: string;
  readonly pattern: string;
  readonly regex: boolean;
  readonly action: CodeAction;
  readonly scope: CodeScope;
  readonly reason: string;
}

export interface MemoryCode {
  readonly rules: readonly HardRule[];
  readonly guidance: string;
}
