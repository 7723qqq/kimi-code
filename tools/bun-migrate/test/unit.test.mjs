import { createHash } from 'node:crypto';

import { describe, expect, it } from 'bun:test';

import { collectNodeBindings, parse, resolveBuiltinCall, ts, walkCalls } from '../src/ast.mjs';
import {
  cryptoHasherHmacSupports,
  cryptoHasherSupports,
  digestEncodingSupported,
} from '../src/capabilities.mjs';
import { parsePnpmWorkspace } from '../src/layers/packages.mjs';
import { PAIRINGS, pairingFor, REPORT_ONLY, SPEED } from '../src/pairings.mjs';

function calls(text) {
  const sourceFile = parse('probe.ts', text);
  const bindings = collectNodeBindings(sourceFile);
  const found = [];
  walkCalls(sourceFile, (call) => {
    const resolved = resolveBuiltinCall(call, bindings);
    if (resolved) found.push(resolved);
  });
  return found;
}

describe('resolveBuiltinCall', () => {
  it('resolves a named import from a node: module', () => {
    const found = calls("import { createHash } from 'node:crypto';\ncreateHash('sha256');\n");
    expect(found.length).toBe(1);
    expect(found[0].module).toBe('node:crypto');
    expect(found[0].exportName).toBe('createHash');
  });

  it('resolves a namespace member call', () => {
    const found = calls("import * as fsp from 'node:fs/promises';\nfsp.readFile('x', 'utf8');\n");
    expect(found.length).toBe(1);
    expect(found[0].module).toBe('node:fs/promises');
    expect(found[0].exportName).toBe('readFile');
  });

  it('ignores a same-named local function', () => {
    const found = calls(
      "import { createHash } from 'node:crypto';\nfunction readFile(p: string) { return p; }\nreadFile('x');\n",
    );
    expect(found.length).toBe(0);
  });

  it('ignores a module that is not a node: builtin', () => {
    const found = calls("import { createHash } from './hash.js';\ncreateHash('sha256');\n");
    expect(found.length).toBe(0);
  });

  it('leaves an aliased import addressable by its local name', () => {
    const found = calls("import { createHash as ch } from 'node:crypto';\nch('sha256');\n");
    expect(found.length).toBe(1);
    expect(found[0].exportName).toBe('createHash');
  });
});

describe('crypto pairing', () => {
  const pairing = pairingFor('node:crypto', 'createHash');
  const helpers = { text: (node) => node.getText() };

  function check(source) {
    const sourceFile = parse('probe.ts', source);
    const bindings = collectNodeBindings(sourceFile);
    let site;
    walkCalls(sourceFile, (call) => {
      const resolved = resolveBuiltinCall(call, bindings);
      if (resolved?.exportName === 'createHash') site = { call, sourceFile, resolved };
    });
    if (!site) throw new Error('no createHash call found');
    return { reason: pairing.check(site, helpers), site };
  }

  it('accepts a digest with a pinned text encoding', () => {
    const { reason } = check("import { createHash } from 'node:crypto';\ncreateHash('sha256').update('a').digest('hex');\n");
    expect(reason).toBeUndefined();
  });

  it('rejects a non-literal algorithm', () => {
    const { reason } = check("import { createHash } from 'node:crypto';\ncreateHash(alg).update('a').digest('hex');\n");
    expect(reason).toContain('not a string literal');
  });

  it('rejects an options argument instead of dropping outputLength', () => {
    const { reason } = check(
      "import { createHash } from 'node:crypto';\ncreateHash('shake128', { outputLength: 32 }).update('a').digest('hex');\n",
    );
    expect(reason).toContain('options');
  });

  it('validates the digest encoding when the result is read further', () => {
    const { reason } = check(
      "import { createHash } from 'node:crypto';\ncreateHash('sha256').update('a').digest(encoding).length;\n",
    );
    expect(reason).toContain('dynamic');
  });

  it('rejects an algorithm this Bun cannot hash', () => {
    const { reason } = check(
      "import { createHash } from 'node:crypto';\ncreateHash('definitely-not-a-hash').update('a').digest('hex');\n",
    );
    expect(reason).toContain('no CryptoHasher support');
  });

  it('builds the Bun form from the original arguments', () => {
    const { site } = check("import { createHash } from 'node:crypto';\ncreateHash('sha256').update('a').digest('hex');\n");
    expect(pairing.build(site, helpers)).toBe("new Bun.CryptoHasher('sha256')");
  });

  it('accepts a streaming hasher with one digest', () => {
    const { reason } = check(
      "import { createHash } from 'node:crypto';\nconst h = createHash('sha256');\nh.update('a');\nh.digest('hex');\n",
    );
    expect(reason).toBeUndefined();
  });

  it('accepts copy() before digest()', () => {
    const { reason } = check(
      "import { createHash } from 'node:crypto';\nconst h = createHash('sha256').update('a');\nconst c = h.copy();\nh.digest('hex');\nc.digest('hex');\n",
    );
    expect(reason).toBeUndefined();
  });

  it('rejects a bare hasher that is never digested', () => {
    const { reason } = check(
      "import { createHash } from 'node:crypto';\nexport const h = createHash('sha256');\n",
    );
    expect(reason).toContain('never digested');
  });

  it('rejects a hasher digested twice across statements', () => {
    const { reason } = check(
      "import { createHash } from 'node:crypto';\nconst h = createHash('sha256');\nh.digest('hex');\nh.digest('hex');\n",
    );
    expect(reason).toContain('digested more than once');
  });

  it('rejects an update after digest', () => {
    const { reason } = check(
      "import { createHash } from 'node:crypto';\nconst h = createHash('sha256');\nh.digest('hex');\nh.update('a');\n",
    );
    expect(reason).toContain('updated after digest');
  });
});

describe('hmac pairing', () => {
  const helpers = { text: (node) => node.getText() };

  function checkHmac(source) {
    const pairing = pairingFor('node:crypto', 'createHmac');
    const sourceFile = parse('probe.ts', source);
    const bindings = collectNodeBindings(sourceFile);
    let site;
    walkCalls(sourceFile, (call) => {
      const resolved = resolveBuiltinCall(call, bindings);
      if (resolved?.exportName === 'createHmac') site = { call, sourceFile, resolved };
    });
    if (!site) throw new Error('no createHmac call found');
    return { reason: pairing.check(site, helpers), site, pairing };
  }

  it('accepts a single digest on the chain', () => {
    const { reason } = checkHmac(
      "import { createHmac } from 'node:crypto';\ncreateHmac('sha256','k').update('a').digest('hex');\n",
    );
    expect(reason).toBeUndefined();
  });

  it('rejects an options argument instead of dropping it', () => {
    const { reason } = checkHmac(
      "import { createHmac } from 'node:crypto';\ncreateHmac('sha256','k', { outputLength: 32 }).update('a').digest('hex');\n",
    );
    expect(reason).toContain('options');
  });

  it('rejects a KeyObject key, which Node accepts and Bun does not', () => {
    const { reason } = checkHmac(
      "import { createHmac, createSecretKey } from 'node:crypto';\ncreateHmac('sha256', createSecretKey(Buffer.from('k'))).update('a').digest('hex');\n",
    );
    expect(reason).toContain('key type');
    expect(reason).toContain('KeyObject');
  });

  it('rejects a key variable whose type cannot be proven', () => {
    const { reason } = checkHmac(
      "import { createHmac } from 'node:crypto';\ncreateHmac('sha256', key).update('a').digest('hex');\n",
    );
    expect(reason).toContain('key type');
  });

  it('accepts a Buffer or typed-array key', () => {
    for (const key of ["Buffer.from('k')", 'new Uint8Array([1])']) {
      const { reason } = checkHmac(
        `import { createHmac } from 'node:crypto';\ncreateHmac('sha256', ${key}).update('a').digest('hex');\n`,
      );
      expect(reason).toBeUndefined();
    }
  });

  it('accepts a chain in a file that also digests another hasher', () => {
    const source = [
      "import { createHash, createHmac } from 'node:crypto';",
      "const a = createHash('sha256').update('x').digest('hex');",
      "const b = createHmac('sha256','k').update('x').digest('hex');",
      '',
    ].join('\n');
    const { reason } = checkHmac(source);
    expect(reason).toBeUndefined();
  });

  it('rejects a chain that digests twice', () => {
    const { reason } = checkHmac(
      "import { createHmac } from 'node:crypto';\ncreateHmac('sha256','k').update('a').digest('hex').digest('hex');\n",
    );
    expect(typeof reason).toBe('string');
    expect(reason).toContain('digest() more than once');
  });

  it('rejects a hasher reused across statements', () => {
    const { reason } = checkHmac(
      "import { createHmac } from 'node:crypto';\nconst h = createHmac('sha256','k').update('a');\nh.digest('hex'); h.digest('hex');\n",
    );
    expect(reason).toContain('digested more than once');
  });

  it('accepts a streaming hasher with one digest', () => {
    const { reason } = checkHmac(
      "import { createHmac } from 'node:crypto';\nconst h = createHmac('sha256','k');\nh.update('a');\nh.digest('hex');\n",
    );
    expect(reason).toBeUndefined();
  });

  it('rejects HMAC copy(), which Node does not implement', () => {
    const { reason } = checkHmac(
      "import { createHmac } from 'node:crypto';\nconst h = createHmac('sha256','k').update('a');\nconst c = h.copy();\nc.digest('hex');\n",
    );
    expect(reason).toContain('copy');
  });

  it('builds the keyed form', () => {
    const { site, pairing } = checkHmac(
      "import { createHmac } from 'node:crypto';\ncreateHmac('sha256','secret').update('a').digest('hex');\n",
    );
    expect(pairing.build(site, helpers)).toBe("new Bun.CryptoHasher('sha256', 'secret')");
  });
});

describe('readFile stays on node:fs', () => {
  it('is not offered as a rewrite, because Bun measured slower', () => {
    const pairing = PAIRINGS.find((item) => item.exportName === 'readFile');
    expect(pairing.effect).toBe(REPORT_ONLY);
    expect(pairing.summary).toContain('measured');
  });

  it('records why the type difference would matter if it were rewritten', () => {
    const pairing = PAIRINGS.find((item) => item.exportName === 'readFile');
    expect(pairing.check({})).toContain('slower');
  });

  it('is excluded from rewrite because it would be slower', () => {
    const pairing = PAIRINGS.find((item) => item.exportName === 'readFile');
    expect(pairing.effect).toBe(REPORT_ONLY);
    expect(pairing.bunExpression).toBe('Bun.file');
  });
});

describe('runtime capability probes', () => {
  it('reports a hash algorithm the installed Bun supports', () => {
    expect(cryptoHasherSupports('sha256')).toBe(true);
  });

  it('reports an algorithm the installed Bun does not support', () => {
    expect(cryptoHasherSupports('definitely-not-a-hash')).toBe(false);
  });

  it('answers HMAC support independently of plain hashing', () => {
    if (cryptoHasherSupports('shake128')) {
      expect(cryptoHasherHmacSupports('shake128')).toBe(false);
    }
  });

  it('answers digest encoding support by asking the runtime', () => {
    expect(digestEncodingSupported('hex')).toBe(true);
    expect(digestEncodingSupported('base64url')).toBe(true);
    expect(digestEncodingSupported('nonsense-encoding')).toBe(false);
  });

  it('matches node:crypto for a sha256 hex digest', () => {
    const expected = createHash('sha256').update('hello world').digest('hex');
    const actual = new Bun.CryptoHasher('sha256').update('hello world').digest('hex');
    expect(actual).toBe(expected);
  });

  it('matches node:crypto for latin1 and base64url digests', () => {
    for (const encoding of ['latin1', 'base64url']) {
      const expected = createHash('sha256').update('x').digest(encoding);
      const actual = new Bun.CryptoHasher('sha256').update('x').digest(encoding);
      expect(actual).toBe(expected);
    }
  });

  it('matches node:crypto when update is given a non-utf8 encoding', () => {
    for (const encoding of ['hex', 'base64']) {
      const expected = createHash('sha256').update('68656c6c6f', encoding).digest('hex');
      const actual = new Bun.CryptoHasher('sha256').update('68656c6c6f', encoding).digest('hex');
      expect(actual).toBe(expected);
    }
  });
});

describe('parsePnpmWorkspace', () => {
  it('reads package globs', () => {
    const parsed = parsePnpmWorkspace("packages:\n  - 'packages/*'\n  - 'apps/*'\n");
    expect(parsed.packages).toEqual(['packages/*', 'apps/*']);
  });

  it('reads the catalog so it can be moved into package.json', () => {
    const parsed = parsePnpmWorkspace('catalog:\n  zod: 4.3.6\n  pathe: ^2.0.3\npackages:\n  - src\n');
    expect(parsed.catalog).toEqual({ zod: '4.3.6', pathe: '^2.0.3' });
    expect(parsed.unsupported).toEqual([]);
  });

  it('strips quotes from catalog versions', () => {
    const parsed = parsePnpmWorkspace("catalog:\n  zod: '4.3.6'\n");
    expect(parsed.catalog.zod).toBe('4.3.6');
  });

  it('reports named catalogs it cannot flatten', () => {
    const parsed = parsePnpmWorkspace('catalogs:\n  legacy:\n    zod: 3.0.0\n');
    expect(parsed.unsupported.some((item) => item.includes('legacy'))).toBe(true);
  });

  it('reports overrides and patchedDependencies instead of guessing', () => {
    const parsed = parsePnpmWorkspace('overrides:\n  "a>@b": "1.0.0"\npatchedDependencies:\n  left-pad: x.patch\n');
    expect(parsed.unsupported).toContain('overrides');
    expect(parsed.unsupported).toContain('patchedDependencies');
  });

  it('keeps a trailing comment out of the glob', () => {
    const parsed = parsePnpmWorkspace("packages:\n  - 'packages/*' # all packages\n");
    expect(parsed.packages).toEqual(['packages/*']);
    expect(parsed.unsupported).toEqual([]);
  });

  it('reports every top-level key it does not translate', () => {
    const parsed = parsePnpmWorkspace('packages:\n  - packages/*\nonlyBuiltDependencies:\n  - esbuild\n');
    expect(parsed.ok).toBe(true);
    expect(parsed.unsupported.some((item) => item.includes('onlyBuiltDependencies'))).toBe(true);
  });

  it('reports an unparseable document and leaves it for review', () => {
    const parsed = parsePnpmWorkspace('packages: [\n');
    expect(parsed.ok).toBe(false);
    expect(parsed.unsupported[0]).toContain('left in place');
  });
});

describe('pairing table invariants', () => {
  it('never marks a rule as rewriteable when Bun has no equivalent', () => {
    for (const pairing of PAIRINGS) {
      if (pairing.bunExpression === '(none)') {
        expect(pairing.effect).toBe(REPORT_ONLY);
      }
    }
  });

  it('gives every rewriteable rule a build function and a check', () => {
    for (const pairing of PAIRINGS) {
      expect(typeof pairing.check).toBe('function');
      expect(typeof pairing.build).toBe('function');
      if (pairing.effect !== REPORT_ONLY) {
        expect(pairing.bunExpression).not.toBe('(none)');
      }
    }
  });

  it('states a condition on every rule', () => {
    for (const pairing of PAIRINGS) {
      expect(pairing.condition.length).toBeGreaterThan(10);
    }
  });

  it('has no duplicate module and export pair', () => {
    const seen = new Set();
    for (const pairing of PAIRINGS) {
      const key = `${pairing.from}#${pairing.exportName}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('treats compress and decompress directions differently for zlib', () => {
    const wrappedCompress = PAIRINGS.find((item) => item.exportName === 'deflateSync');
    const wrappedDecompress = PAIRINGS.find((item) => item.exportName === 'inflateSync');
    expect(wrappedCompress.effect).toBe(REPORT_ONLY);
    expect(wrappedDecompress.effect).toBe(REPORT_ONLY);
    const gzip = PAIRINGS.find((item) => item.exportName === 'gzipSync');
    const gunzip = PAIRINGS.find((item) => item.exportName === 'gunzipSync');
    expect(gzip.effect).toBe(SPEED);
    expect(gunzip.effect).toBe(SPEED);
    const rawDecompress = PAIRINGS.find((item) => item.exportName === 'inflateRawSync');
    expect(rawDecompress.effect).toBe(SPEED);
  });
});
