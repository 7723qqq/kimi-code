/**
 * Bun's own surface, classified by whether a Node project could use it.
 *
 * A shared package needs the answer to a narrower question than "does Bun.X
 * exist": *if I write `Bun.X`, does my package still run on Node?* That splits
 * the 112 top-level exports into three groups, and only the first is safe.
 *
 * Every mapping here was checked by running both sides, not by reading a list.
 */

/** Marks a mapping that only holds for some inputs. */
export const CAVEAT = 'conditional';

/** A Node equivalent exists and the result matched when run. */
export const HAS_NODE_EQUIVALENT = [
  { bun: 'Bun.file', node: 'node:fs/promises readFile', note: 'Bun.file().text() matches readFile(p, "utf8")' },
  { bun: 'Bun.write', node: 'node:fs/promises writeFile', note: 'Bun.write matches writeFile for string payloads' },
  { bun: 'Bun.spawn', node: 'node:child_process spawn', note: 'different call shape, same capability' },
  { bun: 'Bun.spawnSync', node: 'node:child_process spawnSync', note: 'takes argv, returns exitCode' },
  { bun: 'Bun.gzipSync', caveat: CAVEAT, node: 'node:zlib gzipSync', note: "identical to Bun's own node:zlib, but not to a stream produced by Node itself; both decode the other's output" },
  { bun: 'Bun.gunzipSync', node: 'node:zlib gunzipSync', note: 'interoperable in both directions' },
  { bun: 'Bun.deflateSync', caveat: CAVEAT, node: 'node:zlib deflateRawSync', note: 'raw deflate; NOT deflateSync' },
  { bun: 'Bun.inflateSync', caveat: CAVEAT, node: 'node:zlib inflateRawSync', note: 'raw inflate; NOT inflateSync' },
  { bun: 'Bun.zstdCompressSync', node: 'node:zlib zstdCompressSync', note: 'byte-identical to Node across 25 payloads from 1 B to 32 MB' },
  { bun: 'Bun.zstdDecompressSync', node: 'node:zlib zstdDecompressSync', note: 'interoperable' },
  { bun: 'Bun.fileURLToPath', node: 'node:url fileURLToPath', note: 'same result on a real path' },
  { bun: 'Bun.pathToFileURL', caveat: CAVEAT, node: 'node:url pathToFileURL', note: 'differs on Windows drive-letter resolution' },
  { bun: 'Bun.deepEquals', caveat: CAVEAT, node: 'node:util isDeepStrictEqual', note: 'differs on an undefined-valued key' },
  { bun: 'Bun.stripANSI', node: 'node:util stripVTControlCharacters', note: 'identical output' },
  { bun: 'Bun.inspect', caveat: CAVEAT, node: 'node:util inspect', note: 'same shape, different formatting options' },
  { bun: 'Bun.CryptoHasher', node: 'node:crypto createHash', note: 'identical digests' },
  { bun: 'Bun.MD5', node: 'node:crypto createHash("md5")', note: 'verified identical, constructor form' },
  { bun: 'Bun.MD4', caveat: CAVEAT, node: 'node:crypto createHash("md4")', note: 'node implements md4 only where OpenSSL allows it' },
  { bun: 'Bun.SHA1', node: 'node:crypto createHash("sha1")', note: 'verified identical' },
  { bun: 'Bun.SHA224', node: 'node:crypto createHash("sha224")', note: 'verified digest path' },
  { bun: 'Bun.SHA256', node: 'node:crypto createHash("sha256")', note: 'verified identical' },
  { bun: 'Bun.SHA384', node: 'node:crypto createHash("sha384")', note: 'verified digest path' },
  { bun: 'Bun.SHA512', node: 'node:crypto createHash("sha512")', note: 'verified identical' },
  { bun: 'Bun.SHA512_256', node: 'node:crypto createHash("sha512-256")', note: 'verified digest path' },
  { bun: 'Bun.fetch', node: 'global fetch', note: 'both runtimes ship a Web fetch' },
  { bun: 'Bun.zstdCompress', node: 'node:zlib zstdCompress', note: 'async form, byte identical' },
  { bun: 'Bun.zstdDecompress', node: 'node:zlib zstdDecompress', note: 'async form, interoperable' },
  { bun: 'Bun.Glob', node: 'node:fs globSync', note: 'same file set for a cwd glob' },
  { bun: 'Bun.sleep', node: 'node:timers/promises setTimeout', note: 'same delay behaviour' },
  { bun: 'Bun.escapeHTML', node: undefined, note: 'no native Node API; matches escape-html except the apostrophe' },
];

/** No Node API does this. Writing it makes the package Bun-only. */
export const BUN_ONLY_FUNCTIONS = [
  { bun: 'Bun.$', kind: 'shell', note: 'tagged-template shell, replaces execa/zx' },
  { bun: 'Bun.serve', kind: 'server', note: 'HTTP server with a Request/Response handler' },
  { bun: 'Bun.listen', kind: 'socket', note: 'raw socket listener' },
  { bun: 'Bun.connect', kind: 'socket', note: 'raw socket client' },
  { bun: 'Bun.udpSocket', kind: 'socket', note: 'UDP socket' },
  { bun: 'Bun.build', kind: 'bundler', note: 'bundler and minifier' },
  { bun: 'Bun.Transpiler', kind: 'transpiler', note: 'per-file TypeScript transform' },
  { bun: 'Bun.plugin', kind: 'loader', note: 'module resolution hooks' },
  { bun: 'Bun.SQL', kind: 'database', note: 'SQL client' },
  { bun: 'Bun.sql', kind: 'database', note: 'SQL tag template' },
  { bun: 'Bun.postgres', kind: 'database', note: 'Postgres client' },
  { bun: 'Bun.RedisClient', kind: 'database', note: 'Redis client' },
  { bun: 'Bun.S3Client', kind: 'storage', note: 'S3 client' },
  { bun: 'Bun.Archive', kind: 'archive', note: 'tar and zip' },
  { bun: 'Bun.Image', kind: 'image', note: 'encode, resize, rotate' },
  { bun: 'Bun.Terminal', kind: 'pty', note: 'pseudo-terminal' },
  { bun: 'Bun.WebView', kind: 'webview', note: 'embedded browser' },
  { bun: 'Bun.cron', kind: 'scheduler', note: 'cron scheduler' },
  { bun: 'Bun.peek', kind: 'promise', note: 'read a settled promise without await' },
  { bun: 'Bun.deepMatch', kind: 'comparison', note: 'subset match; argument order is (value, pattern)' },
  { bun: 'Bun.hash', kind: 'hash', note: 'wyhash family, non-cryptographic' },
  { bun: 'Bun.sha', kind: 'hash', note: 'async sha with an encoding option' },
  { bun: 'Bun.randomUUIDv5', kind: 'uuid', note: 'name-based UUID; Node has only v4' },
  { bun: 'Bun.randomUUIDv7', kind: 'uuid', note: 'time-ordered UUID; Node has only v4' },
  { bun: 'Bun.stringWidth', kind: 'text', note: 'terminal column width' },
  { bun: 'Bun.sliceAnsi', kind: 'text', note: 'slice without breaking escape sequences' },
  { bun: 'Bun.wrapAnsi', kind: 'text', note: 'wrap without breaking escape sequences' },
  { bun: 'Bun.color', kind: 'text', note: 'colour conversion' },
  { bun: 'Bun.openInEditor', kind: 'process', note: 'open a file in the user editor' },
  { bun: 'Bun.which', kind: 'process', note: 'resolve an executable' },
  { bun: 'Bun.nanoseconds', kind: 'timing', note: 'monotonic high-resolution clock' },
  { bun: 'Bun.sleepSync', kind: 'timing', note: 'blocking sleep' },
  { bun: 'Bun.gc', kind: 'runtime', note: 'force a collection' },
  { bun: 'Bun.generateHeapSnapshot', kind: 'runtime', note: 'write a heap snapshot' },
  { bun: 'Bun.shrink', kind: 'runtime', note: 'release memory back to the OS' },
  { bun: 'Bun.mmap', kind: 'runtime', note: 'memory-map a file' },
  { bun: 'Bun.allocUnsafe', kind: 'runtime', note: 'uninitialised buffer' },
  { bun: 'Bun.concatArrayBuffers', kind: 'runtime', note: 'join array buffers' },
  { bun: 'Bun.indexOfLine', kind: 'text', note: 'line index in a buffer' },
  { bun: 'Bun.ArrayBufferSink', kind: 'stream', note: 'incremental buffer builder' },
  { bun: 'Bun.readableStreamToText', kind: 'stream', note: 'Response.text covers this on Node' },
  { bun: 'Bun.readableStreamToJSON', kind: 'stream', note: 'Response.json covers this on Node' },
  { bun: 'Bun.readableStreamToArray', kind: 'stream', note: 'no direct Node API' },
  { bun: 'Bun.readableStreamToArrayBuffer', kind: 'stream', note: 'no direct Node API' },
  { bun: 'Bun.readableStreamToBytes', kind: 'stream', note: 'no direct Node API' },
  { bun: 'Bun.readableStreamToBlob', kind: 'stream', note: 'Response.blob covers this on Node' },
  { bun: 'Bun.readableStreamToFormData', kind: 'stream', note: 'Response.formData covers this on Node' },
  { bun: 'Bun.FetchSession', kind: 'http', note: 'connection reuse across fetches' },
  { bun: 'Bun.Cookie', kind: 'http', note: 'cookie parsing and serialisation' },
  { bun: 'Bun.CookieMap', kind: 'http', note: 'cookie jar' },
  { bun: 'Bun.FileSystemRouter', kind: 'router', note: 'file-based routing' },
  { bun: 'Bun.ModuleGraph', kind: 'bundler', note: 'module dependency graph' },
  { bun: 'Bun.resolve', kind: 'loader', note: 'async module resolution' },
  { bun: 'Bun.resolveSync', kind: 'loader', note: 'sync module resolution' },
  { bun: 'Bun.semver', kind: 'version', note: 'order and satisfies only' },
  { bun: 'Bun.password', kind: 'crypto', note: 'argon2 and bcrypt' },
  { bun: 'Bun.FFI', kind: 'native', note: 'call into native libraries' },
  { bun: 'Bun.CSRF', kind: 'security', note: 'CSRF token generation and verification' },
  { bun: 'Bun.enableANSIColors', kind: 'text', note: 'force ANSI colour on or off' },
  { bun: 'Bun.unsafe', kind: 'runtime', note: 'unsafe memory helpers such as gc and segments' },
];

/** Object-shaped namespaces rather than functions. */
export const BUN_ONLY_NAMESPACES = [
  'Bun.YAML',
  'Bun.TOML',
  'Bun.JSON5',
  'Bun.JSONC',
  'Bun.JSONL',
  'Bun.XML',
  'Bun.markdown',
  'Bun.dns',
  'Bun.redis',
  'Bun.s3',
  'Bun.secrets',
  'Bun.argv',
  'Bun.env',
  'Bun.main',
  'Bun.stdin',
  'Bun.stdout',
  'Bun.stderr',
  'Bun.embeddedFiles',
  'Bun.version',
  'Bun.revision',
  'Bun.isMainThread',
  'Bun.isStandaloneExecutable',
];

/**
 * Which Bun names a package may use without becoming Bun-only.
 *
 * `safe` means a Node path exists today, so the code can ship to both runtimes
 * with a branch. `conditional` means the mapping only holds for some inputs.
 *
 * The condition is an explicit field, not a keyword in the note. Deriving it from
 * `note.includes('differs')` was a string match standing in for a semantic: it
 * missed `Bun.gzipSync` (whose bytes differ across runtimes) because the note
 * phrased it as "not to a stream produced by Node" and reported `safe: true` for
 * a call that would break a stored checksum.
 */
export function dependencySafety(name) {
  const mapped = HAS_NODE_EQUIVALENT.find((entry) => entry.bun === name);
  if (mapped) {
    const conditional = mapped.caveat === CAVEAT || mapped.node === undefined;
    return { safe: !conditional, mapped, conditional };
  }
  if (BUN_ONLY_FUNCTIONS.some((entry) => entry.bun === name)) return { safe: false };
  if (BUN_ONLY_NAMESPACES.includes(name)) return { safe: false };
  return { safe: false, unknown: true };
}
