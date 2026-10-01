/**
 * Shape-aware reading of Grep and Glob output for the header chip and the
 * glance row. Both tools append notices (pagination, sensitive-file
 * filtering, timeouts) and an empty-result sentence around the result lines;
 * those must stay out of the counts and the path samples.
 */

import { getLocale, t } from '#/i18n';
import type { Locale } from '#/i18n';
import type { ToolCallBlockData } from '#/tui/types';

import { strArg, stripSpillPointer } from './types';

export type GrepMode = 'files_with_matches' | 'content' | 'count_matches';

export interface GrepEntry {
  /** File the entry belongs to. */
  readonly path: string;
  /** What the glance shows for it: `path`, `path:line`, or `path:count`. */
  readonly label: string;
}

export interface GrepStats {
  readonly mode: GrepMode;
  /** Glance samples in output order; unnumbered content rows collapse to one entry per file. */
  readonly entries: readonly GrepEntry[];
  /**
   * Entries in the whole result set — the tool-reported total when the
   * result is paginated — which the glance counts its "+N more" against.
   */
  readonly total: number;
  /**
   * What the mode counts: files in `files_with_matches`, matching lines in
   * `content`, the summed per-file counts in `count_matches`. `null` when the
   * count is not derivable from the text: unnumbered content rows with
   * context flags are indistinguishable from context rows.
   */
  readonly matches: number | null;
  /** Files in the whole result set when the tool reported a total (paginated results), else the files seen. */
  readonly files: number;
  /** True when a paginated content result only shows the files on its page, so `files` is a lower bound. */
  readonly filesPartial: boolean;
  /** True when the tool reported an incomplete result set (timeout or output cap): every count is a lower bound. */
  readonly partial: boolean;
}

export interface GlobStats {
  readonly entries: readonly string[];
  /** True when Glob timed out or hit its match cap: the count is a lower bound. */
  readonly partial: boolean;
}

// Lines the tools add around the results: the empty-result sentence, the
// count-mode summary, and the pagination / filtering / timeout notices.
// Glob prepends its own diagnostics (timeout, truncation, read warnings whose
// ripgrep stderr continues on `rg:` lines) and appends an exact-cap count line.
const NOTICE =
  /^(?:No matches found|No non-sensitive matches found|Found \d+ total (?:non-sensitive )?occurrences? across |Found \d+ matches$|Filtered \d+ sensitive file|Results truncated to \d+ lines|\[Output truncated at \d+ bytes|Grep timed out after |Glob timed out after |Glob completed with warnings|\[stdout truncated at |\[Truncated at |Only the first |rg: )/;

// Totals the tool reports for the whole result set when it paginates: the
// count-mode summary covers every file, and the pagination notice's total is
// the full line count — the file count in files mode. Named groups because the
// localized summary below puts the same two numbers in the other order.
const COUNT_SUMMARY = /^Found (?<total_occurrences>\d+) total (?:non-sensitive )?occurrences? across (?<files>\d+) files?\.$/m;
const PAGINATION_TOTAL = /^Results truncated to \d+ lines \(total: (\d+)/m;
// Notices that mark the result set itself as incomplete, as opposed to merely paginated.
const INCOMPLETE =
  /^(?:\[Output truncated at \d+ bytes|Grep timed out after |Glob timed out after |Glob completed with warnings|\[stdout truncated at |\[Truncated at \d+ matches|Only the first \d+ matches)/m;

const GLOB_PAGE = /^Showing matches (\d+)–(\d+) of (\d+)( collected matches \(partial result set\))?\.$/m;
const GLOB_CONTINUATION = /^(?:Continue with the same search arguments and offset=\d+\.|(?:To retrieve all collected matches in one search|To remove the match-count limit), omit offset and use head_limit=0\.|Character limit reached; only complete paths are returned\.)$/;
const GLOB_EMPTY = /^(?:No more matches at offset=\d+ in the (?:current|collected partial) result set \(\d+ matches\)\.|No matches collected; search incomplete\.)$/m;

// ── The same notices, in the user's language ────────────────────────────────
//
// The engine renders these notices itself, through the locale catalog — the
// `engine.tools.grep.*` keys named in `packages/kimi-agent/src/tools/mod.rs` —
// so the line the TUI has to recognize is not necessarily the English prose the
// patterns above were written against. Each one is therefore rebuilt from the
// same catalog the engine resolved through, for the active locale. Without this
// a localized notice is read as a result row: `No files matched pattern: *.ts`
// counted as one file, a Chinese empty-result sentence rendered as a path.
//
// English stays hardcoded on purpose. It is the wording the engine still emits
// for the notices that have no catalog key (`Showing matches …`, the paging and
// timeout lines), and it is what a transcript recorded before a locale switch
// still contains — a transcript is not rewritten when the user changes language.
//
// `t()` is called inside a function, never at module scope: the locale is only
// applied after `setLocale()` runs, so a top-level call would freeze the early
// English default (see `test/i18n/module-level-guard.test.ts`).

type NoticeKey =
  | 'engine.tools.grep.noMatches'
  | 'engine.tools.grep.noNonSensitive'
  | 'engine.tools.grep.noNonSensitiveFiltered'
  | 'engine.tools.grep.noMoreMatches'
  | 'engine.tools.grep.noFilesMatched'
  | 'engine.tools.grep.filteredSensitive'
  | 'engine.tools.grep.filteredSensitiveWithList'
  | 'engine.tools.glob.showingMatches';

// The English wording of the catalogued notices, kept so a transcript recorded
// before a locale switch still parses. Duplicating the catalog is the price: the
// host cannot ask the engine to render a key in another language (`t()` takes no
// locale), and importing the message trees here would put the whole catalog in
// the shipped bundle — `@moonshot-ai/i18n-catalog` is a devDependency of this app
// for exactly that reason. `grep-output-locale.test.ts` pins every line below
// against the live catalog, so a reworded template fails there instead of
// silently going unmatched.
const ENGLISH_TEMPLATES: Readonly<Record<NoticeKey, string>> = {
  'engine.tools.grep.noMatches': 'No matches found for pattern: {{pattern}}',
  'engine.tools.grep.noNonSensitive': 'No non-sensitive matches found',
  'engine.tools.grep.noNonSensitiveFiltered':
    'No non-sensitive matches found ({{filtered_sensitive}} sensitive file(s) filtered).',
  'engine.tools.grep.noMoreMatches':
    'No more matches at offset={{offset}} in the current result set ({{total}} matches).',
  'engine.tools.grep.noFilesMatched': 'No files matched pattern: {{pattern}}',
  'engine.tools.grep.filteredSensitive': 'Filtered {{filtered_sensitive}} sensitive file(s).',
  'engine.tools.grep.filteredSensitiveWithList': 'Filtered {{count}} sensitive file(s): {{list}}',
  'engine.tools.glob.showingMatches': 'Showing matches {{from}}–{{to}} of {{total}}.',
};

/** Notices that sit around the result rows and must never count as one. */
const STRIP_KEYS: readonly NoticeKey[] = [
  'engine.tools.grep.noMatches',
  'engine.tools.grep.noNonSensitive',
  'engine.tools.grep.noNonSensitiveFiltered',
  'engine.tools.grep.noMoreMatches',
  'engine.tools.grep.noFilesMatched',
  'engine.tools.grep.filteredSensitive',
  'engine.tools.grep.filteredSensitiveWithList',
];

/** Every match was a file the tools exclude as sensitive. */
const SENSITIVE_ONLY_KEYS: readonly NoticeKey[] = [
  'engine.tools.grep.noNonSensitive',
  'engine.tools.grep.noNonSensitiveFiltered',
];

/** Glob paged past the last match. */
const GLOB_EMPTY_KEYS: readonly NoticeKey[] = ['engine.tools.grep.noMoreMatches'];

function escapeRegExp(literal: string): string {
  return literal.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A catalog template as a pattern source, `{{name}}` becoming a wildcard or a
 * named capture group. `t()` is called without parameters on purpose: a missing
 * parameter leaves its `{{name}}` in the string, which is the template itself —
 * the shape to match against, without pinning any one locale's wording.
 */
function sourceFromTemplate(
  template: string,
  captures: readonly string[] = [],
  numeric: readonly string[] = [],
): string {
  // Built per call rather than shared: a module-level `/g` regex carries
  // `lastIndex` between callers, and this runs on a memoized path where a
  // stale cursor would silently drop a placeholder.
  const placeholder = /\{\{(\w+)\}\}/g;
  let source = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = placeholder.exec(template)) !== null) {
    const name = match[1] ?? '';
    source += escapeRegExp(template.slice(cursor, match.index));
    if (captures.includes(name)) {
      source += `(?<${name}>${numeric.includes(name) ? '\\d+' : '[\\s\\S]+?'})`;
    } else {
      source += '[\\s\\S]+?';
    }
    cursor = match.index + match[0].length;
  }
  return source + escapeRegExp(template.slice(cursor));
}

function templateSource(
  key: NoticeKey | 'engine.tools.grep.foundAcross',
  captures: readonly string[] = [],
  numeric: readonly string[] = [],
): string {
  return sourceFromTemplate(t(key), captures, numeric);
}

/** The active locale's wording and the English fallback, for every key in `keys`. */
function noticeSources(keys: readonly NoticeKey[]): string[] {
  return keys.flatMap((key) => [
    templateSource(key),
    sourceFromTemplate(ENGLISH_TEMPLATES[key]),
  ]);
}

function wholeLine(sources: readonly string[], multiline = false): RegExp {
  return new RegExp(`^(?:${sources.join('|')})`, multiline ? 'm' : '');
}

interface GlobPage {
  readonly from: number;
  readonly to: number;
  readonly total: number;
  /** The host's "collected matches (partial result set)" wording: a lower bound. */
  readonly partialSet: boolean;
}

interface LocalizedNotices {
  /** A line the engine wrote around the result rows. */
  readonly isNoticeLine: (line: string) => boolean;
  /** The count-mode summary's two totals, or `undefined` when it is absent. */
  readonly countSummaryTotals: (output: string) => { total: number; files: number } | undefined;
  readonly isSensitiveOnly: (line: string) => boolean;
  readonly isGlobEmpty: (output: string) => boolean;
  readonly globPage: (output: string) => GlobPage | undefined;
  /** Glob's paging report as a single line. Glob-only: Grep never emits it, so
   *  it must not be stripped from a Grep result the way the shared notices are. */
  readonly isGlobPageLine: (line: string) => boolean;
}

// Rebuilt once per locale rather than per render: `t()` crosses into the
// engine, and these run on every repaint of every Grep / Glob card.
let cachedLocale: Locale | undefined;
let cachedNotices: LocalizedNotices | undefined;

function notices(): LocalizedNotices {
  const locale = getLocale();
  if (cachedNotices !== undefined && cachedLocale === locale) return cachedNotices;

  const strip = wholeLine(noticeSources(STRIP_KEYS));
  // `searchNoticeOnly` hands these the whole result, not one line, and a
  // diagnostic can precede the notice — the `m` flag is what lets the anchored
  // pattern find it there, exactly as the hand-written SENSITIVE_ONLY had.
  const sensitiveOnly = wholeLine(noticeSources(SENSITIVE_ONLY_KEYS), true);
  const globEmpty = new RegExp(
    `^(?:${noticeSources(GLOB_EMPTY_KEYS).join('|')}|${GLOB_EMPTY.source.slice(1, -1)})`,
    'm',
  );
  const localizedSummary = new RegExp(
    `^(?:${templateSource(
      'engine.tools.grep.foundAcross',
      ['total_occurrences', 'files'],
      ['total_occurrences', 'files'],
    )})`,
    'm',
  );
  const localizedPage = new RegExp(
    `^(?:${templateSource(
      'engine.tools.glob.showingMatches',
      ['from', 'to', 'total'],
      ['from', 'to', 'total'],
    )})`,
    'm',
  );
  // Two patterns cover the line in either language: `GLOB_PAGE` is the English
  // wording, which also recognizes the host's "collected matches (partial result
  // set)" variant the native engine never emits, and `localizedPage` is the
  // active locale's.

  cachedNotices = {
    isNoticeLine: (line) => NOTICE.test(line) || strip.test(line),
    countSummaryTotals: (output) => {
      const match = COUNT_SUMMARY.exec(output) ?? localizedSummary.exec(output);
      const total = match?.groups?.['total_occurrences'];
      const files = match?.groups?.['files'];
      return total === undefined || files === undefined
        ? undefined
        : { total: Number(total), files: Number(files) };
    },
    isSensitiveOnly: (line) => SENSITIVE_ONLY.test(line) || sensitiveOnly.test(line),
    isGlobEmpty: (output) => GLOB_EMPTY.test(output) || globEmpty.test(output),
    globPage: (output) => {
      // The host's wording first: it carries the "partial result set" suffix the
      // native engine never emits, and that suffix is what marks the count as a
      // lower bound.
      const host = GLOB_PAGE.exec(output);
      if (host) {
        return {
          from: Number(host[1]),
          to: Number(host[2]),
          total: Number(host[3]),
          partialSet: host[4] !== undefined,
        };
      }
      const match = localizedPage.exec(output);
      const from = match?.groups?.['from'];
      const to = match?.groups?.['to'];
      const total = match?.groups?.['total'];
      return from === undefined || to === undefined || total === undefined
        ? undefined
        : { from: Number(from), to: Number(to), total: Number(total), partialSet: false };
    },
    isGlobPageLine: (line) => GLOB_PAGE.test(line) || localizedPage.test(line),
  };
  cachedLocale = locale;
  return cachedNotices;
}

// `path:line:text`; context lines use `-` separators and are not matches.
const CONTENT_MATCH = /^(.+?):(\d+):/;
const COUNT_LINE = /^(.+):(\d+)$/;
// A Windows drive letter carries its own colon; the separator search skips it.
const DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;

function resultLines(output: string): string[] {
  if (output.length === 0) return [];
  const { isNoticeLine } = notices();
  return stripSpillPointer(output)
    .split('\n')
    .filter((line) => line.length > 0 && line !== '--' && !isNoticeLine(line));
}

export function grepMode(toolCall: ToolCallBlockData): GrepMode {
  const mode = strArg(toolCall.args, 'output_mode');
  return mode === 'content' || mode === 'count_matches' ? mode : 'files_with_matches';
}

export function parseGrepOutput(toolCall: ToolCallBlockData, output: string): GrepStats {
  const mode = grepMode(toolCall);
  const lines = resultLines(output);
  const partial = INCOMPLETE.test(output);

  if (mode === 'files_with_matches') {
    const entries = lines.map((path) => ({ path, label: path }));
    const total = PAGINATION_TOTAL.exec(output)?.[1];
    const files = total === undefined ? entries.length : Number(total);
    return { mode, entries, total: files, matches: files, files, filesPartial: false, partial };
  }

  if (mode === 'count_matches') {
    const entries: GrepEntry[] = [];
    let matches = 0;
    for (const line of lines) {
      const [, path, count] = COUNT_LINE.exec(line) ?? [];
      if (path === undefined || count === undefined) continue;
      entries.push({ path, label: line });
      matches += Number(count);
    }
    const summary = notices().countSummaryTotals(output);
    if (summary !== undefined) {
      return {
        mode,
        entries,
        total: summary.files,
        matches: summary.total,
        files: summary.files,
        filesPartial: false,
        partial,
      };
    }
    return {
      mode,
      entries,
      total: entries.length,
      matches,
      files: entries.length,
      filesPartial: false,
      partial,
    };
  }

  // Content mode: with line numbers (the default) only `path:line:` rows are
  // matches; without them every match row is `path:text`, and context rows
  // (`-A`/`-B`/`-C`) look exactly the same — the backend separates fields
  // with ':' unconditionally — so an exact match count is unknowable then.
  const numbered = toolCall.args['-n'] !== false;
  // The schema allows zero, which asks for no context rows at all, and a
  // defined `-C` makes the backend drop `-A`/`-B` entirely.
  const positive = (flag: string): boolean => {
    const value = toolCall.args[flag];
    return typeof value === 'number' && value > 0;
  };
  const hasContext =
    typeof toolCall.args['-C'] === 'number' ? positive('-C') : positive('-A') || positive('-B');
  const countable = numbered || !hasContext;
  const entries: GrepEntry[] = [];
  const paths = new Set<string>();
  let rows = 0;
  for (const line of lines) {
    if (numbered) {
      const [, path, lineNumber] = CONTENT_MATCH.exec(line) ?? [];
      if (path === undefined || lineNumber === undefined) continue;
      rows++;
      paths.add(path);
      entries.push({ path, label: `${path}:${lineNumber}` });
      continue;
    }
    // Unnumbered rows are labelled by their path alone, so the glance lists
    // each file once instead of repeating it per match or context row.
    const idx = line.indexOf(':', DRIVE_PREFIX.test(line) ? 2 : 0);
    const path = idx > 0 ? line.slice(0, idx) : line;
    rows++;
    if (paths.has(path)) continue;
    paths.add(path);
    entries.push({ path, label: path });
  }
  // Without context flags every paginated row is a match, so the tool's
  // total is the exact match count; the files beyond the page stay unknown.
  const paginatedTotal = hasContext ? undefined : PAGINATION_TOTAL.exec(output)?.[1];
  const matches = countable ? (paginatedTotal === undefined ? rows : Number(paginatedTotal)) : null;
  return {
    mode,
    entries,
    total: numbered && matches !== null ? matches : paths.size,
    matches,
    files: paths.size,
    filesPartial: paginatedTotal !== undefined,
    partial,
  };
}

export function parseGlobOutput(output: string): GlobStats {
  const { globPage, isGlobEmpty, isGlobPageLine } = notices();
  const page = globPage(output);
  const entries = resultLines(output).filter(
    (line) => !isGlobPageLine(line) && !GLOB_CONTINUATION.test(line) && !isGlobEmpty(line),
  );
  const partial = INCOMPLETE.test(output) ||
    (page !== undefined && (page.to < page.total || page.partialSet));
  return { entries, partial };
}

// Every match was a file the tool excludes as sensitive: the search did find
// something, and the notice says why nothing is listed.
const SENSITIVE_ONLY = /^No non-sensitive matches found/m;

/**
 * Whether a Grep or Glob result is only the tool's notice: the search was cut
 * short (timeout, output cap, unreadable directories) before any row, or every
 * match was a filtered sensitive file. Such a card shows the notice as a plain
 * outcome row, the same way in both states, and carries no count.
 */
export function searchNoticeOnly(toolCall: ToolCallBlockData, output: string): boolean {
  const { isGlobEmpty, isSensitiveOnly } = notices();
  const noRows =
    toolCall.name === 'Glob'
      ? parseGlobOutput(output).entries.length === 0
      : parseGrepOutput(toolCall, output).entries.length === 0;
  return noRows && (
    INCOMPLETE.test(output) || isSensitiveOnly(output) ||
    (toolCall.name === 'Glob' && isGlobEmpty(output))
  );
}
