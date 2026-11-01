import { describe, expect, it } from 'bun:test';
/**
 * Candidates added after probing what was still uncovered.
 *
 * Each case here exists because a measurement decided it: zstd was added because
 * the bytes matched and it was faster, escape-html was kept report-only because
 * one entity differs, and he was refused because every entity differs.
 */
import { createHash } from 'node:crypto';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

import { replacementFor } from '../src/packages-map.mjs';
import { pairingFor } from '../src/pairings.mjs';

describe('zstd', () => {
  const SIZES = [0, 1, 100, 5_000, 100_000];

  for (const size of SIZES) {
    it(`node and Bun produce identical bytes at ${size} bytes`, () => {
      const payload = 'x'.repeat(size);
      const node = Buffer.from(zstdCompressSync(payload));
      const bun = Buffer.from(Bun.zstdCompressSync(payload));
      expect(bun.equals(node)).toBe(true);
    });
  }

  it('decodes data compressed by the other runtime', () => {
    const payload = 'interop '.repeat(500);
    expect(Buffer.from(Bun.zstdDecompressSync(zstdCompressSync(payload))).toString()).toBe(payload);
    expect(zstdDecompressSync(Bun.zstdCompressSync(payload)).toString()).toBe(payload);
  });

  it('is offered as an automatic rewrite with a one-argument condition', () => {
    const compress = pairingFor('node:zlib', 'zstdCompressSync');
    const decompress = pairingFor('node:zlib', 'zstdDecompressSync');
    expect(compress).toBeDefined();
    expect(decompress).toBeDefined();
    expect(compress.effect).toBe('speed');
    expect(decompress.effect).toBe('speed');
    /**
     * The summary used to say "not byte-identical", inherited from the gzip finding
     * without being measured for zstd. Measured on Bun 1.4.4 against Node 24.9.0
     * across 25 payloads from 1 B to 32 MB, the frames are identical every time, so
     * the cheaper claim was also the wrong one — see `differential.test.mjs`, which
     * pins it.
     */
    expect(compress.summary).toContain('byte-identical');
    expect(compress.summary.includes('not byte-identical')).toBe(false);
  });

  it('refuses a call that passes options', () => {
    const pairing = pairingFor('node:zlib', 'zstdCompressSync');
    const fakeCall = { arguments: [{ getText: () => "'x'" }, { getText: () => '{}' }] };
    expect(pairing.check({ call: fakeCall })).toContain('options');
  });
});

describe('escape-html', () => {
  it('is report-only because one entity differs', () => {
    const entry = replacementFor('escape-html');
    expect(entry).toBeDefined();
    expect(entry.effect).toBe('report-only');
    expect(entry.caveats).toContain('&#39;');
    expect(entry.caveats).toContain('&#x27;');
  });

  it('the divergence is exactly the single quote', () => {
    expect(Bun.escapeHTML("'")).toBe('&#x27;');
    expect(Bun.escapeHTML('<')).toBe('&lt;');
    expect(Bun.escapeHTML('&')).toBe('&amp;');
    expect(Bun.escapeHTML('"')).toBe('&quot;');
  });

  it('agrees with the manual chain on everything but the apostrophe', () => {
    const manual = (text) =>
      text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    for (const sample of ['<script>', 'a & b', '"q"', 'plain']) {
      expect(Bun.escapeHTML(sample)).toBe(manual(sample));
    }
    expect(Bun.escapeHTML("'")).not.toBe(manual("'"));
  });
});

describe('he', () => {
  it('is refused outright because every entity is hexadecimal', () => {
    const entry = replacementFor('he');
    expect(entry).toBeDefined();
    expect(entry.effect).toBe('report-only');
    expect(entry.verified).toEqual([]);
  });
});

describe('Bun.MD5 and Bun.SHA256 are not separate rules', () => {
  it('produce the same digest as node:crypto', () => {
    const payload = 'hello';
    const md5 = new Bun.MD5();
    md5.update(payload);
    expect(md5.digest('hex')).toBe(createHash('md5').update(payload).digest('hex'));

    const sha = new Bun.SHA256();
    sha.update(payload);
    expect(sha.digest('hex')).toBe(createHash('sha256').update(payload).digest('hex'));
  });

  it('are not given separate rules because createHash already covers them', () => {
    expect(pairingFor('node:crypto', 'createHash')).toBeDefined();
    expect(pairingFor('node:crypto', 'MD5')).toBeUndefined();
    expect(pairingFor('node:crypto', 'SHA256')).toBeUndefined();
  });
});
