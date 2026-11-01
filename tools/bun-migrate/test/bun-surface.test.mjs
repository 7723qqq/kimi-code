/**
 * The Bun-only surface, verified rather than listed.
 *
 * Two things are checked: every claim in the tables is reproducible on the
 * running Bun, and every top-level Bun export appears in exactly one table.
 * The second matters most — an unclassified API is one a shared package cannot
 * reason about.
 */
import { describe, expect, it } from 'bun:test';

import {
  BUN_ONLY_FUNCTIONS,
  BUN_ONLY_NAMESPACES,
  dependencySafety,
  HAS_NODE_EQUIVALENT,
} from '../src/bun-surface.mjs';

describe('coverage is complete', () => {
  it('every top-level Bun export is classified', () => {
    const classified = new Set([
      ...HAS_NODE_EQUIVALENT.map((entry) => entry.bun.replace('Bun.', '')),
      ...BUN_ONLY_FUNCTIONS.map((entry) => entry.bun.replace('Bun.', '')),
      ...BUN_ONLY_NAMESPACES.map((entry) => entry.replace('Bun.', '')),
    ]);
    const unclassified = Object.keys(Bun).filter((key) => !classified.has(key));
    expect(JSON.stringify(unclassified)).toBe('[]');
  });

  it('no name appears in two tables', () => {
    const names = [
      ...HAS_NODE_EQUIVALENT.map((entry) => entry.bun),
      ...BUN_ONLY_FUNCTIONS.map((entry) => entry.bun),
      ...BUN_ONLY_NAMESPACES,
    ];
    const seen = new Set();
    const duplicates = [];
    for (const name of names) {
      if (seen.has(name)) duplicates.push(name);
      seen.add(name);
    }
    expect(JSON.stringify(duplicates)).toBe('[]');
  });

  it('every classified name actually exists on this Bun', () => {
    const missing = [];
    for (const name of [
      ...HAS_NODE_EQUIVALENT.map((entry) => entry.bun),
      ...BUN_ONLY_FUNCTIONS.map((entry) => entry.bun),
      ...BUN_ONLY_NAMESPACES,
    ]) {
      const parts = name.split('.');
      let value = globalThis;
      for (const part of parts) value = value?.[part];
      if (value === undefined) missing.push(name);
    }
    expect(JSON.stringify(missing)).toBe('[]');
  });
});

describe('the Node-equivalent claims reproduce', () => {
  it('Bun.MD5, SHA1, SHA256 and SHA512 match node:crypto', () => {
    const crypto = require('node:crypto');
    const payload = 'hello world';
    for (const [className, algorithm] of [
      ['MD5', 'md5'],
      ['SHA1', 'sha1'],
      ['SHA256', 'sha256'],
      ['SHA512', 'sha512'],
    ]) {
      const hasher = new Bun[className]();
      hasher.update(payload);
      expect(`${className}=${hasher.digest('hex')}`).toBe(
        `${className}=${crypto.createHash(algorithm).update(payload).digest('hex')}`,
      );
    }
  });

  it('Bun.deflateSync maps to deflateRawSync, not deflateSync', () => {
    const zlib = require('node:zlib');
    const payload = 'hello';
    expect(Buffer.from(Bun.deflateSync(payload)).equals(zlib.deflateRawSync(payload))).toBe(true);
    expect(Buffer.from(Bun.deflateSync(payload)).equals(zlib.deflateSync(payload))).toBe(false);
  });

  it('Bun.readableStreamToText is covered by Response.text on Node', () => {
    const stream = new Response('payload').body;
    expect(
      Bun.readableStreamToText(
        stream instanceof ReadableStream ? new Response('payload').body : stream,
      ),
    ).resolves.toBe('payload');
    expect(typeof new Response('').text).toBe('function');
  });
});

describe('dependencySafety answers the shared-package question', () => {
  it('marks a byte-identical digest mapping as safe', () => {
    const verdict = dependencySafety('Bun.CryptoHasher');
    expect(verdict.safe).toBe(true);
    expect(verdict.mapped.node).toContain('crypto');
  });

  it('does not call a lossy-but-interoperable mapping safe', () => {
    const verdict = dependencySafety('Bun.gzipSync');
    expect(verdict.safe).toBe(false);
    expect(verdict.conditional).toBe(true);
    expect(verdict.mapped.node).toContain('zlib');
  });

  it('marks zstd as safe because the frames are byte-identical', () => {
    const verdict = dependencySafety('Bun.zstdCompressSync');
    expect(verdict.safe).toBe(true);
    expect(verdict.conditional).toBe(false);
  });

  it('marks a mapping with a known divergence as conditional', () => {
    for (const name of ['Bun.pathToFileURL', 'Bun.deepEquals', 'Bun.escapeHTML']) {
      const verdict = dependencySafety(name);
      expect(`${name} safe=${verdict.safe} conditional=${verdict.conditional}`).toBe(
        `${name} safe=false conditional=true`,
      );
    }
  });

  it('marks a Bun-only API as unsafe', () => {
    for (const name of ['Bun.serve', 'Bun.SQL', 'Bun.YAML', 'Bun.FFI', 'Bun.peek']) {
      const { safe } = dependencySafety(name);
      expect(`${name} unsafe=${safe ? 'false' : 'true'}`).toBe(`${name} unsafe=true`);
    }
  });

  it('reports an unknown name rather than pretending it is safe', () => {
    const verdict = dependencySafety('Bun.notARealThing');
    expect(verdict.safe).toBe(false);
    expect(verdict.unknown).toBe(true);
  });
});

describe('the tables describe real capability gaps', () => {
  it('every Bun-only function says what kind of thing it is', () => {
    for (const entry of BUN_ONLY_FUNCTIONS) {
      expect(entry.kind.length).toBeGreaterThan(1);
      expect(entry.note.length).toBeGreaterThanOrEqual(8);
    }
  });

  it('Bun-only covers the categories a Node project would miss', () => {
    const kinds = new Set(BUN_ONLY_FUNCTIONS.map((entry) => entry.kind));
    for (const expected of [
      'database',
      'server',
      'bundler',
      'archive',
      'image',
      'pty',
      'webview',
    ]) {
      expect(`${expected}=${kinds.has(expected)}`).toBe(`${expected}=true`);
    }
  });

  it('namespaces that have no Node shape are listed', () => {
    for (const name of ['Bun.YAML', 'Bun.TOML', 'Bun.markdown', 'Bun.secrets']) {
      expect(BUN_ONLY_NAMESPACES).toContain(name);
    }
  });
});
