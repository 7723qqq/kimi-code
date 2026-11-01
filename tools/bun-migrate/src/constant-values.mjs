/**
 * Constants whose name is present on both runtimes but whose value is not.
 *
 * This is the third and quietest class of difference. A missing key throws; a
 * numeric mismatch does not. `buffer.constants.MAX_LENGTH` feeding a size guard
 * silently caps at 4 GB, and `SSL_OP_*` values that are all zero turn an explicit
 * TLS option into a no-op that looks configured.
 *
 * The table is produced by `enumerate-constants.mjs` + `compare-constants.mjs`
 * against a real Node and a real Bun, then curated to the entries a caller can
 * actually be hurt by. Zero-valued SSL_OP_* flags are collapsed into one row
 * because they share one consequence.
 */

export const CONSTANT_VALUE_DIFFERENCES = [
  {
    module: 'node:buffer',
    path: 'constants.MAX_LENGTH',
    node: '9007199254740991',
    bun: '4294967296',
    impact:
      'a guard written as `size > MAX_LENGTH` accepts up to 8 PB on Node and 4 GB on Bun, so a buffer sized between the two passes one check and fails the other',
    workaround: 'compare against a limit you define yourself rather than a runtime constant',
    severity: 'silent',
  },
  {
    module: 'node:buffer',
    path: 'constants.MAX_STRING_LENGTH',
    node: '536870888',
    bun: '2147483647',
    impact: 'a string-length guard changes threshold between runtimes without either one reporting it',
    workaround: 'state your own maximum string length',
    severity: 'silent',
  },
  {
    module: 'node:crypto',
    path: 'constants.OPENSSL_VERSION_NUMBER',
    node: '810549311',
    bun: '269488255',
    impact:
      'code that branches on the OpenSSL version gets a different answer, because Bun is built on BoringSSL rather than OpenSSL',
    workaround: 'feature-detect the capability you need instead of reading a version number',
    severity: 'silent',
  },
  {
    module: 'node:crypto',
    path: 'constants.SSL_OP_* (14 flags)',
    node: 'various non-zero bitmasks',
    bun: '0 for every flag',
    impact:
      'OR-ing a flag into an options word looks like it configured TLS but changes nothing, because every flag is zero: NO_COMPRESSION, NO_RENEGOTIATION, NO_SSLv3, PRIORITIZE_CHACHA and the rest',
    workaround:
      'set the equivalent BoringSSL option at the connection layer, or verify the flag actually took effect',
    severity: 'silent',
  },
];

/** Entries in a shape the gap reporter can print without knowing the source. */
export function constantDifferencesFor(moduleName) {
  return CONSTANT_VALUE_DIFFERENCES.filter((entry) => entry.module === moduleName);
}
