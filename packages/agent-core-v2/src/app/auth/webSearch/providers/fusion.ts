import type {
  WebSearchFreshness,
  WebSearchResult,
  WebSearchScope,
} from '#/agent/tools/web-search/web-search';

export interface EngineResultList {
  readonly engine: string;
  readonly results: readonly WebSearchResult[];
  readonly weight?: number;
}

export interface FuseSearchOptions {
  readonly limit: number;
  readonly k?: number;
  readonly domains?: readonly string[];
  readonly engineWeights?: Readonly<Record<string, number>>;
}

const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'spm',
  'scm',
  'from',
  'ref_src',
  'ref_url',
  'ved',
  'ei',
  '_hsenc',
  '_hsmi',
]);

export function normalizeResultUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return '';
  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const port =
      (protocol === 'https:' && parsed.port === '443') ||
      (protocol === 'http:' && parsed.port === '80') ||
      parsed.port === ''
        ? ''
        : `:${parsed.port}`;
    const kept: Array<[string, string]> = [];
    for (const [key, value] of parsed.searchParams.entries()) {
      const lower = key.toLowerCase();
      if (lower.startsWith('utm_') || TRACKING_PARAMS.has(lower)) continue;
      kept.push([key, value]);
    }
    kept.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    const search =
      kept.length > 0
        ? `?${kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
        : '';
    const pathname =
      parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, '') : parsed.pathname;
    return `${host}${port}${pathname}${search}`;
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, '');
  }
}

function titleTokens(title: string): Set<string> {
  const normalized = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .trim();
  const tokens = new Set<string>();
  for (const part of normalized.split(/\s+/)) {
    if (part.length === 0) continue;
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(part)) {
      if (part.length <= 2) {
        tokens.add(part);
      } else {
        for (let i = 0; i < part.length - 1; i += 1) {
          tokens.add(part.slice(i, i + 2));
        }
      }
    } else if (part.length >= 2) {
      tokens.add(part);
    }
  }
  return tokens;
}

export function titleSimilarity(a: string, b: string): number {
  const normA = a.trim().toLowerCase();
  const normB = b.trim().toLowerCase();
  if (normA.length === 0 || normB.length === 0) return 0;
  if (normA === normB) return 1;
  const setA = titleTokens(normA);
  const setB = titleTokens(normB);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function normalizeDomainEntry(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
}

export function matchesDomainFilter(rawUrl: string, domains: readonly string[]): boolean {
  if (domains.length === 0) return true;
  const cleaned = domains.map(normalizeDomainEntry).filter((d) => d.length > 0);
  if (cleaned.length === 0) return true;
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
    return cleaned.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export function applyQueryModifiers(
  query: string,
  options?: {
    domains?: readonly string[];
    freshness?: WebSearchFreshness;
    scope?: WebSearchScope;
  },
): string {
  const parts: string[] = [query.trim()];
  const domains = (options?.domains ?? []).map(normalizeDomainEntry).filter((d) => d.length > 0);
  if (domains.length > 0 && domains.length <= 4 && !/\bsite:/i.test(query)) {
    if (domains.length === 1) {
      parts.push(`site:${domains[0]}`);
    } else {
      parts.push(`(${domains.map((d) => `site:${d}`).join(' OR ')})`);
    }
  } else if (options?.scope === 'docs' && domains.length === 0 && !/\bsite:/i.test(query)) {
    parts.push('documentation');
  } else if (options?.scope === 'news' && !/\bnews\b/i.test(query)) {
    const year = new Date().getUTCFullYear();
    if (options.freshness === 'day' || options.freshness === 'week') {
      parts.push(String(year));
    }
  }
  return parts.join(' ').trim();
}

interface MutableCluster {
  title: string;
  url: string;
  normalizedUrl: string;
  snippet: string;
  date?: string;
  siteName?: string;
  engines: Set<string>;
  score: number;
  seenUrlsFromSameEngine: Set<string>;
}

function mergeIntoCluster(
  cluster: MutableCluster,
  candidate: WebSearchResult,
  engine: string,
  deltaScore: number,
): void {
  const dedupeKey = `${engine}:${cluster.normalizedUrl}`;
  if (!cluster.seenUrlsFromSameEngine.has(dedupeKey)) {
    cluster.seenUrlsFromSameEngine.add(dedupeKey);
    cluster.score += deltaScore;
  }
  cluster.engines.add(engine);
  if (candidate.snippet.trim().length > cluster.snippet.trim().length) {
    cluster.snippet = candidate.snippet.trim();
  }
  if (candidate.title.trim().length > cluster.title.trim().length) {
    cluster.title = candidate.title.trim();
  }
  if (cluster.date === undefined && candidate.date !== undefined && candidate.date.length > 0) {
    cluster.date = candidate.date;
  }
  if (
    cluster.siteName === undefined &&
    candidate.siteName !== undefined &&
    candidate.siteName.length > 0
  ) {
    cluster.siteName = candidate.siteName;
  }
  if (
    cluster.url.startsWith('http://') &&
    candidate.url.startsWith('https://') &&
    normalizeResultUrl(candidate.url) === cluster.normalizedUrl
  ) {
    cluster.url = candidate.url;
  }
}

export function fuseSearchResults(
  rankedLists: readonly EngineResultList[],
  options: FuseSearchOptions,
): WebSearchResult[] {
  const k = options.k ?? 60;
  const domains = options.domains ?? [];
  const clusters: MutableCluster[] = [];
  const byUrl = new Map<string, MutableCluster>();

  for (const list of rankedLists) {
    const weight = list.weight ?? options.engineWeights?.[list.engine] ?? 1;
    let rank = 0;
    for (const item of list.results) {
      if (item.url.trim().length === 0) continue;
      if (domains.length > 0 && !matchesDomainFilter(item.url, domains)) continue;
      rank += 1;
      const rrfDelta = weight / (k + rank);
      const normUrl = normalizeResultUrl(item.url);
      let target = byUrl.get(normUrl);
      if (target === undefined && item.title.trim().length > 0) {
        for (const existing of clusters) {
          if (titleSimilarity(existing.title, item.title) >= 0.85) {
            target = existing;
            break;
          }
        }
      }
      if (target !== undefined) {
        mergeIntoCluster(target, item, list.engine, rrfDelta);
      } else {
        const cluster: MutableCluster = {
          title: item.title.trim(),
          url: item.url.trim(),
          normalizedUrl: normUrl,
          snippet: item.snippet.trim(),
          date: item.date,
          siteName: item.siteName,
          engines: new Set([list.engine]),
          score: rrfDelta,
          seenUrlsFromSameEngine: new Set([`${list.engine}:${normUrl}`]),
        };
        clusters.push(cluster);
        byUrl.set(normUrl, cluster);
      }
    }
  }

  clusters.sort((a, b) => b.score - a.score || b.engines.size - a.engines.size);

  return clusters.slice(0, options.limit).map((cluster): WebSearchResult => {
    const out: WebSearchResult = {
      title: cluster.title,
      url: cluster.url,
      snippet: cluster.snippet,
      engines: [...cluster.engines],
      score: Math.round(cluster.score * 100_000) / 100_000,
    };
    if (cluster.date !== undefined) out.date = cluster.date;
    if (cluster.siteName !== undefined) out.siteName = cluster.siteName;
    return out;
  });
}
