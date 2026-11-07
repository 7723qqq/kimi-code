import type { AssociativeMemoryParams, RecallTraceNode } from './types';

export interface SchemaLink {
  readonly from: string;
  readonly to: string;
  readonly hops: number;
}

export function collectSchemaLinks(
  trace: readonly RecallTraceNode[],
  params: AssociativeMemoryParams,
): readonly SchemaLink[] {
  const parents = new Map<string, string>();
  const seeds = new Set<string>();
  for (const node of trace) {
    if (node.kind === 'seed') seeds.add(node.id);
    else if (node.kind === 'spread' && node.viaEdge !== undefined) {
      parents.set(node.id, node.viaEdge.from);
    }
  }
  const links: SchemaLink[] = [];
  const seen = new Set<string>();
  for (const node of trace) {
    if (node.kind !== 'spread') continue;
    let current = node.id;
    let hops = 0;
    while (hops <= params.spreadHops + 1) {
      const parent = parents.get(current);
      if (parent === undefined) break;
      hops += 1;
      if (seeds.has(parent)) {
        const key = `${parent}?${node.id}`;
        if (hops >= params.schemaMinHops && !seen.has(key)) {
          seen.add(key);
          links.push({ from: parent, to: node.id, hops });
        }
        break;
      }
      current = parent;
    }
  }
  return links
    .toSorted((left, right) => left.hops - right.hops || (left.to < right.to ? -1 : 1))
    .slice(0, params.schemaTopK);
}
