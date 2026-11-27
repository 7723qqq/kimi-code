import type { WebSearchResult, WebSearchScope } from '#/agent/tools/web-search/web-search';

import type { SearchEngineFn, SearchEngineOptions } from './types';

const DEFAULT_HEADERS = {
  'User-Agent': 'kimi-code/1.0 (https://github.com/MoonshotAI/kimi-code)',
  Accept: 'application/json',
};

function decodeXmlEntities(text: string): string {
  return text
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'");
}

function stripTags(htmlOrXml: string): string {
  return decodeXmlEntities(htmlOrXml.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateSnippet(text: string, maxLength = 360): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1)}…`;
}

function extractXmlTag(block: string, tag: string): string {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return match?.[1] !== undefined ? stripTags(match[1]) : '';
}

async function fetchJson(
  url: string,
  options: SearchEngineOptions | undefined,
  extraHeaders: Record<string, string> = {},
): Promise<unknown> {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { ...DEFAULT_HEADERS, ...extraHeaders },
    signal: options?.signal,
  } as RequestInit);
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)} ${response.statusText} from ${url}`);
  }
  return response.json();
}

async function fetchText(
  url: string,
  options: SearchEngineOptions | undefined,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { ...DEFAULT_HEADERS, ...extraHeaders },
    signal: options?.signal,
  } as RequestInit);
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)} ${response.statusText} from ${url}`);
  }
  return response.text();
}

export const searchArxiv: SearchEngineFn = async (query, limit, options) => {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${String(limit)}`;
  const xml = await fetchText(url, options, { Accept: 'application/atom+xml, application/xml, text/xml' });
  const results: WebSearchResult[] = [];
  const entryPattern = /<entry>([\s\S]*?)<\/entry>/gi;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(xml)) !== null && results.length < limit) {
    const entry = match[1] ?? '';
    const title = extractXmlTag(entry, 'title');
    const idUrl = extractXmlTag(entry, 'id');
    const summary = extractXmlTag(entry, 'summary');
    const published = extractXmlTag(entry, 'published');
    if (title.length === 0 || idUrl.length === 0) continue;
    const result: WebSearchResult = {
      title,
      url: idUrl,
      snippet: truncateSnippet(summary),
      siteName: 'arXiv',
    };
    if (published.length >= 10) result.date = published.slice(0, 10);
    results.push(result);
  }
  return results;
};

function reconstructOpenAlexAbstract(invertedIndex: Record<string, number[]> | null | undefined): string {
  if (invertedIndex === null || invertedIndex === undefined || typeof invertedIndex !== 'object') {
    return '';
  }
  const positioned: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      if (typeof pos === 'number') positioned.push([pos, word]);
    }
  }
  positioned.sort((a, b) => a[0] - b[0]);
  return positioned.map(([, word]) => word).join(' ');
}

export const searchOpenAlex: SearchEngineFn = async (query, limit, options) => {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${String(limit)}`;
  const payload = (await fetchJson(url, options)) as {
    results?: Array<{
      id?: string;
      doi?: string;
      display_name?: string;
      publication_date?: string;
      cited_by_count?: number;
      abstract_inverted_index?: Record<string, number[]>;
      primary_location?: {
        landing_page_url?: string;
        source?: { display_name?: string };
      };
    }>;
  };
  const items = Array.isArray(payload.results) ? payload.results : [];
  const results: WebSearchResult[] = [];
  for (const work of items.slice(0, limit)) {
    const title = (work.display_name ?? '').trim();
    const targetUrl =
      work.primary_location?.landing_page_url ?? work.doi ?? work.id ?? '';
    if (title.length === 0 || targetUrl.length === 0) continue;
    const abstractText = reconstructOpenAlexAbstract(work.abstract_inverted_index);
    const citationNote =
      typeof work.cited_by_count === 'number'
        ? `Cited by ${String(work.cited_by_count)}. `
        : '';
    const snippet = truncateSnippet(`${citationNote}${abstractText}`.trim());
    const result: WebSearchResult = {
      title,
      url: targetUrl,
      snippet: snippet.length > 0 ? snippet : title,
      siteName: work.primary_location?.source?.display_name ?? 'OpenAlex',
    };
    if (typeof work.publication_date === 'string' && work.publication_date.length > 0) {
      result.date = work.publication_date;
    }
    results.push(result);
  }
  return results;
};

export const searchSemanticScholar: SearchEngineFn = async (query, limit, options) => {
  const fields = 'title,url,abstract,year,publicationDate,venue,citationCount,externalIds';
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${String(limit)}&fields=${fields}`;
  const payload = (await fetchJson(url, options)) as {
    data?: Array<{
      paperId?: string;
      title?: string;
      url?: string;
      abstract?: string;
      year?: number;
      publicationDate?: string;
      venue?: string;
      citationCount?: number;
      externalIds?: { DOI?: string; ArXiv?: string };
    }>;
  };
  const items = Array.isArray(payload.data) ? payload.data : [];
  const results: WebSearchResult[] = [];
  for (const paper of items.slice(0, limit)) {
    const title = (paper.title ?? '').trim();
    const fallbackUrl =
      paper.externalIds?.ArXiv !== undefined
        ? `https://arxiv.org/abs/${paper.externalIds.ArXiv}`
        : paper.externalIds?.DOI !== undefined
          ? `https://doi.org/${paper.externalIds.DOI}`
          : paper.paperId !== undefined
            ? `https://www.semanticscholar.org/paper/${paper.paperId}`
            : '';
    const targetUrl = (paper.url ?? '').trim() || fallbackUrl;
    if (title.length === 0 || targetUrl.length === 0) continue;
    const citations =
      typeof paper.citationCount === 'number' ? `Citations: ${String(paper.citationCount)}. ` : '';
    const snippet = truncateSnippet(`${citations}${paper.abstract ?? ''}`.trim());
    const result: WebSearchResult = {
      title,
      url: targetUrl,
      snippet: snippet.length > 0 ? snippet : title,
      siteName: paper.venue !== undefined && paper.venue.length > 0 ? paper.venue : 'Semantic Scholar',
    };
    if (typeof paper.publicationDate === 'string' && paper.publicationDate.length > 0) {
      result.date = paper.publicationDate;
    } else if (typeof paper.year === 'number') {
      result.date = String(paper.year);
    }
    results.push(result);
  }
  return results;
};

export const searchCrossref: SearchEngineFn = async (query, limit, options) => {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${String(limit)}`;
  const payload = (await fetchJson(url, options)) as {
    message?: {
      items?: Array<{
        URL?: string;
        DOI?: string;
        title?: string[];
        abstract?: string;
        'container-title'?: string[];
        issued?: { 'date-parts'?: number[][] };
      }>;
    };
  };
  const items = Array.isArray(payload.message?.items) ? payload.message.items : [];
  const results: WebSearchResult[] = [];
  for (const item of items.slice(0, limit)) {
    const title = (item.title?.[0] ?? '').trim();
    const targetUrl = (item.URL ?? (item.DOI !== undefined ? `https://doi.org/${item.DOI}` : '')).trim();
    if (title.length === 0 || targetUrl.length === 0) continue;
    const rawAbstract = item.abstract !== undefined ? stripTags(item.abstract) : '';
    const dateParts = item.issued?.['date-parts']?.[0];
    const dateStr =
      Array.isArray(dateParts) && dateParts.length > 0
        ? dateParts.map((part) => String(part).padStart(2, '0')).join('-')
        : undefined;
    const result: WebSearchResult = {
      title,
      url: targetUrl,
      snippet: rawAbstract.length > 0 ? truncateSnippet(rawAbstract) : title,
      siteName: item['container-title']?.[0] ?? 'Crossref',
    };
    if (dateStr !== undefined) result.date = dateStr;
    results.push(result);
  }
  return results;
};

export const searchGithub: SearchEngineFn = async (query, limit, options) => {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${String(limit)}`;
  const payload = (await fetchJson(url, options, {
    Accept: 'application/vnd.github+json',
  })) as {
    items?: Array<{
      full_name?: string;
      html_url?: string;
      description?: string;
      stargazers_count?: number;
      language?: string;
      updated_at?: string;
    }>;
  };
  const items = Array.isArray(payload.items) ? payload.items : [];
  const results: WebSearchResult[] = [];
  for (const repo of items.slice(0, limit)) {
    const title = (repo.full_name ?? '').trim();
    const targetUrl = (repo.html_url ?? '').trim();
    if (title.length === 0 || targetUrl.length === 0) continue;
    const meta: string[] = [];
    if (typeof repo.stargazers_count === 'number') meta.push(`★ ${String(repo.stargazers_count)}`);
    if (typeof repo.language === 'string' && repo.language.length > 0) meta.push(repo.language);
    const prefix = meta.length > 0 ? `[${meta.join(' | ')}] ` : '';
    const result: WebSearchResult = {
      title,
      url: targetUrl,
      snippet: truncateSnippet(`${prefix}${repo.description ?? ''}`),
      siteName: 'GitHub',
    };
    if (typeof repo.updated_at === 'string' && repo.updated_at.length >= 10) {
      result.date = repo.updated_at.slice(0, 10);
    }
    results.push(result);
  }
  return results;
};

export const searchWikipedia: SearchEngineFn = async (query, limit, options) => {
  const hasCjk = /[\u4e00-\u9fff]/.test(query);
  const host = hasCjk ? 'zh.wikipedia.org' : 'en.wikipedia.org';
  const url = `https://${host}/w/api.php?action=query&list=search&format=json&utf8=1&srsearch=${encodeURIComponent(query)}&srlimit=${String(limit)}`;
  const payload = (await fetchJson(url, options)) as {
    query?: {
      search?: Array<{
        title?: string;
        snippet?: string;
        timestamp?: string;
      }>;
    };
  };
  const items = Array.isArray(payload.query?.search) ? payload.query.search : [];
  const results: WebSearchResult[] = [];
  for (const page of items.slice(0, limit)) {
    const title = (page.title ?? '').trim();
    if (title.length === 0) continue;
    const result: WebSearchResult = {
      title,
      url: `https://${host}/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`,
      snippet: truncateSnippet(stripTags(page.snippet ?? '')),
      siteName: 'Wikipedia',
    };
    if (typeof page.timestamp === 'string' && page.timestamp.length >= 10) {
      result.date = page.timestamp.slice(0, 10);
    }
    results.push(result);
  }
  return results;
};

export const searchNpm: SearchEngineFn = async (query, limit, options) => {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${String(limit)}`;
  const payload = (await fetchJson(url, options)) as {
    objects?: Array<{
      package?: {
        name?: string;
        version?: string;
        description?: string;
        date?: string;
        links?: { npm?: string; homepage?: string; repository?: string };
      };
    }>;
  };
  const objects = Array.isArray(payload.objects) ? payload.objects : [];
  const results: WebSearchResult[] = [];
  for (const obj of objects.slice(0, limit)) {
    const pkg = obj.package;
    const name = (pkg?.name ?? '').trim();
    if (pkg === undefined || name.length === 0) continue;
    const targetUrl = pkg.links?.npm ?? `https://www.npmjs.com/package/${encodeURIComponent(name)}`;
    const versionNote = pkg.version !== undefined ? `v${pkg.version}: ` : '';
    const result: WebSearchResult = {
      title: name,
      url: targetUrl,
      snippet: truncateSnippet(`${versionNote}${pkg.description ?? ''}`),
      siteName: 'npm',
    };
    if (typeof pkg.date === 'string' && pkg.date.length >= 10) {
      result.date = pkg.date.slice(0, 10);
    }
    results.push(result);
  }
  return results;
};

export const searchPypi: SearchEngineFn = async (query, limit, options) => {
  const tokens = query.trim().split(/\s+/).filter((t) => t.length > 0);
  const candidate = tokens[0];
  if (candidate === undefined || !/^[a-z0-9._-]+$/i.test(candidate)) {
    return [];
  }
  const url = `https://pypi.org/pypi/${encodeURIComponent(candidate)}/json`;
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: DEFAULT_HEADERS,
    signal: options?.signal,
  } as RequestInit);
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)} ${response.statusText} from ${url}`);
  }
  const payload = (await response.json()) as {
    info?: {
      name?: string;
      version?: string;
      summary?: string;
      project_url?: string;
      package_url?: string;
    };
  };
  const info = payload.info;
  if (info === undefined || limit < 1) return [];
  const name = (info.name ?? candidate).trim();
  const targetUrl = (info.project_url ?? info.package_url ?? `https://pypi.org/project/${name}/`).trim();
  const versionNote = info.version !== undefined ? `v${info.version}: ` : '';
  return [
    {
      title: name,
      url: targetUrl,
      snippet: truncateSnippet(`${versionNote}${info.summary ?? ''}`),
      siteName: 'PyPI',
    },
  ];
};

export const VERTICAL_ENGINE_REGISTRY: Readonly<Record<string, SearchEngineFn>> = {
  arxiv: searchArxiv,
  openalex: searchOpenAlex,
  semanticscholar: searchSemanticScholar,
  crossref: searchCrossref,
  github: searchGithub,
  wikipedia: searchWikipedia,
  npm: searchNpm,
  pypi: searchPypi,
};

export function enginesForScope(
  scope: WebSearchScope | undefined,
  configuredEngines: readonly string[],
): readonly string[] {
  const webSlice = configuredEngines.slice(0, 3);
  switch (scope) {
    case 'academic':
      return ['arxiv', 'openalex', 'semanticscholar', 'crossref'];
    case 'code':
      return dedupeList(['github', 'exa', ...webSlice]);
    case 'docs':
      return dedupeList(['exa', 'wikipedia', ...webSlice]);
    case 'reference':
      return dedupeList(['wikipedia', ...webSlice]);
    case 'package':
      return dedupeList(['npm', 'pypi', 'github', ...webSlice]);
    case 'news':
      return configuredEngines;
    case 'web':
    case undefined:
      return configuredEngines;
  }
}

function dedupeList(items: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}
