interface ShapeInput {
  readonly body: string;
  readonly nextPage?: boolean;
}

type Json = Record<string, unknown>;

const decoder = new TextDecoder();

function asRecord(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function text(value: unknown, limit?: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return limit === undefined || trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function labelsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value
    .map((label) => (typeof label === 'string' ? label : text(asRecord(label)?.['name'])))
    .filter((name): name is string => name !== undefined);
  return names.length > 0 ? names.slice(0, 12) : undefined;
}

function userOf(source: Json | undefined): string | undefined {
  return text(asRecord(source?.['user'])?.['login']) ?? text(source?.['login']);
}

export interface ProjectionOptions {
  readonly total?: number;
  readonly nextPage?: boolean;
  readonly limit?: number;
}

export function projectItems(
  items: readonly unknown[],
  project: (item: Json) => Json,
  options: ProjectionOptions = {},
): string {
  const limit = options.limit ?? items.length;
  const shown = items.slice(0, limit);
  const header: Json = { items: items.length };
  if (options.total !== undefined) header['total'] = options.total;
  if (options.nextPage === true) header['has_more'] = true;
  const lines = [JSON.stringify(header)];
  for (const item of shown) {
    const record = asRecord(item);
    if (record === undefined) continue;
    try {
      lines.push(JSON.stringify(project(record)));
    } catch {
      continue;
    }
  }
  return lines.join('\n');
}

export function projectIssue(item: Json): Json {
  const out: Json = {
    number: num(item['number']),
    title: text(item['title'], 200),
    state: text(item['state']),
    user: userOf(item),
    labels: labelsOf(item['labels']),
    comments: num(item['comments']),
    updated_at: text(item['updated_at']),
    is_pr: item['pull_request'] !== undefined ? true : undefined,
    url: text(item['html_url']),
  };
  return prune(out);
}

export function projectIssueDetail(item: Json): Json {
  return prune({ ...projectIssue(item), body: text(item['body'], 4000) });
}

export function projectPullDetail(item: Json): Json {
  return prune({
    ...projectPull(item),
    body: text(item['body'], 4000),
    merged: item['merged'] === true ? true : undefined,
    additions: num(item['additions']),
    deletions: num(item['deletions']),
    changed_files: num(item['changed_files']),
    commits: num(item['commits']),
  });
}

export function projectCommitDetail(item: Json): Json {
  const commit = asRecord(item['commit']);
  const stats = asRecord(item['stats']);
  const files = Array.isArray(item['files']) ? item['files'] : [];
  const shown = files.slice(0, 100).map((file) => projectPullFile(asRecord(file) ?? {}));
  return prune({
    sha: text(item['sha']),
    message: text(commit?.['message'], 2000),
    author: text(asRecord(commit?.['author'])?.['name']),
    stats: stats === undefined ? undefined : prune({ additions: num(stats['additions']), deletions: num(stats['deletions']), total: num(stats['total']) }),
    files: shown.length,
    changed: shown,
    more_files: files.length > shown.length ? files.length - shown.length : undefined,
  });
}

export function shapeObject(body: string, project: (item: Json) => Json): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  return record === undefined ? undefined : JSON.stringify(project(record));
}

export function projectIssueSearch(item: Json): Json {
  const repo = text(item['repository_url']);
  return prune({
    ...projectIssue(item),
    repo: repo?.replace('https://api.github.com/repos/', ''),
  });
}

export function projectPull(item: Json): Json {
  const head = asRecord(item['head']);
  const base = asRecord(item['base']);
  return prune({
    number: num(item['number']),
    title: text(item['title'], 200),
    state: text(item['state']),
    draft: item['draft'] === true ? true : undefined,
    user: userOf(item),
    head: text(head?.['ref']),
    base: text(base?.['ref']),
    comments: num(item['comments']),
    updated_at: text(item['updated_at']),
    url: text(item['html_url']),
  });
}

export function projectBranch(item: Json): Json {
  return prune({
    name: text(item['name']),
    sha: text(asRecord(item['commit'])?.['sha']),
    protected: item['protected'] === true ? true : undefined,
  });
}

export function projectCommit(item: Json): Json {
  const commit = asRecord(item['commit']);
  const author = asRecord(commit?.['author']);
  return prune({
    sha: text(item['sha']),
    author: text(author?.['name']),
    date: text(author?.['date']),
    message: text(commit?.['message'])?.split('\n')[0],
    url: text(item['html_url']),
  });
}

export function projectComment(item: Json): Json {
  return prune({
    id: num(item['id']),
    user: userOf(item),
    created_at: text(item['created_at']),
    path: text(item['path']),
    body: text(item['body'], 300),
    url: text(item['html_url']),
  });
}

export function projectPullFile(item: Json): Json {
  return prune({
    filename: text(item['filename']),
    status: text(item['status']),
    additions: num(item['additions']),
    deletions: num(item['deletions']),
    changes: num(item['changes']),
  });
}

export function projectRelease(item: Json): Json {
  return prune({
    tag: text(item['tag_name']),
    name: text(item['name'], 120),
    draft: item['draft'] === true ? true : undefined,
    prerelease: item['prerelease'] === true ? true : undefined,
    published_at: text(item['published_at']),
    url: text(item['html_url']),
  });
}

export function projectWorkflowRun(item: Json): Json {
  return prune({
    id: num(item['id']),
    name: text(item['name'], 120),
    status: text(item['status']),
    conclusion: text(item['conclusion']),
    branch: text(item['head_branch']),
    run_number: num(item['run_number']),
    created_at: text(item['created_at']),
    url: text(item['html_url']),
  });
}

export function projectWorkflowJob(item: Json): Json {
  return prune({
    id: num(item['id']),
    name: text(item['name'], 120),
    status: text(item['status']),
    conclusion: text(item['conclusion']),
    started_at: text(item['started_at']),
    url: text(item['html_url']),
  });
}

export function projectCheckRun(item: Json): Json {
  return prune({
    name: text(item['name'], 120),
    status: text(item['status']),
    conclusion: text(item['conclusion']),
    started_at: text(item['started_at']),
    url: text(item['html_url']),
  });
}

export function projectTreeEntry(item: Json): Json {
  const type = text(item['type']);
  return prune({
    path: text(item['path']),
    type,
    size: type === 'blob' ? num(item['size']) : undefined,
  });
}

export function projectCodeSearch(item: Json): Json {
  const matches = Array.isArray(item['text_matches']) ? item['text_matches'] : [];
  const first = asRecord(matches[0]);
  return prune({
    path: text(item['path']),
    repo: text(asRecord(item['repository'])?.['full_name']),
    fragment: text(first?.['fragment'], 200),
    url: text(item['html_url']),
  });
}

export function projectRepoSearch(item: Json): Json {
  return prune({
    full_name: text(item['full_name']),
    description: text(item['description'], 160),
    stars: num(item['stargazers_count']),
    language: text(item['language']),
    updated_at: text(item['updated_at']),
    url: text(item['html_url']),
  });
}

function prune(record: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function shapeArray(body: string, project: (item: Json) => Json, options: ProjectionOptions = {}): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  return projectItems(parsed, project, options);
}

export function shapeWrappedList(
  body: string,
  key: string,
  project: (item: Json) => Json,
  input: ShapeInput,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  const items = record?.[key];
  if (record === undefined || !Array.isArray(items)) return undefined;
  return projectItems(items, project, {
    total: num(record['total_count']),
    nextPage: input.nextPage === true,
  });
}

export function shapeSearch(body: string, project: (item: Json) => Json, input: ShapeInput): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  if (record === undefined || !Array.isArray(record['items'])) return undefined;
  return projectItems(record['items'], project, {
    total: num(record['total_count']),
    nextPage: input.nextPage === true,
  });
}

export function projectTreeListing(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  const tree = record?.['tree'];
  if (record === undefined || !Array.isArray(tree)) return undefined;
  const truncated = record['truncated'] === true;
  const limit = 3000;
  const header = prune({
    entries: tree.length,
    shown: Math.min(limit, tree.length),
    truncated: truncated || tree.length > limit ? true : undefined,
    sha: text(record['sha']),
  });
  const lines = [JSON.stringify(header)];
  for (const entry of tree.slice(0, limit)) {
    const item = asRecord(entry);
    if (item !== undefined) lines.push(JSON.stringify(projectTreeEntry(item)));
  }
  return lines.join('\n');
}

const MAX_TEXT_CHARS = 40_000;

export function projectFileContents(body: string, maxChars: number): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (Array.isArray(parsed)) {
    return projectItems(parsed, (item) =>
      prune({
        type: text(item['type']),
        name: text(item['name']),
        size: num(item['size']),
        sha: text(item['sha']),
      }),
    );
  }
  const record = asRecord(parsed);
  if (record === undefined) return undefined;
  const path = text(record['path']) ?? '';
  const sha = text(record['sha']);
  const size = num(record['size']);
  const header = prune({
    path,
    sha,
    size,
    type: text(record['type']),
    download_url: text(record['download_url']),
  });
  if (record['encoding'] !== 'base64' || typeof record['content'] !== 'string') {
    return JSON.stringify(header);
  }
  const decoded = decodeBase64(record['content']);
  if (decoded === undefined) return JSON.stringify({ ...header, encoding: 'base64', decoded: false });
  if (decoded.binary) {
    return JSON.stringify({
      ...header,
      binary: true,
      bytes: decoded.bytes.length,
      note: 'binary file, contents not shown',
    });
  }
  const cap = Math.max(1, Math.min(maxChars, MAX_TEXT_CHARS));
  const clipped =
    decoded.text.length <= cap
      ? decoded.text
      : `${decoded.text.slice(0, cap)}\n[...truncated ${String(decoded.text.length - cap)} characters]`;
  return `${JSON.stringify(header)}\n---\n${clipped}`;
}

function decodeBase64(content: string): { text: string; binary: false; bytes: Uint8Array } | { binary: true; bytes: Uint8Array } | undefined {
  let bytes: Uint8Array;
  try {
    bytes = Buffer.from(content.replaceAll('\n', ''), 'base64');
  } catch {
    return undefined;
  }
  const probe = bytes.subarray(0, Math.min(bytes.byteLength, 8192));
  for (const byte of probe) {
    if (byte === 0) return { binary: true, bytes };
  }
  return { text: decoder.decode(bytes), binary: false, bytes };
}
