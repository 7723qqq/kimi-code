/**
 * Third-party package -> Bun builtin.
 *
 * A different class from the node: builtins layer. There the source keeps
 * importing a module and one call changes shape. Here the import target changes
 * and the dependency can leave package.json entirely, which is a bigger win
 * than any single call swap.
 *
 * Every entry lists the package, the Bun replacement, and the exact members
 * that were verified equivalent. A package with an unverified member stays
 * report-only, because dropping a dependency whose API is partly missing turns
 * a build error into a runtime one.
 */

export const PACKAGE_REPLACEMENTS = [
  {
    package: 'yaml',
    bun: 'Bun.YAML',
    effect: 'speed',
    verified: ['parse', 'stringify'],
    summary: 'yaml.parse/stringify -> Bun.YAML.parse/stringify, verified on a nested document',
    caveats:
      'Bun.YAML.parse does not accept the options object yaml.parse takes (custom schemas, revivers)',
  },
  {
    package: 'js-yaml',
    bun: 'Bun.YAML',
    effect: 'speed',
    verified: ['load', 'dump'],
    memberAliases: { load: 'parse', dump: 'stringify' },
    summary:
      'js-yaml load/dump -> Bun.YAML.parse/stringify, verified equal output for a nested document',
    caveats:
      'load maps to parse and dump to stringify; js-yaml schemas and type definitions have no equivalent',
  },
  {
    package: 'smol-toml',
    bun: 'Bun.TOML',
    effect: 'speed',
    verified: ['parse', 'stringify'],
    summary: 'smol-toml parse/stringify -> Bun.TOML.parse/stringify, verified equal output',
    caveats: 'no options object on either side, so the swap is direct',
  },
  {
    package: 'json5',
    bun: 'Bun.JSON5',
    effect: 'speed',
    verified: ['parse', 'stringify'],
    summary:
      'json5 parse/stringify -> Bun.JSON5.parse/stringify, verified equal output with comments and trailing commas',
    caveats: 'no options object on either side',
  },
  {
    package: 'strip-ansi',
    bun: 'Bun.stripANSI',
    effect: 'speed',
    verified: ['default'],
    summary: 'strip-ansi -> Bun.stripANSI, verified equal output and measured about 16x faster',
    caveats: 'strip-ansi is a default export; the rewrite changes the call, not just the import',
  },
  {
    package: 'string-width',
    bun: 'Bun.stringWidth',
    effect: 'speed',
    verified: ['default'],
    summary:
      'string-width -> Bun.stringWidth, verified equal for ascii, CJK, emoji and combining marks',
    caveats:
      'string-width accepts an options object for ambiguous-width characters; Bun.stringWidth does not',
  },
  {
    package: 'semver',
    bun: 'Bun.semver',
    effect: 'report-only',
    verified: ['satisfies', 'order'],
    summary: 'semver.satisfies and order map to Bun.semver; the rest does not exist',
    caveats:
      'Bun.semver exposes only order and satisfies. sort, valid, coerce, gt, lt, maxSatisfying and every range helper are missing, so a partial migration would leave imports broken',
  },
  {
    package: 'marked',
    bun: 'Bun.markdown',
    effect: 'report-only',
    verified: ['parse to html'],
    summary: 'marked.parse matches Bun.markdown.html on a simple document',
    caveats:
      'marked exposes extensions, renderers, tokenizers and async parsing; Bun.markdown exposes html, render and react. The overlap is the simplest case only',
  },
  {
    package: 'which',
    bun: 'Bun.which',
    effect: 'speed',
    verified: ['sync'],
    memberExpressions: { sync: 'Bun.which' },
    summary: 'which.sync -> Bun.which, verified to find the same binary',
    caveats:
      'which.sync with nothrow maps to Bun.which returning null; the path casing may differ on Windows',
  },
  {
    package: '@iarna/toml',
    bun: 'Bun.TOML',
    effect: 'report-only',
    verified: ['parse (non-date values)', 'stringify'],
    summary:
      '@iarna/toml and Bun.TOML agree on strings, numbers and arrays but produce different date types',
    caveats:
      'measured: a TOML datetime parses to a Date in @iarna/toml and to a Temporal.Instant or Temporal.PlainDate in Bun.TOML, so any caller comparing, formatting or serialising a date changes behaviour',
  },
  {
    package: 'better-sqlite3',
    bun: 'bun:sqlite',
    effect: 'report-only',
    verified: ['prepare', 'run', 'get', 'all', 'iterate', 'transaction'],
    summary:
      'better-sqlite3 matches bun:sqlite on the everyday path but not on empty rows or six helper methods',
    caveats:
      'measured: .get() on an empty result is undefined on better-sqlite3 and null on bun:sqlite, and pluck()/raw()/expand()/columns()/pragma()/backup() have no counterpart, so a partial port breaks at run time',
  },
  {
    package: 'escape-html',
    bun: 'Bun.escapeHTML',
    effect: 'report-only',
    verified: ['escape'],
    summary: 'escape-html agrees with Bun.escapeHTML except for the single-quote entity',
    caveats:
      'measured: escape-html emits &#39; for a single quote while Bun.escapeHTML emits &#x27;. Both render identically in HTML, but the bytes differ, so any caller comparing, hashing or snapshotting the escaped string changes output',
  },
  {
    package: 'he',
    bun: 'Bun.escapeHTML',
    effect: 'report-only',
    verified: [],
    summary: 'he.encode uses hexadecimal entities throughout, which does not match Bun.escapeHTML',
    caveats:
      'measured: he.encode emits &#x3C; / &#x26; / &#x22; where Bun.escapeHTML emits &lt; / &amp; / &quot;, so every escaped character differs. he also decodes and handles named entities, which Bun.escapeHTML does not',
  },
];

const DEFAULT_EXPORTS = new Set(['default']);

export function replacementFor(packageName) {
  return PACKAGE_REPLACEMENTS.find((entry) => entry.package === packageName);
}

/**
 * Is this import specifier a default import of a package we can replace?
 *
 * Named imports from a replaceable package are only offered when every imported
 * member appears in that package's verified list, so `import { sort } from
 * 'semver'` is refused while `import { satisfies } from 'semver'` is not.
 */
export function assessImport(packageName, importedNames) {
  const replacement = replacementFor(packageName);
  if (!replacement) return;
  const names = importedNames.length > 0 ? importedNames : ['default'];
  const unverified = names.filter((name) => {
    if (DEFAULT_EXPORTS.has(name)) return !replacement.verified.includes('default');
    return !replacement.verified.includes(name);
  });
  return {
    replacement,
    importedNames: names,
    unverified,
    safe: unverified.length === 0 && replacement.effect !== 'report-only',
  };
}
