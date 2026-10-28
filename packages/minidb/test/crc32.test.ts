
// test/crc32.test.ts
import { expect, test } from 'bun:test';

import { crc32 } from '../src/crc32.js';

test('crc32 known vectors', () => {
  // CRC-32/ISO-HDLC of "123456789" is 0xCBF43926 (the canonical check value).
  expect(crc32(Buffer.from('123456789')).toString(16)).toBe('cbf43926');
  expect(crc32(Buffer.from('')).toString(16)).toBe('0');
  expect(crc32(Buffer.from('a')).toString(16)).toBe('e8b7be43');
});

test('crc32 is incremental', () => {
  const data = Buffer.from('hello world from minidb');
  const whole = crc32(data);
  let running = 0;
  for (let i = 0; i < data.length; i += 5) {
    running = crc32(data.subarray(i, Math.min(i + 5, data.length)), running);
  }
  expect(running).toBe(whole);
});
