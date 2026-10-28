
// test/codec.test.ts
import { expect, test } from 'bun:test';

import {
  encodeFrame,
  encodeBatchOps,
  decodeBatchOps,
  scanBatchOpRefs,
  FrameParser,
  CorruptFrameError,
  TYPE_SET,
  TYPE_DEL,
  HEADER_SIZE,
} from '../src/codec.js';

const B = (s) => Buffer.from(s);

test('round-trip SET', () => {
  const f = encodeFrame({ type: TYPE_SET, key: B('foo'), value: B('bar'), expireAt: 123 });
  const p = new FrameParser();
  const out = [...p.feed(f)];
  expect(out.length).toBe(1);
  expect(out[0].type).toBe(TYPE_SET);
  expect(out[0].key.toString()).toBe('foo');
  expect(out[0].value.toString()).toBe('bar');
  expect(out[0].expireAt).toBe(123);
});

test('round-trip SET with meta', () => {
  const meta = Buffer.from(JSON.stringify({ dt: { dt1: 123 } }));
  const f = encodeFrame({ type: TYPE_SET, key: B('d'), value: B('v'), meta });
  const out = [...new FrameParser().feed(f)];
  expect(out[0].key.toString()).toBe('d');
  expect(JSON.parse(out[0].meta.toString())).toStrictEqual({ dt: { dt1: 123 } });
});

test('frame without meta yields meta=null', () => {
  const f = encodeFrame({ type: TYPE_SET, key: B('d'), value: B('v') });
  const out = [...new FrameParser().feed(f)];
  expect(out[0].meta).toBe(null);
});

test('round-trip DEL tombstone (empty value)', () => {
  const f = encodeFrame({ type: TYPE_DEL, key: B('gone') });
  const out = [...new FrameParser().feed(f)];
  expect(out[0].type).toBe(TYPE_DEL);
  expect(out[0].key.toString()).toBe('gone');
  expect(out[0].value.length).toBe(0);
});

test('multiple frames in one chunk', () => {
  const a = encodeFrame({ type: TYPE_SET, key: B('a'), value: B('1') });
  const b = encodeFrame({ type: TYPE_SET, key: B('b'), value: B('2') });
  const out = [...new FrameParser().feed(Buffer.concat([a, b]))];
  expect(out.map((r) => r.key.toString()).join(',')).toBe('a,b');
});

test('partial feed across chunks still parses', () => {
  const f = encodeFrame({ type: TYPE_SET, key: B('split'), value: B('x'.repeat(50)) });
  const p = new FrameParser();
  const cut = 7;
  const out1 = [...p.feed(f.subarray(0, cut))];
  expect(out1.length).toBe(0);
  const out2 = [...p.feed(f.subarray(cut))];
  expect(out2.length).toBe(1);
  expect(out2[0].key.toString()).toBe('split');
  expect(out2[0].value.length).toBe(50);
});

test('crc mismatch throws CorruptFrameError with offset', () => {
  const f = encodeFrame({ type: TYPE_SET, key: B('bad'), value: B('data') });
  const corrupted = Buffer.from(f);
  corrupted[HEADER_SIZE + 1] ^= 0xff; // flip a byte inside the payload
  let crcError: unknown;
  try {
    void [...new FrameParser().feed(corrupted)];
  } catch (error) {
    crcError = error;
  }
  expect(crcError).toBeInstanceOf(CorruptFrameError);
  expect((crcError as { offset?: number }).offset).toBe(0);
});

test('finish() reports a torn trailing partial frame at the valid-data offset', () => {
  const p = new FrameParser();
  const good = encodeFrame({ type: TYPE_SET, key: B('ok'), value: B('v') });
  void [...p.feed(good)];
  void [...p.feed(Buffer.from([0x4d, 0x44, 0x01]))]; // magic + type: incomplete header
  let tornError: unknown;
  try {
    p.finish();
  } catch (error) {
    tornError = error;
  }
  expect(tornError).toBeInstanceOf(CorruptFrameError);
  expect((tornError as { offset?: number }).offset).toBe(good.length);
});

test('finish() returns the clean EOF offset when there is no leftover', () => {
  const p = new FrameParser();
  const a = encodeFrame({ type: TYPE_SET, key: B('a'), value: B('1') });
  const b = encodeFrame({ type: TYPE_SET, key: B('b'), value: B('2') });
  void [...p.feed(Buffer.concat([a, b]))];
  expect(p.finish()).toBe(a.length + b.length);
});

test('frame length = header + payload + crc trailer', () => {
  const f = encodeFrame({ type: TYPE_SET, key: B('k'), value: B('v') });
  expect(f.length).toBe(HEADER_SIZE + 1 + 1 + 4);
});

// ---- BATCH body strict structure validation (stage 11, review #9) ----------

/** Hand-rolled batch-body encoder: unlike encodeBatchOps it imposes no type
 *  validation, so tests can craft bodies the real encoder would never emit. */
function rawBatchBody(ops) {
  const parts = [];
  let total = 2;
  for (const op of ops) {
    const key = B(op.key);
    const value = op.value === undefined ? Buffer.alloc(0) : B(op.value);
    total += 1 + 2 + 4 + 4 + 8 + key.length + value.length;
    parts.push({ ...op, key, value });
  }
  const body = Buffer.alloc(total);
  let o = 0;
  body.writeUInt16LE(parts.length, o);
  o += 2;
  for (const op of parts) {
    body.writeUInt8(op.type, o);
    o += 1;
    body.writeUInt16LE(op.key.length, o);
    o += 2;
    body.writeUInt32LE(op.value.length, o);
    o += 4;
    body.writeUInt32LE(0, o);
    o += 4; // metaLen
    body.writeBigInt64LE(0n, o);
    o += 8; // expireAt
    op.key.copy(body, o);
    o += op.key.length;
    op.value.copy(body, o);
    o += op.value.length;
  }
  return body;
}

test('decodeBatchOps / scanBatchOpRefs round-trip a valid body', () => {
  const body = encodeBatchOps([
    { type: TYPE_SET, key: B('a'), value: B('1'), meta: null, expireAt: 0 },
    { type: TYPE_DEL, key: B('b'), value: null, meta: null, expireAt: 0 },
  ]);
  const ops = decodeBatchOps(body);
  expect(ops.length).toBe(2);
  expect(ops[0].type).toBe(TYPE_SET);
  expect(ops[0].key.toString()).toBe('a');
  expect(ops[1].type).toBe(TYPE_DEL);
  const refs = scanBatchOpRefs(body, 0);
  expect(refs.length).toBe(2);
  expect(refs[0].valueOff).toBe(2 + 19 + 1); // count + sub-header + key
});

test('batch decoders reject an unknown sub-op type', () => {
  const body = rawBatchBody([
    { type: TYPE_SET, key: 'accepted', value: 'yes' },
    { type: 99, key: 'unknown', value: 'ignored' },
  ]);
  expect(() => decodeBatchOps(body)).toThrow(/batch op has unknown type 99/);
  expect(() => scanBatchOpRefs(body, 0)).toThrow(/batch op has unknown type 99/);
});

test('batch decoders reject trailing bytes after the last op', () => {
  const valid = encodeBatchOps([
    { type: TYPE_SET, key: B('a'), value: B('1'), meta: null, expireAt: 0 },
  ]);
  const body = Buffer.concat([valid, Buffer.from([0xde, 0xad])]);
  expect(() => decodeBatchOps(body)).toThrow(/batch body has 2 trailing byte\(s\)/);
  expect(() => scanBatchOpRefs(body, 0)).toThrow(/batch body has 2 trailing byte\(s\)/);
});

test('batch decoders reject a body shorter than the count field', () => {
  expect(() => decodeBatchOps(Buffer.alloc(1))).toThrow(/batch body truncated: op count/);
  expect(() => scanBatchOpRefs(Buffer.alloc(1), 0)).toThrow(/batch body truncated: op count/);
});

test('encodeBatchOps refuses to emit a non-SET/DEL sub-op (encode-side assertion)', () => {
  expect(() => encodeBatchOps([{ type: 99, key: B('x'), value: B('y'), meta: null, expireAt: 0 }])).toThrow(/batch op type must be SET or DEL, got 99/);
});
