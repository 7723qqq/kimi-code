import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { AssociativeMemoryStore } from '#/features/associativeMemory/store';
import type { Atom, Concept, Edge, NoteRecord } from '#/features/associativeMemory/types';

function note(id: string, scopeKey: string, text: string): NoteRecord {
  return { id, scopeKey, text, atomIds: [`atom:${id}:0`], createdAt: 1 };
}

function atom(id: string, scopeKey: string, noteId: string, text: string): Atom {
  return {
    id,
    noteId,
    scopeKey,
    nodeType: 'atom',
    text,
    terms: [text],
    vector: { [text]: 1 },
    denseVector: undefined,
    conceptId: undefined,
    baseWeight: 1,
    confidence: 1,
    replayPriority: 0,
    pinned: false,
    suppressed: false,
    validFrom: 1,
    validUntil: undefined,
    isDeleted: false,
    createdAt: 1,
    lastActivatedAt: 1,
  };
}

function edge(id: string, from: string, to: string): Edge {
  return {
    id,
    from,
    to,
    kind: 'hebbian',
    weight: 1,
    strengthenCount: 1,
    validFrom: 1,
    validUntil: undefined,
    createdAt: 1,
    lastUsedAt: 1,
  };
}

function concept(id: string, scopeKey: string): Concept {
  return {
    id,
    scopeKey,
    nodeType: 'concept',
    label: id,
    labelSource: 'deterministic_v1',
    terms: [],
    vector: {},
    denseVector: undefined,
    atomIds: [],
    load: 0,
    readiness: 1,
    pinned: false,
    suppressed: false,
    validFrom: 1,
    validUntil: undefined,
    createdAt: 1,
    lastActivatedAt: 1,
  };
}

describe('AssociativeMemoryStore', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(join(os.tmpdir(), 'associative-memory-store-'));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('persists notes, atoms, concepts and edges', async () => {
    const store = await AssociativeMemoryStore.open('proj-a', root);
    await store.putNote(note('n1', 'proj-a', 'hello'));
    await store.putAtom(atom('a1', 'proj-a', 'n1', 'hello'));
    await store.putConcept(concept('c1', 'proj-a'));
    await store.putEdge(edge('a1>a2', 'a1', 'a2'));
    await store.close();

    const reopened = await AssociativeMemoryStore.open('proj-a', root);
    expect(reopened.listNotes().map((n) => n.id)).toEqual(['n1']);
    expect(reopened.listAtoms().map((a) => a.id)).toEqual(['a1']);
    expect(reopened.listConcepts().map((c) => c.id)).toEqual(['c1']);
    expect(reopened.listEdges().map((e) => e.id)).toEqual(['a1>a2']);
    await reopened.close();
  });

  it('isolates projects by scope key', async () => {
    const a = await AssociativeMemoryStore.open('proj-a', root);
    await a.putNote(note('n1', 'proj-a', 'hello'));
    const b = await AssociativeMemoryStore.open('proj-b', root);
    await b.putNote(note('n2', 'proj-b', 'world'));

    expect(a.listNotes().map((n) => n.id)).toEqual(['n1']);
    expect(b.listNotes().map((n) => n.id)).toEqual(['n2']);
    await a.close();
    await b.close();
  });

  it('clearGraph drops derived records but keeps notes', async () => {
    const store = await AssociativeMemoryStore.open('proj-a', root);
    await store.putNote(note('n1', 'proj-a', 'hello'));
    await store.putAtom(atom('a1', 'proj-a', 'n1', 'hello'));
    await store.putEdge(edge('a1>a2', 'a1', 'a2'));

    await store.clearGraph();

    expect(store.listAtoms()).toEqual([]);
    expect(store.listEdges()).toEqual([]);
    expect(store.listNotes().map((n) => n.id)).toEqual(['n1']);
    await store.close();
  });
});
