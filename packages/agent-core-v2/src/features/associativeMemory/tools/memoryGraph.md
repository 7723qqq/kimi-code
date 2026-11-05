Record experience into a self-training associative memory and recall it by association.

The memory encodes what you write into atomic units, learns weighted associations
between them, and injects related memories into the context on each turn. Writing a
note trains the memory: the new atoms are linked to whatever the note reminds the
memory of, and associations that are used survive while unused ones fade.

## Actions

### `write`
Record a note. The note is split into atomic units and trained into the graph.
Write what is worth remembering: decisions, lessons, patterns, references.
Do not write credentials or private keys; the memory code blocks them.
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
Soft-delete an atom or concept. It is hidden from recall but kept for audit.
```
MemoryGraph({ action: "forget", id: "<atom id>" })
```

### `list`
List what the memory holds, newest first. Use `kind` to show atoms, concepts, or procedures.
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
Re-consolidate the memories that were contradicted (their prediction was wrong), highest
priority first. Call this after a correction to strengthen the surrounding associations.
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
