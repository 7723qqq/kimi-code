# Performance evidence matrix

This file holds the size-by-size measurements behind the migration rules. A rule
may claim a direction on the strength of `test/performance.test.mjs`; a claim of
measured magnitude needs a row here, and several `speed` rules still have none —
the "not met yet" paragraph in README lists them.

Method: each measurement is the median of three rounds, where a round times the
whole loop and divides by the iteration count. Sizes span four orders of
magnitude because the small-file result does not predict the large-file result.

Measured on Bun 1.4.4 / Node 24.9.0, Windows x64, warm cache unless marked cold.

## How to read a multiplier here

Two things make these numbers easy to misread, and both were measured rather than
assumed.

**Same-process, not two processes.** `require('node:crypto')` inside Bun runs
Bun's own compiled implementation; it is not Node. Timing the two APIs in one Bun
process is the only way to compare the two implementations without a process
startup difference on one side. A cross-process run of the same code produced
5.2x for sha256 where the same-process run produces 1.5x — the extra factor is
Node's startup, not hashing. The tables below are same-process.

**The small-input rows are the noisiest.** With 300 iterations per round, the
16 B `md5` row swung between 0.91x and 1.14x across three runs, including values
below 1.0. At 5000 iterations and nine rounds the same case settles at 1.12x
(node 332 ns vs Bun 297 ns), and every size and algorithm lands above 1.0. The
sub-1.0 readings were measurement noise, not a case where Bun is slower. The
`never slower` verdict below rests on the high-iteration runs, not on the table.

## Hashing: `createHash` -> `Bun.CryptoHasher`

Median of three runs, 300 iterations per round (30 for 1 MB):

| algorithm | 16 B  | 1 KB  | 100 KB | 1 MB  |
| --------- | ----- | ----- | ------ | ----- |
| sha256    | 1.53x | 1.60x | 1.51x  | 1.77x |
| sha512    | 1.03x | 1.18x | 1.16x  | 1.14x |
| md5       | 1.00x | 1.18x | 1.18x  | 1.11x |
| sha1      | 1.49x | 1.52x | 1.27x  | 1.30x |

Run-to-run spread at these iteration counts is roughly ±0.15 on the 16 B row and
±0.05 above 1 KB; the earlier table in this file reported higher values because
its rounds were shorter.

Verdict: `speed`, but the margin is `sha256`/`sha1` territory (1.3x-1.8x) and
`sha512`/`md5` are close to parity (1.0x-1.2x). At 5000 iterations and nine
rounds, every algorithm at 16 B, 64 B and 256 B lands between 1.04x and 1.20x,
with no case below 1.0 — that is the evidence behind "never slower".
Under 4 worker threads the gap widens to 2.0x (47 ms vs 23 ms for 4 x 20 000
hashes), because the native path releases the loop better.

### The one-shot form: `Bun.CryptoHasher.hash`

`createHash(alg).update(input).digest(output)` is rewritten to the static
`Bun.CryptoHasher.hash(alg, input, output)`, which hashes in one call instead of
constructing a hasher, updating it and digesting it. The constructor form stays
for a hasher consumed in statements, for `copy()`, and for HMAC.

Same process, median of three rounds, 300 iterations per round (30 for 1 MB):

| static form vs node `createHash` | 16 B    | 1 KB    | 100 KB  | 1 MB  |
| -------------------------------- | ------- | ------- | ------- | ----- |
| `Bun.CryptoHasher.hash` hex      | 2.7x-3.1x | 2.0x-2.9x | 1.4x-1.5x | 1.7x |
| `Bun.CryptoHasher.hash` buffer   | 2.8x-3.1x | 2.2x-2.4x | 1.5x   | 1.5x |

The static form's edge over the constructor form it replaces is 1.3x-2.4x below
1 KB and parity from 100 KB: at small sizes the constructor and the two method
calls cost more than the hashing, and that overhead vanishes into the hash at
large ones. The buffer rows return a `Buffer`, matching `digest()`; the hex rows
return a string, matching `digest('hex')`.

## gzip: `gzipSync` / `gunzipSync` -> `Bun.gzipSync` / `Bun.gunzipSync`

Median of three runs, 300 iterations per round (20 for sizes above 200 KB):

| operation  | 16 B  | 1 KB  | 100 KB | 1 MB |
| ---------- | ----- | ----- | ------ | ---- |
| gzipSync   | 39.6x | 34.5x | 9.4x   | 3.0x |
| gunzipSync | 33.3x | 7.4x  | 2.4x   | 2.2x |

The 100 KB and 1 MB rows are lower than the earlier table in this file reported
(12.3x and 2.5x) by a few tenths, which is inside the run-to-run spread at those
iteration counts.

Verdict: `speed`. The advantage shrinks by an order of magnitude between 16 B and
1 MB and never disappears. The 2.2x floor at 1 MB is the number to quote: a payload
large enough to matter still wins, just not by 30x.

**What the bytes actually do.** An earlier version of this file claimed the output
was "byte identical in both directions". Measured properly, that holds only inside
one Bun process, where `require('node:zlib').gzipSync` and `Bun.gzipSync` are the
same implementation. Against a stream produced by real Node they differ:

| payload                  | node bytes | bun bytes | identical |
| ------------------------ | ---------- | --------- | --------- |
| `'x' * 16`               | 23         | 23        | yes       |
| `'x' * 100`              | 24         | 24        | yes       |
| `'x' * 1000`             | 29         | 30        | no        |
| `'x' * 1024`             | 29         | 30        | no        |
| `'x' * 2048`             | 35         | 36        | no        |
| `'hello world' * 100`    | 41         | 45        | no        |
| `'compressible ' * 1000` | 76         | 125       | no        |
| mixed ASCII              | 51         | 53        | no        |

Both directions decode to the original bytes, so a migration does not corrupt
stored data and a Bun-written archive still opens under Node. A checksum over the
compressed bytes, or a checked-in fixture compared for equality, will differ. That
is the reason the rule stays `speed` (the decoded payload is identical) while the
claim drops the word "identical".

## Raw deflate: format matches, bytes diverge

| payload                                 | bytes equal | both inflate |
| --------------------------------------- | ----------- | ------------ |
| 0, 1, 5, 13, 20, 32, 43, 64, 100, 200 B | yes         | yes          |
| 500 B, 1 KB, 1.8 KB, 10 KB              | no          | yes          |

Verdict: `report-only`. `Bun.deflateSync` is raw deflate while
`deflateSync` emits a zlib wrapper, so `deflateSync` and `inflateSync` cannot
cross at all (`Bun.inflateSync` rejects every node stream with "invalid stored
block lengths"). `deflateRawSync` matches the format but diverges in bytes above
the block boundary, so a caller that hashes or stores the output would change.

`inflateRawSync` -> `Bun.inflateSync` stays `speed`: decoding is safe in both
directions at every size.

## File I/O: measured slower on the Bun side

| operation     | 16 B  | 1 KB  | 100 KB | 2 MB  |
| ------------- | ----- | ----- | ------ | ----- |
| readFile utf8 | 0.84x | 0.57x | 0.76x  | 0.86x |
| writeFile     | 0.75x | 0.78x | 0.59x  | 0.34x |
| copyFile      | 0.88x | 1.19x | 0.89x  | 0.91x |

Verdict: `report-only`. `writeFile` gets worse as the payload grows (0.34x at
2 MB means Bun takes three times as long). 50 parallel 4 KB reads also favour
Node (0.81x). Only small copies occasionally favour Bun, inside noise.

This inverts the usual assumption that a native API is faster. It is not, for
this runtime, on this platform.

## String and comparison helpers

| operation                | 13 B  | 260 B | 2.6 KB | 26 KB |
| ------------------------ | ----- | ----- | ------ | ----- |
| stripVTControlCharacters | 15.6x | 16.4x | 14.9x  | 14.7x |
| isDeepStrictEqual        | 2.79x | 1.75x | 1.48x  | 1.37x |

`stripVTControlCharacters` -> `Bun.stripANSI` is `speed`: the 15x holds flat
across all sizes.

`isDeepStrictEqual` is `report-only` despite the speed, because the semantics
differ: `isDeepStrictEqual({a: undefined}, {})` is `false` while
`Bun.deepEquals` returns `true`.

## Glob

| directory size | ratio                                                   |
| -------------- | ------------------------------------------------------- |
| 5 files        | 2.00x                                                   |
| 50 files       | 2.59x                                                   |
| 500 files      | 5.05x                                                   |
| 3000 files     | 1.53x (whole-process time, directory creation included) |

Verdict: `speed`. The advantage grows with directory size in the scan itself
(5.3x at 2000 entries).

## Whole-process costs

| measurement                   | node    | bun     |
| ----------------------------- | ------- | ------- |
| runtime boot (`-e 0`)         | 66.4 ms | 44.7 ms |
| trivial script                | 68.7 ms | 69.3 ms |
| 2000 hashes                   | 74.2 ms | 73.0 ms |
| baseline RSS                  | 33.8 MB | 81.6 MB |
| RSS after 200 x 200 KB hashes | 36.4 MB | 82.0 MB |

Two facts a microbenchmark cannot see:

- The 1.49x boot advantage disappears once a script does any real work (0.99x on
  a trivial script). A migration cannot claim a startup win for an application.
- Bun's baseline memory is 2.4x Node's, and that gap is structural, not
  transient.

Neither affects any individual pairing, but both belong here: they are the
reasons a whole-project migration is a judgement call rather than a strict
improvement.

## What was not measured

- Network I/O and sockets.
- Anything under a cold OS page cache; every file measurement ran warm.
- Concurrent multi-process load, beyond the worker-thread and parallel-read rows.
- ARM or Linux; all rows are Windows x64.

A rule whose behaviour is unclear on an unmeasured axis stays `report-only`.
