Record experience into a self-training associative memory and recall it by association.

The memory encodes what you write into atomic units, learns weighted associations
between them, and injects related memories into the context as the conversation moves.
A given memory is surfaced once per session and then held back until the next
session, so the context is not flooded with the same lines. Writing a
note trains the memory: the new atoms are linked to whatever the note reminds the
memory of, a surfaced memory keeps its recency, and associations that are used
survive while unused ones fade.

## What recall can and cannot do

`recall` matches on the words in the cue: terms you write are what later lookups
must share. A cue phrased with completely different words ("ship a build" for a
note about a deploy rollout) shares no terms and will not reach the note, unless
an embedding provider is configured, in which case paraphrase matches also work.
Write the words you would search for, or repeat the note's own vocabulary in the
cue, instead of assuming the memory knows synonyms.

Diversity is capped before `limit` applies: at most three distinct notes surface
per scope, so a larger `limit` returns at most three note items (concepts can add
to that count). Raise the cue's precision instead of raising `limit`.

A concept is a compression node: several atoms that keep appearing together are
summarised as one labelled node, and that node can be recalled, labelled and
pinned. It does not outrank the atoms it summarises — when a cue points at one
member, you get the atom; spread cues return both, with the atoms first.

This graph is separate from the `Memory` markdown store, and recall is not unified:
`recall` here searches the graph only, while markdown memories are searched with
`Memory({ action: "search" })`. Writing here does not create a markdown file, and
writing through `Memory` does not train this graph.

## Actions

### `write`
Record a note. The note is split into atomic units and trained into the graph.
Write what is worth remembering: decisions, lessons, patterns, references.
Do not write credentials or private keys; the memory code blocks them.
Writing a note whose terms already exist is a no-op: it refreshes that note's
recency instead of storing a second copy. Terms are compared as a set, so a note
that only reorders the same words counts as the same memory (`"A before B"` and
`"B before A"` collide); say it with one different word when the order carries
meaning.
```
MemoryGraph({ action: "write", text: "The auth service retries twice before failing." })
```

### `recall`
Ask the memory what is related to a cue. Returns the top associated atoms and
concepts with their activation scores.
```
MemoryGraph({ action: "recall", query: "how does auth retry?" })
```

### `pin`
Mark an atom or concept as important so it does not decay.
```
MemoryGraph({ action: "pin", id: "<atom id>" })
```

### `forget`
Soft-delete an atom or concept. It stops matching recall and its associations are
removed, so it no longer votes on what is related; a forgotten atom keeps a
tombstone that history recall (`includeHistory`) can still show. Forgetting an atom
also drops any concept or procedure that contained it.
```
MemoryGraph({ action: "forget", id: "<atom id>" })
```

### `list`
List what the memory holds, most recently activated first. Use `kind` to show atoms,
concepts, or procedures.
```
MemoryGraph({ action: "list", kind: "concept", limit: 10 })
```

### `export`
Write every atom, concept, procedure, edge, and note in the selected scope to
`memory-export.json` in the working directory, and return the path.
```
MemoryGraph({ action: "export", scope: "all" })
```

### `replay`
Re-consolidate the memories that were flagged as contradicted, highest priority first.
A memory is flagged when `reconsolidate` supersedes it, or when a write supersedes it as
a near-duplicate; the write path needs two notes that share nearly every term, so in most
stores only `reconsolidate` produces candidates and otherwise this returns `replayed: 0`.
It strengthens edges between the flagged atoms, refreshes their recency, and lowers each
priority by one. It never un-suppresses them, so a flagged memory stays out of `recall`
unless you pass `includeHistory`. It reads the project scope only.
```
MemoryGraph({ action: "replay", limit: 5 })
```

### `propose` / `approve`
Suggest a new memory-code rule, then have the user approve it. `propose` takes a JSON rule
object; `approve` takes the proposal index and appends the rule to the memory code file.
```
MemoryGraph({ action: "propose", rule: "{\"id\":\"no-hosts\",\"pattern\":\"internal.example.com\",\"action\":\"block_write\",\"scope\":\"note\",\"reason\":\"internal host\"}" })
MemoryGraph({ action: "approve", index: 0 })
```

### `label`
Replace a concept's deterministic label with one you wrote after reading its members.
```
MemoryGraph({ action: "label", id: "<concept id>", label: "auth retry policy" })
```

### `reconsolidate`
Write new evidence back onto a memory you just recalled, correcting or extending it. With no
`id`, it targets the most recent recall. When the evidence contradicts the target, the target is
superseded (kept for audit, hidden from recall) rather than deleted.
```
MemoryGraph({ action: "reconsolidate", id: "<atom id>", text: "the cache ttl is 60 seconds" })
```

### `audit`
Show the audit log, newest first: blocked writes, filtered recalls, pins, forgets, supersedes,
embeddings decisions, replays, code proposals.
```
MemoryGraph({ action: "audit", limit: 20 })
```

### `stats`
Counts for a scope: atoms, concepts, procedures, edges, notes, pinned, suppressed.
Forgotten memories are excluded from every count; `suppressed` covers atoms that were
superseded or retired by the atom budget.
```
MemoryGraph({ action: "stats", scope: "all" })
```

### `explain`
Show the recall trace for a cue: seed nodes, how activation spread, and which nodes were
inhibited or truncated. Use it to find out why something was or was not recalled.
```
MemoryGraph({ action: "explain", query: "cache ttl" })
```

### `rebuild`
Replay every note in a scope through the encoder and trainer to rebuild the graph from
scratch. Useful after editing the code file or repairing a damaged store.
```
MemoryGraph({ action: "rebuild", scope: "all" })
```

## Scopes

Writes default to the current project. Pass `scope: "global"` to record something that
should hold across projects, and `scope: "all"` to read both.

## Procedures

When the same multi-step pattern recurs across notes, the memory distills it into a
procedure you can recall directly — a reusable "how to" rather than a fact.

## When to use

- After learning something that will matter again — write it.
- When a task resembles something you have seen before — recall it.
- When the memory surfaces something you know to be wrong — forget it.
