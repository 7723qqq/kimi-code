/**
 * Version probes: what the installed Bun actually provides.
 *
 * Hardcoding "Bun 1.4.4 supports sha3-256" would rot the moment either side
 * moves. Instead every capability the pairing table depends on is asked of the
 * runtime that will execute the migrated code. A rule is only offered when the
 * probe says yes, so the same tool stays correct across Bun versions without a
 * code change.
 */

const cache = new Map();

function remember(key, compute) {
  if (!cache.has(key)) cache.set(key, compute());
  return cache.get(key);
}

/** The Bun version as numbers, for rules that need a floor rather than a probe. */
export function bunVersion() {
  const [major = 0, minor = 0, patch = 0] = Bun.version
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return { major, minor, patch, text: Bun.version };
}

/** Does `new Bun.CryptoHasher(alg)` construct and produce a digest at all? */
export function cryptoHasherSupports(algorithm) {
  return remember(`crypto:${algorithm}`, () => {
    try {
      const hasher = new Bun.CryptoHasher(algorithm);
      hasher.update('probe');
      const digest = hasher.digest();
      return digest instanceof Uint8Array && digest.length > 0;
    } catch {
      return false;
    }
  });
}

/** Does `new Bun.CryptoHasher(alg, key)` support HMAC for this algorithm? */
export function cryptoHasherHmacSupports(algorithm) {
  return remember(`hmac:${algorithm}`, () => {
    try {
      const hasher = new Bun.CryptoHasher(algorithm, 'probe-key');
      hasher.update('probe');
      const digest = hasher.digest();
      return digest instanceof Uint8Array && digest.length > 0;
    } catch {
      return false;
    }
  });
}

/** Which digest encodings does CryptoHasher accept, keyed by encoding name. */
export function digestEncodingSupported(encoding) {
  return remember(`encoding:${encoding}`, () => {
    try {
      const value = new Bun.CryptoHasher('sha256').update('probe').digest(encoding);
      return typeof value === 'string' && value.length > 0;
    } catch {
      return false;
    }
  });
}

/** Does Bun.write accept a string for this destination? */
export function bunWriteSupported() {
  return remember('bunwrite', () => typeof Bun.write === 'function');
}

/** Bun.file exists and is lazy: the property tells us the implementation shape. */
export function bunFileExists() {
  return remember('bunfile', () => typeof Bun.file === 'function');
}

/** A compact description of the runtime the rules were resolved against. */
export function runtimeReport() {
  const version = bunVersion();
  return {
    bun: version.text,
    cryptoHasher: typeof Bun.CryptoHasher === 'function',
    bunFile: bunFileExists(),
    bunWrite: bunWriteSupported(),
  };
}

/**
 * Strip a trailing `#` comment and surrounding whitespace from a TOML value line.
 *
 * A quoted string may contain `#`, so the scan tracks quotes; everything after an
 * unquoted `#` is a comment. Without this, the documented example
 * `portable = true   # only apply ...` does not match a `$`-anchored regex, and
 * the setting silently does nothing — which is the failure mode a config example
 * must never have.
 */
function stripTomlComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === '#' && !inSingle && !inDouble) return line.slice(0, index);
  }
  return line;
}

/**
 * Read a `key = true|false` setting, tolerating spacing and a trailing comment.
 *
 * Returns `undefined` when the key is absent, so a caller can tell "not set" from
 * "set to false".
 */
function booleanSetting(text, key) {
  for (const rawLine of text.split('\n')) {
    const line = stripTomlComment(rawLine).trim();
    const match = new RegExp(`^${key}\\s*=\\s*(true|false)$`).exec(line);
    if (match) return match[1] === 'true';
  }
  return;
}

/**
 * Read a `key = [ ... ]` array, tolerating spacing and a trailing comment.
 *
 * The scan runs to the closing bracket rather than to the end of the line, so an
 * array written across several lines is still read.
 */
function arraySetting(text, key) {
  const withoutComments = text.split('\n').map(stripTomlComment).join('\n');
  const start = new RegExp(`^${key}\\s*=\\s*\\[`, 'm').exec(withoutComments);
  if (!start) return;
  const openIndex = withoutComments.indexOf('[', start.index);
  let depth = 0;
  let endIndex = -1;
  for (let index = openIndex; index < withoutComments.length; index += 1) {
    if (withoutComments[index] === '[') depth += 1;
    else if (withoutComments[index] === ']') {
      depth -= 1;
      if (depth === 0) {
        endIndex = index;
        break;
      }
    }
  }
  if (endIndex === -1) return;
  const body = withoutComments.slice(openIndex + 1, endIndex);
  return body
    .split(',')
    .map((value) => value.trim().replaceAll(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

/**
 * Load a lockfile-embedded capability manifest if the project carries one.
 *
 * `.bun-migrate.toml` may narrow what the tool is allowed to apply, which is how
 * a project pins a decision without pinning a Bun version.
 *
 * `portable = true` restricts the `source` layer to rewrites that also run under
 * Node. Its practical effect is stated in the README because it is drastic: every
 * auto-applied source rule currently emits a `Bun.*` expression, so turning this
 * on disables the source layer entirely rather than selecting a portable subset.
 */
export function loadProjectOverrides(configText) {
  if (!configText) {
    return { deny: [], allowSource: true, portable: false };
  }
  return {
    deny: arraySetting(configText, 'deny') ?? [],
    allowSource: booleanSetting(configText, 'auto-source') !== false,
    portable: booleanSetting(configText, 'portable') === true,
  };
}

/**
 * Packages that must keep running outside Bun, on top of any project list.
 *
 * These either run in a browser, in a VS Code extension host, or declare an
 * engines range that does not include Bun. Writing `Bun.*` into them would break
 * the shipped artifact. Every automatic rewrite layer honours this list, not
 * only the source layer.
 */
export const DEFAULT_DENY = [
  'packages/pi-tui',
  'packages/transcript',
  'packages/i18n-shared',
  'apps/vscode',
  'apps/vis',
];

export function denyList(overrides) {
  return [...new Set([...DEFAULT_DENY, ...overrides.deny])];
}

export function isDeniedFile(file, deny) {
  return deny.some((prefix) => file === prefix || file.startsWith(`${prefix}/`));
}

/**
 * Whether a rewrite keeps the file runnable outside Bun.
 *
 * A rule is portable when its replacement is either a `node:` call Bun also
 * implements or a standard-language construct. Anything introduced from the `Bun`
 * global is not: `Bun.CryptoHasher`, `Bun.gzipSync`, `Bun.file` and friends throw
 * `ReferenceError` under Node, so applying them is a one-way door.
 */
export function keepsNodePortable(pairing) {
  const expression = String(pairing?.bunExpression ?? '');
  return !/\bBun\./.test(expression) && !/^Bun\b/.test(expression);
}
