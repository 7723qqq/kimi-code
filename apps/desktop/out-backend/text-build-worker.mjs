import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs";
import fs$1 from "node:fs/promises";
// ../../packages/minidb/src/crc32.ts
const POLY = 3988292384;
let TABLE = null;
function buildTable() {
	const t = /* @__PURE__ */ new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? POLY ^ c >>> 1 : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
}
/**
* Compute / continue a CRC-32 over `buf`.
*
* @param buf  bytes to checksum
* @param prev previous crc value (for streaming / incremental use)
* @returns unsigned 32-bit crc
*/
function crc32(buf, prev = 0) {
	TABLE ??= buildTable();
	let c = prev ^ 4294967295;
	for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 255] ^ c >>> 8;
	return (c ^ 4294967295) >>> 0;
}
// ../../packages/minidb/src/codec.ts
const MAGIC = Buffer.from([77, 68]);
Buffer.alloc(0);
/**
* Encode a list of ops into a batch body (used as the `value` of a TYPE_BATCH
* frame). The whole body is protected by the outer frame's CRC, so a batch is
* one atomic unit: it either applies fully or is skipped entirely on recovery.
*
* Body layout:
*   count(2) | [ op(1) | keyLen(2) | valLen(4) | metaLen(4) | expireAt(8) |
*               key | value | meta ] ...
*/
const SUB_HEADER = 19;
const CRC_CHUNK = 1 << 20;
/** Corruption-resync candidate budget (stage 6): resynchronization validates
*  every magic-looking position until one parses as a full frame, so a file
*  dense in fake magic bytes costs O(candidates x frame-verification) and can
*  occupy the scanner super-linearly. After this many candidate validations
*  across one scan the rest of the file is given up as corrupt (the
*  conservative strict-mode outcome) instead of burning unbounded time. */
const DEFAULT_RESYNC_CANDIDATE_BUDGET = 65536;
const ASYNC_SCAN_WINDOW = 1 << 22;
const SCAN_YIELD_BYTES = 1 << 23;
const yieldToLoop = () => new Promise((r) => setImmediate(r));
function scanAbortError() {
	const err = /* @__PURE__ */ new Error("frame scan aborted");
	err.name = "AbortError";
	return err;
}
/** Promise wrapper over fs.read (the callback API keeps using the libuv
*  thread pool for a plain fd; fs.promises has no fd-level read). */
function readAt(fd, buf, bufOff, len, pos) {
	return new Promise((resolve, reject) => {
		fs.read(fd, buf, bufOff, len, pos, (err, bytesRead) => err ? reject(err) : resolve(bytesRead));
	});
}
async function readExactAsync(fd, buf, pos) {
	let got = 0;
	while (got < buf.length) {
		const bytesRead = await readAt(fd, buf, got, buf.length - got, pos + got);
		if (bytesRead === 0) throw new Error("codec: short read past EOF");
		got += bytesRead;
	}
}
/** Async twin of readFrameRefAt (chunked positioned reads; values are never
*  copied — only header, key and meta bytes land in RAM). */
async function readFrameRefAtAsync(fd, pos, size) {
	if (size - pos < 22) return null;
	const header = Buffer.allocUnsafe(22);
	await readExactAsync(fd, header, pos);
	if (header[0] !== MAGIC[0] || header[1] !== MAGIC[1]) return null;
	const type = header.readUInt8(2);
	const keyLen = header.readUInt16LE(4);
	const valLen = header.readUInt32LE(6);
	const metaLen = header.readUInt32LE(10);
	if (keyLen > 65535) return null;
	const frameLen = 22 + keyLen + valLen + metaLen + 4;
	if (frameLen < 26) return null;
	if (size - pos < frameLen) return null;
	let crc = 0;
	let crcPos = pos + 2;
	let crcLeft = frameLen - 4 - 2;
	while (crcLeft > 0) {
		const len = Math.min(CRC_CHUNK, crcLeft);
		const buf = Buffer.allocUnsafe(len);
		await readExactAsync(fd, buf, crcPos);
		crc = crc32(buf, crc);
		crcPos += len;
		crcLeft -= len;
	}
	const storedCrcBuf = Buffer.allocUnsafe(4);
	await readExactAsync(fd, storedCrcBuf, pos + frameLen - 4);
	if (storedCrcBuf.readUInt32LE(0) !== crc) return null;
	const keyStart = pos + 22;
	const valueOff = keyStart + keyLen;
	const metaStart = valueOff + valLen;
	const key = Buffer.allocUnsafe(keyLen);
	if (keyLen) await readExactAsync(fd, key, keyStart);
	let meta = null;
	if (metaLen) {
		meta = Buffer.allocUnsafe(metaLen);
		await readExactAsync(fd, meta, metaStart);
	}
	return {
		type,
		key,
		meta,
		expireAt: Number(header.readBigInt64LE(14)),
		frameOff: pos,
		valueOff,
		valLen,
		frameLen
	};
}
/** The buffered-window frame parse: identical validation to readFrameRefAt,
*  but served from the sequential window when the whole frame is inside it.
*  Returns the ref, null (invalid at pos), or 'window' when the frame does
*  not fit the current window (caller refills or falls back to positioned
*  reads). */
function parseFrameRefInWindow(win, winStart, winLen, pos, size) {
	const avail = winStart + winLen - pos;
	if (avail < 22) return null;
	if (size - pos < 22) return null;
	const o = pos - winStart;
	if (win[o] !== MAGIC[0] || win[o + 1] !== MAGIC[1]) return null;
	const type = win.readUInt8(o + 2);
	const keyLen = win.readUInt16LE(o + 4);
	const valLen = win.readUInt32LE(o + 6);
	const metaLen = win.readUInt32LE(o + 10);
	if (keyLen > 65535) return null;
	const frameLen = 22 + keyLen + valLen + metaLen + 4;
	if (frameLen < 26) return null;
	if (size - pos < frameLen) return null;
	if (avail < frameLen) return "window";
	let crc = 0;
	let crcPos = o + 2;
	let crcLeft = frameLen - 4 - 2;
	while (crcLeft > 0) {
		const len = Math.min(CRC_CHUNK, crcLeft);
		crc = crc32(win.subarray(crcPos, crcPos + len), crc);
		crcPos += len;
		crcLeft -= len;
	}
	if (win.readUInt32LE(o + frameLen - 4) !== crc) return null;
	const keyStart = o + 22;
	const valueOff = pos + 22 + keyLen;
	const metaStart = keyStart + keyLen + valLen;
	return {
		type,
		key: Buffer.from(win.subarray(keyStart, keyStart + keyLen)),
		meta: metaLen ? Buffer.from(win.subarray(metaStart, metaStart + metaLen)) : null,
		expireAt: Number(win.readBigInt64LE(o + 14)),
		frameOff: pos,
		valueOff,
		valLen,
		frameLen
	};
}
/** Async sequential scan of an open snapshot/WAL fd into frame refs without
*  copying values. Semantics match scanFrameRefsFd exactly (same corrupt
*  ranges, same eofOffset), with three additions: periodic event-loop yields,
*  AbortSignal cancellation (throws an 'AbortError'), and the resync
*  candidate budget shared with the sync scanner. */
async function scanFrameRefsFdAsync(fd, { onCorrupt = "resync", startOffset = 0, endOffset, signal, maxResyncCandidates = DEFAULT_RESYNC_CANDIDATE_BUDGET } = {}) {
	const size = Math.min(fs.fstatSync(fd).size, endOffset ?? Number.POSITIVE_INFINITY);
	const frames = [];
	const corruptRanges = [];
	const win = Buffer.allocUnsafe(ASYNC_SCAN_WINDOW);
	let winStart = startOffset;
	let winLen = 0;
	let pos = startOffset;
	let sinceYield = 0;
	let resyncCandidates = 0;
	const throwIfAborted = () => {
		if (signal?.aborted) throw scanAbortError();
	};
	/** Read the window covering `pos`: the leftover suffix is compacted when
	*  it overlaps, otherwise the window restarts at pos. */
	const fillWindow = async (at) => {
		const end = winStart + winLen;
		if (at >= winStart && at < end) {
			const keep = end - at;
			win.copyWithin(0, at - winStart, at - winStart + keep);
			winStart = at;
			winLen = keep;
		} else {
			winStart = at;
			winLen = 0;
		}
		while (winLen < win.length && winStart + winLen < size) {
			const bytesRead = await readAt(fd, win, winLen, Math.min(win.length - winLen, size - winStart - winLen), winStart + winLen);
			if (bytesRead === 0) break;
			winLen += bytesRead;
		}
	};
	/** Parse the frame at `pos`, refilling the window or falling back to
	*  chunked positioned reads for a frame larger than the window. */
	const frameAt = async (at) => {
		if (at < winStart || at + 22 > winStart + winLen) await fillWindow(at);
		let r = parseFrameRefInWindow(win, winStart, winLen, at, size);
		if (r !== "window") return r;
		if (at - winStart > 0) {
			await fillWindow(at);
			r = parseFrameRefInWindow(win, winStart, winLen, at, size);
			if (r !== "window") return r;
		}
		return readFrameRefAtAsync(fd, at, size);
	};
	const tick = async (advanced) => {
		sinceYield += advanced;
		if (sinceYield >= SCAN_YIELD_BYTES) {
			sinceYield = 0;
			throwIfAborted();
			await yieldToLoop();
		}
	};
	throwIfAborted();
	while (pos < size) {
		const r = await frameAt(pos);
		if (r) {
			frames.push(r);
			pos += r.frameLen;
			await tick(r.frameLen);
			continue;
		}
		if (onCorrupt === "strict") {
			corruptRanges.push([pos, size]);
			break;
		}
		const badStart = pos;
		let resume = -1;
		let scan = pos + 1;
		while (scan < size - 1) {
			if (scan < winStart || scan >= winStart + winLen) await fillWindow(scan);
			const idx = win.indexOf(MAGIC, scan - winStart);
			const found = idx === -1 ? -1 : winStart + idx;
			if (found === -1) {
				const end = winStart + winLen;
				if (end >= size) {
					scan = size;
					break;
				}
				scan = Math.max(end - (MAGIC.length - 1), scan + 1);
				await tick(ASYNC_SCAN_WINDOW);
				continue;
			}
			scan = found;
			if (scan >= size - 1) break;
			if (resyncCandidates++ >= maxResyncCandidates) {
				scan = size;
				break;
			}
			if (await frameAt(scan)) {
				resume = scan;
				break;
			}
			scan++;
		}
		corruptRanges.push([badStart, resume === -1 ? size : resume]);
		if (resume === -1) break;
		pos = resume;
	}
	throwIfAborted();
	return {
		frames,
		corruptRanges,
		eofOffset: pos
	};
}
/** Scan BATCH body op refs without copying op values. `bodyOff` is the absolute
*  file offset where the BATCH body (the outer frame's value) starts.
*  Strictly validated (review #9): sub-op types must be SET/DEL, every op must
*  stay in bounds, and the body must end exactly after its last op — a
*  violation throws, so the caller (frameToOps) skips the whole batch instead
*  of half-applying it. */
function scanBatchOpRefs(body, bodyOff) {
	const ops = [];
	let o = 0;
	if (body.length < 2) throw new RangeError("batch body truncated: op count");
	const count = body.readUInt16LE(o);
	o += 2;
	for (let i = 0; i < count; i++) {
		if (o + SUB_HEADER > body.length) throw new RangeError("batch op header truncated");
		const type = body.readUInt8(o);
		o += 1;
		if (type !== 1 && type !== 2) throw new RangeError(`batch op has unknown type ${type}`);
		const keyLen = body.readUInt16LE(o);
		o += 2;
		const valLen = body.readUInt32LE(o);
		o += 4;
		const metaLen = body.readUInt32LE(o);
		o += 4;
		const expireAt = Number(body.readBigInt64LE(o));
		o += 8;
		if (o + keyLen + valLen + metaLen > body.length) throw new RangeError("batch op payload truncated");
		const key = Buffer.from(body.subarray(o, o + keyLen));
		const valueOff = bodyOff + o + keyLen;
		o += keyLen + valLen;
		const meta = metaLen ? Buffer.from(body.subarray(o, o + metaLen)) : null;
		o += metaLen;
		ops.push({
			type,
			key,
			valueOff,
			valLen,
			meta,
			expireAt
		});
	}
	if (o !== body.length) throw new RangeError(`batch body has ${body.length - o} trailing byte(s)`);
	return ops;
}
// ../../packages/minidb/src/gen-codec.ts
/** Growable record encoder; one generation file record must fit one chunk. */
var ByteWriter = class {
	buf;
	off = 0;
	constructor(sizeHint = 64) {
		this.buf = Buffer.allocUnsafe(sizeHint);
	}
	ensure(n) {
		if (this.off + n <= this.buf.length) return;
		let cap = this.buf.length * 2;
		while (cap < this.off + n) cap *= 2;
		const next = Buffer.allocUnsafe(cap);
		this.buf.copy(next, 0, 0, this.off);
		this.buf = next;
	}
	u8(v) {
		this.ensure(1);
		this.buf.writeUInt8(v, this.off);
		this.off += 1;
	}
	u16(v) {
		this.ensure(2);
		this.buf.writeUInt16LE(v, this.off);
		this.off += 2;
	}
	u32(v) {
		this.ensure(4);
		this.buf.writeUInt32LE(v >>> 0, this.off);
		this.off += 4;
	}
	u64(v) {
		this.ensure(8);
		this.buf.writeBigUInt64LE(BigInt(v), this.off);
		this.off += 8;
	}
	i64(v) {
		this.ensure(8);
		this.buf.writeBigInt64LE(BigInt(v), this.off);
		this.off += 8;
	}
	f64(v) {
		this.ensure(8);
		this.buf.writeDoubleLE(v, this.off);
		this.off += 8;
	}
	bytes(b) {
		this.ensure(b.length);
		b.copy(this.buf, this.off);
		this.off += b.length;
	}
	/** A canonical (binary) key string: u16 byte length + raw bytes. */
	key(kstr) {
		const b = Buffer.from(kstr, "binary");
		this.u16(b.length);
		this.bytes(b);
	}
	/** A genuine text string: u32 utf8 byte length + utf8 bytes. */
	text(s) {
		const b = Buffer.from(s, "utf8");
		this.u32(b.length);
		this.bytes(b);
	}
	/** A term (bounded by the text index's uint16 limit): u16 + utf8. */
	term(s) {
		const b = Buffer.from(s, "utf8");
		this.u16(b.length);
		this.bytes(b);
	}
};
const FLUSH_BYTES$1 = 1 << 20;
/** Streaming generation-file writer: envelope header, ~1 MiB writev batches,
*  running crc32, fsync on finish. The crc/bytes it reports feed the
*  manifest's per-file integrity records. */
var GenFileWriter = class GenFileWriter {
	fh;
	chunks = [];
	queued = 0;
	crc = 0;
	bytes = 0;
	rec = new ByteWriter(256);
	constructor(fh, magic, version) {
		this.fh = fh;
		const w = new ByteWriter(8);
		for (let i = 0; i < 4; i++) w.u8(magic.charCodeAt(i));
		w.u32(version);
		const head = w.buf.subarray(0, w.off);
		this.chunks.push(Buffer.from(head));
		this.queued = head.length;
	}
	static async open(path, magic, version) {
		if (magic.length !== 4) throw new RangeError("generation file magic must be 4 chars");
		const fh = await fs$1.open(path, "w");
		try {
			return new GenFileWriter(fh, magic, version);
		} catch (error) {
			await fh.close().catch(() => {});
			throw error;
		}
	}
	/** Encode one record with `encode(w)` and queue it for the next batch. */
	async writeRecord(encode) {
		const w = this.rec;
		w.off = 0;
		encode(w);
		const b = Buffer.from(w.buf.subarray(0, w.off));
		this.chunks.push(b);
		this.queued += b.length;
		if (this.queued >= FLUSH_BYTES$1) await this.flush();
	}
	async flush() {
		if (this.chunks.length === 0) return;
		const bufs = this.chunks.splice(0);
		this.queued = 0;
		for (const b of bufs) this.crc = crc32(b, this.crc);
		let idx = 0;
		let off = 0;
		while (idx < bufs.length) {
			const toWrite = off > 0 ? [bufs[idx].subarray(off), ...bufs.slice(idx + 1)] : idx === 0 ? bufs : bufs.slice(idx);
			const { bytesWritten } = await this.fh.writev(toWrite);
			if (bytesWritten === 0) throw new Error("generation file writev made no progress (short write)");
			this.bytes += bytesWritten;
			let rem = bytesWritten;
			while (rem > 0 && idx < bufs.length) {
				const left = bufs[idx].length - off;
				if (rem < left) {
					off += rem;
					rem = 0;
				} else {
					rem -= left;
					idx++;
					off = 0;
				}
			}
		}
	}
	/** Flush, append the crc trailer, fsync, close. Returns the manifest's
	*  per-file integrity record ({ bytes, crc32 }). */
	async finish() {
		try {
			await this.flush();
			const trailer = Buffer.allocUnsafe(4);
			trailer.writeUInt32LE(this.crc >>> 0, 0);
			let written = 0;
			while (written < 4) {
				const { bytesWritten } = await this.fh.write(trailer, written);
				if (bytesWritten === 0) throw new Error("generation file write made no progress (short write)");
				written += bytesWritten;
			}
			this.bytes += 4;
			await this.fh.sync();
			return {
				bytes: this.bytes,
				crc32: this.crc >>> 0
			};
		} finally {
			await this.fh.close().catch(() => {});
		}
	}
	/** Abort without finishing: close (the caller removes the tmp file). */
	async abort() {
		await this.fh.close().catch(() => {});
	}
};
const TEXT_DICT_MAGIC = "MDTD";
const TEXT_DICT_VERSION = 1;
async function writeTextDictionaryImage(path, entries) {
	const w = await GenFileWriter.open(path, TEXT_DICT_MAGIC, TEXT_DICT_VERSION);
	try {
		for (const e of entries) await w.writeRecord((b) => {
			b.term(e.term);
			b.u64(e.off);
			b.u32(e.len);
			b.u32(e.df);
		});
		return await w.finish();
	} catch (error) {
		await w.abort();
		throw error;
	}
}
// ../../packages/minidb/src/query.ts
function tokenizePath(path) {
	if (Array.isArray(path)) return [...path];
	const tokens = [];
	for (const seg of String(path).split(".")) {
		let s = seg;
		while (s.length > 0) {
			const m = s.match(/^([^[]*)\[(\d+)\](.*)$/);
			if (m) {
				if (m[1]) tokens.push(m[1]);
				tokens.push(Number(m[2]));
				s = m[3];
			} else {
				tokens.push(s);
				s = "";
			}
		}
	}
	return tokens;
}
function getPath(doc, path) {
	let cur = doc;
	for (const t of tokenizePath(path)) {
		if (cur === null || cur === void 0) return void 0;
		cur = cur[t];
	}
	return cur;
}
// ../../packages/minidb/src/trigram.ts
const HASH_MASK = (1 << 22) - 1;
/** Normalize text for literal matching: Unicode NFKC (fullwidth `＄` -> `$`,
*  compatibility glyphs folded) + lowercase. The search layer's confirmation
*  step must use this exact function so index and comparison agree. */
function normalizeLiteral(text) {
	return text.normalize("NFKC").toLowerCase();
}
function termFor(gram, width) {
	const hash = crc32(Buffer.from(gram, "utf8")) & HASH_MASK;
	return String(width) + hash.toString(36);
}
/** Build a tokenizer that maps text to hashed n-gram terms (see file header).
*  Windows slide over code points, so astral characters stay whole. */
function createNgramTokenizer(opts = {}) {
	return (text) => {
		const chars = Array.from(normalizeLiteral(text));
		const n = chars.length;
		const terms = [];
		if (n < 2) return terms;
		const widths = opts.forQuery ? n === 2 ? [2] : [3] : n >= 3 ? [3, 2] : [2];
		for (const w of widths) for (let i = 0; i + w <= n; i++) terms.push(termFor(chars.slice(i, i + w).join(""), w));
		return terms;
	};
}
// ../../packages/minidb/src/text-index/tokenize.ts
const LATIN = /[a-z0-9]+/g;
const CJK = /[\u3400-\u9FFF\u3040-\u30FF\uFF00-\uFFEF]+/g;
const MAX_TERM_CHARS = 65535;
/** Tokenize text into terms (lowercased latin words + CJK uni/bigrams). The
*  input is NFKC-normalized first (same fold as trigram's normalizeLiteral),
*  so fullwidth latin/digits match their halfwidth query forms instead of
*  being tokenized as CJK-run unigrams. */
function tokenize(str) {
	const s = normalizeLiteral(String(str));
	const terms = [];
	const latin = s.match(LATIN);
	if (latin) {
		for (const t of latin) if (t.length <= MAX_TERM_CHARS) terms.push(t);
	}
	const runs = s.match(CJK) ?? [];
	for (const r of runs) for (let i = 0; i < r.length; i++) {
		terms.push(r[i]);
		if (i + 1 < r.length) terms.push(r[i] + r[i + 1]);
	}
	return terms;
}
function stringLeaves(obj, acc = []) {
	if (obj === null || obj === void 0) return acc;
	if (typeof obj === "string") {
		acc.push(obj);
		return acc;
	}
	if (typeof obj !== "object") return acc;
	for (const v of Object.values(obj)) stringLeaves(v, acc);
	return acc;
}
/** Extract the indexable text of a document (shared with the generation
*  build's worker: fields mode joins the configured paths, otherwise every
*  string leaf). Internal to the package. */
function extractText(fields, doc) {
	if (fields && fields.length > 0) return fields.map((f) => getPath(doc, f)).filter((v) => typeof v === "string").join(" ");
	return stringLeaves(doc).join(" ");
}
// ../../packages/minidb/src/text-postings.ts
const HEADER_LEN = 10;
const CRC_LEN = 4;
function encodeVarintInto(n, out) {
	n >>>= 0;
	while (n >= 128) {
		out.push(n & 127 | 128);
		n >>>= 7;
	}
	out.push(n);
}
function decodeVarint(buf, cur) {
	let r = 0;
	let shift = 0;
	for (;;) {
		const b = buf[cur.i++];
		if (b === void 0) throw new Error("postings: truncated varint");
		r |= (b & 127) << shift;
		if ((b & 128) === 0) return r >>> 0;
		shift += 7;
		if (shift > 35) throw new Error("postings: varint too long");
	}
}
/** Encode a sorted (by docID asc) list of [docID, freq] pairs. Accepts any
*  sized iterable (an array or a Map's entries view) so a large build never
*  materializes a per-term copy — a hot term's list can have millions of
*  entries and spreading it was an OOM vector. */
function encodePostingList(entries) {
	const count = Array.isArray(entries) ? entries.length : entries.size;
	const bytes = [];
	encodeVarintInto(count, bytes);
	let prev = 0;
	for (const [docID, freq] of entries) {
		encodeVarintInto(docID - prev, bytes);
		encodeVarintInto(freq, bytes);
		prev = docID;
	}
	return Buffer.from(bytes);
}
/**
* Decode a payload back into [docID, freq] pairs (ascending docID). With
* `maxEntries`, only that many leading pairs are decoded (docIDs ascend, so
* this is the lowest-docID prefix): a query-time work budget can stop the
* decode of a hot term's list early instead of always paying its full length.
*/
function decodePostingList(buf, maxEntries) {
	const cur = { i: 0 };
	const count = decodeVarint(buf, cur);
	const n = maxEntries === void 0 ? count : Math.min(count, maxEntries);
	const out = Array.from({ length: n });
	let prev = 0;
	for (let k = 0; k < n; k++) {
		const d = decodeVarint(buf, cur);
		const freq = decodeVarint(buf, cur);
		prev += d;
		out[k] = [prev, freq];
	}
	return out;
}
/** Encode one term's record frame (with CRC trailer). */
function encodeRecord(term, df, payload) {
	const termBuf = Buffer.from(term, "utf8");
	if (termBuf.length > 65535) throw new RangeError("postings: term too long");
	const bodyLen = HEADER_LEN + termBuf.length + payload.length;
	const body = Buffer.alloc(bodyLen);
	let o = 0;
	body.writeUInt16LE(termBuf.length, o);
	o += 2;
	termBuf.copy(body, o);
	o += termBuf.length;
	body.writeUInt32LE(df >>> 0, o);
	o += 4;
	body.writeUInt32LE(payload.length, o);
	o += 4;
	payload.copy(body, o);
	const crc = crc32(body);
	const out = Buffer.alloc(bodyLen + CRC_LEN);
	body.copy(out, 0);
	out.writeUInt32LE(crc >>> 0, bodyLen);
	return out;
}
/** Decode + CRC-verify a record frame. */
function decodeRecord(buf) {
	if (buf.length < 14) throw new Error("postings: record too short");
	if (buf.readUInt32LE(buf.length - CRC_LEN) !== crc32(buf.subarray(0, buf.length - CRC_LEN))) throw new Error("postings: record crc mismatch");
	let o = 0;
	const termLen = buf.readUInt16LE(o);
	o += 2;
	if (o + termLen + 4 + 4 > buf.length - CRC_LEN) throw new Error("postings: record term length out of bounds");
	const term = buf.toString("utf8", o, o + termLen);
	o += termLen;
	const df = buf.readUInt32LE(o);
	o += 4;
	const payloadLen = buf.readUInt32LE(o);
	o += 4;
	if (o + payloadLen > buf.length - CRC_LEN) throw new Error("postings: record payload length out of bounds");
	return {
		term,
		df,
		payload: buf.subarray(o, o + payloadLen)
	};
}
// ../../packages/minidb/src/worker/text-build-core.ts
function abortError() {
	const err = /* @__PURE__ */ new Error("text build aborted");
	err.name = "AbortError";
	return err;
}
/** Progress cadence AND the worker's own thread-yield cadence: every this
*  many docs the build checks cancellation, reports progress, and yields
*  its thread (setImmediate), so the tokenization run never becomes one
*  multi-hundred-ms CPU burst — that keeps the host process's other threads
*  (the main event loop) smoothly scheduled on platforms with coarse CPU
*  time-slicing. */
const PROGRESS_DOCS = 2048;
/** Segment/postings write coalescing. */
const FLUSH_BYTES = 1 << 20;
/** Estimated RAM per (term, docID) aggregation entry plus per-term overhead:
*  the budget's accounting currency (approximation, not an exact RSS). */
const AGG_ENTRY_BYTES = 56;
const AGG_TERM_BYTES = 96;
function readAtSync(fd, off, len) {
	if (len === 0) return Buffer.alloc(0);
	const buf = Buffer.allocUnsafe(len);
	let got = 0;
	while (got < len) {
		const r = fs.readSync(fd, buf, got, len - got, off + got);
		if (r === 0) throw new Error("text build: short read past EOF");
		got += r;
	}
	return buf;
}
/** Apply one frame to the live loc map, mirroring recovery's frameToOps
*  (expired SET → DEL, BATCH unrolled with whole-batch skip on a malformed
*  body). Value bytes are never copied — only their locations. Returns true
*  when the frame was an expired-SET drop. */
function applyFrame(f, file, fd, live, now) {
	let droppedExpired = false;
	const applySet = (key, valueOff, valLen, expireAt) => {
		const k = key.toString("binary");
		if (expireAt && expireAt <= now) {
			live.delete(k);
			droppedExpired = true;
			return;
		}
		live.set(k, {
			file,
			off: valueOff,
			len: valLen
		});
	};
	const applyDel = (key) => {
		live.delete(key.toString("binary"));
	};
	if (f.type === 1) applySet(f.key, f.valueOff, f.valLen, f.expireAt);
	else if (f.type === 2) applyDel(f.key);
	else if (f.type === 3) {
		let ops;
		try {
			ops = scanBatchOpRefs(readAtSync(fd, f.valueOff, f.valLen), f.valueOff);
		} catch {
			return false;
		}
		for (const op of ops) if (op.type === 1) applySet(op.key, op.valueOff, op.valLen, op.expireAt);
		else if (op.type === 2) applyDel(op.key);
	}
	return droppedExpired;
}
/** Append one index's sorted aggregation as a segment file (sorted term
*  records in the native postings record framing). `syncIo` selects
*  writeSync (worker thread) over thread-pool writes (inline fallback) —
*  see TextBuildCoreSpec.syncIo. */
async function flushSegment(segPath, agg, syncIo) {
	const terms = [...agg.keys()].sort();
	const fh = await fs$1.open(segPath, "w");
	let batch = [];
	let batchBytes = 0;
	const flush = async () => {
		if (batch.length === 0) return;
		const buf = Buffer.concat(batch);
		batch = [];
		batchBytes = 0;
		let written = 0;
		while (written < buf.length) {
			const n = syncIo ? fs.writeSync(fh.fd, buf, written) : (await fh.write(buf, written)).bytesWritten;
			if (n === 0) throw new Error("text build: segment write made no progress");
			written += n;
		}
	};
	try {
		for (const term of terms) {
			const entries = agg.get(term);
			const rec = encodeRecord(term, entries.size, encodePostingList(entries));
			batch.push(rec);
			batchBytes += rec.length;
			if (batchBytes >= FLUSH_BYTES) await flush();
		}
		await flush();
		if (syncIo) fs.fsyncSync(fh.fd);
		else await fh.sync();
	} finally {
		await fh.close().catch(() => {});
	}
}
/** Sequential reader over one sorted segment file. */
var SegmentReader = class SegmentReader {
	fd;
	buf = Buffer.allocUnsafe(1 << 20);
	bufStart = 0;
	bufLen = 0;
	pos = 0;
	size;
	current = null;
	constructor(segPath) {
		this.fd = fs.openSync(segPath, "r");
		this.size = fs.fstatSync(this.fd).size;
	}
	static async open(segPath) {
		const r = new SegmentReader(segPath);
		await r.advance();
		return r;
	}
	async fill() {
		const end = this.bufStart + this.bufLen;
		if (this.pos < end) {
			this.buf.copyWithin(0, this.pos - this.bufStart, end);
			this.bufLen = end - this.pos;
			this.bufStart = this.pos;
		} else {
			this.bufStart = this.pos;
			this.bufLen = 0;
		}
		while (this.bufLen < this.buf.length && this.bufStart + this.bufLen < this.size) {
			const n = fs.readSync(this.fd, this.buf, this.bufLen, Math.min(this.buf.length - this.bufLen, this.size - this.bufStart - this.bufLen), this.bufStart + this.bufLen);
			if (n === 0) break;
			this.bufLen += n;
		}
	}
	/** Advance to the next record; current becomes null at EOF. */
	async advance() {
		for (;;) {
			const avail = this.bufStart + this.bufLen - this.pos;
			if (avail >= 2) {
				const o = this.pos - this.bufStart;
				const termLen = this.buf.readUInt16LE(o);
				if (avail >= 2 + termLen + 8) {
					const payloadLen = this.buf.readUInt32LE(o + 2 + termLen + 4);
					const recLen = 2 + termLen + 8 + payloadLen + 4;
					if (recLen > this.size - this.pos) throw new Error(`text build: segment record overruns the file (${recLen} bytes at ${this.pos}, size ${this.size})`);
					if (avail >= recLen) {
						const rec = decodeRecord(Buffer.from(this.buf.subarray(o, o + recLen)));
						this.current = {
							term: rec.term,
							df: rec.df,
							payload: Buffer.from(rec.payload)
						};
						this.pos += recLen;
						return;
					}
					if (recLen > this.buf.length) {
						const tmp = Buffer.allocUnsafe(recLen);
						let got = 0;
						while (got < recLen) {
							const n = fs.readSync(this.fd, tmp, got, recLen - got, this.pos + got);
							if (n === 0) throw new Error("text build: segment read made no progress");
							got += n;
						}
						const rec = decodeRecord(tmp);
						this.current = {
							term: rec.term,
							df: rec.df,
							payload: Buffer.from(rec.payload)
						};
						this.pos += recLen;
						return;
					}
				} else if (this.bufStart + this.bufLen >= this.size) throw new Error(`text build: truncated segment record header (${this.size - this.pos} bytes at ${this.pos}, size ${this.size})`);
			}
			if (this.bufStart + this.bufLen >= this.size && this.pos >= this.bufStart + this.bufLen) {
				this.current = null;
				return;
			}
			await this.fill();
		}
	}
	close() {
		fs.closeSync(this.fd);
	}
};
/** Streams postings records to the target file with a running whole-file
*  crc32 (the integrity record the generation manifest carries). `syncIo`
*  selects writeSync (worker thread) over thread-pool writes. */
var RawPostingsWriter = class RawPostingsWriter {
	filePath;
	syncIo;
	batch = [];
	batchBytes = 0;
	crc = 0;
	off = 0;
	fh = null;
	constructor(filePath, syncIo) {
		this.filePath = filePath;
		this.syncIo = syncIo;
	}
	static async open(filePath, opts = {}) {
		const w = new RawPostingsWriter(filePath, opts.syncIo ?? false);
		w.fh = await fs$1.open(filePath, "w");
		return w;
	}
	async flush() {
		if (this.batch.length === 0) return;
		const buf = Buffer.concat(this.batch);
		this.batch = [];
		this.batchBytes = 0;
		this.crc = crc32(buf, this.crc);
		let written = 0;
		while (written < buf.length) {
			const n = this.syncIo ? fs.writeSync(this.fh.fd, buf, written) : (await this.fh.write(buf, written)).bytesWritten;
			if (n === 0) throw new Error("text build: postings write made no progress");
			written += n;
		}
	}
	async write(rec) {
		const at = this.off;
		this.batch.push(rec);
		this.batchBytes += rec.length;
		this.off += rec.length;
		if (this.batchBytes >= FLUSH_BYTES) await this.flush();
		return at;
	}
	async finish() {
		try {
			await this.flush();
			if (this.syncIo) fs.fsyncSync(this.fh.fd);
			else await this.fh.sync();
			return {
				bytes: this.off,
				crc32: this.crc >>> 0
			};
		} finally {
			await this.fh.close().catch(() => {});
		}
	}
	async abort() {
		await this.fh.close().catch(() => {});
	}
};
const BASE_DOCS_MAGIC = "MDTB";
/** The base doc table produced by the worker: docID -> key (undefined = the
*  docID was never assigned beyond this count — worker bases are dense) and
*  docID -> token count. The main thread reads it back to attach the base;
*  the generation's final docs image (delta/tombstones included) is written
*  by the main thread after the queue replay, from the live index. */
async function writeBaseDocsImage(filePath, keys, docLens) {
	const w = await GenFileWriter.open(filePath, BASE_DOCS_MAGIC, 1);
	try {
		await w.writeRecord((b) => b.u64(keys.length));
		for (let i = 0; i < keys.length; i++) {
			const k = keys[i];
			const len = docLens.get(i) ?? 0;
			await w.writeRecord((b) => {
				if (k === void 0) b.u8(0);
				else {
					b.u8(1);
					b.key(k);
				}
				b.u32(len);
			});
		}
		return await w.finish();
	} catch (error) {
		await w.abort();
		throw error;
	}
}
function tokenizerFor(name) {
	if (name === "ngram") return createNgramTokenizer();
	return tokenize;
}
/** Run the whole pinned-source text build (see the file header). Async; the
*  caller hosts it in a worker thread or inline. */
async function buildTextArtifacts(spec) {
	const throwIfAborted = () => {
		if (spec.signal?.aborted) throw abortError();
	};
	const now = Date.now();
	const live = /* @__PURE__ */ new Map();
	let expiredSkipped = 0;
	if (spec.snapshotPath !== null) {
		const fd = fs.openSync(spec.snapshotPath, "r");
		try {
			const st = fs.fstatSync(fd);
			if (st.dev !== spec.snapshotDev || st.ino !== spec.snapshotIno) throw new Error("text build: snapshot anchor mismatch (rotated)");
			const r = await scanFrameRefsFdAsync(fd, {
				onCorrupt: "resync",
				signal: spec.signal
			});
			for (const f of r.frames) if (applyFrame(f, "snapshot", fd, live, now)) expiredSkipped++;
		} finally {
			fs.closeSync(fd);
		}
	}
	{
		const fd = fs.openSync(spec.walPath, "r");
		try {
			const st = fs.fstatSync(fd);
			if (st.dev !== spec.walDev || st.ino !== spec.walIno) throw new Error("text build: WAL anchor mismatch (rotated)");
			const r = await scanFrameRefsFdAsync(fd, {
				onCorrupt: "resync",
				endOffset: spec.walOffset,
				signal: spec.signal
			});
			if (r.eofOffset !== spec.walOffset) throw new Error(`text build: WAL prefix does not reach the checkpoint (${r.eofOffset} != ${spec.walOffset})`);
			for (const f of r.frames) if (applyFrame(f, "wal", fd, live, now)) expiredSkipped++;
		} finally {
			fs.closeSync(fd);
		}
	}
	throwIfAborted();
	const ordered = [...live.entries()].sort((a, b) => a[1].file < b[1].file ? -1 : a[1].file > b[1].file ? 1 : a[1].off - b[1].off);
	const states = spec.indexes.map((indexSpec) => ({
		spec: indexSpec,
		tokenizer: tokenizerFor(indexSpec.tokenizer),
		agg: /* @__PURE__ */ new Map(),
		aggEntries: 0,
		aggBytes: 0,
		docLens: /* @__PURE__ */ new Map(),
		segments: [],
		seq: 0
	}));
	const keys = [];
	let docsIndexed = 0;
	let progressDocs = 0;
	const fds = /* @__PURE__ */ new Map();
	const fdFor = (file) => {
		let fd = fds.get(file);
		if (fd === void 0) {
			fd = fs.openSync(file === "snapshot" ? spec.snapshotPath : spec.walPath, "r");
			fds.set(file, fd);
		}
		return fd;
	};
	const flushState = async (st) => {
		if (st.aggEntries === 0) return;
		const segPath = `${st.spec.postingsPath}.seg-${String(st.seq++).padStart(4, "0")}`;
		await flushSegment(segPath, st.agg, spec.syncIo ?? false);
		st.segments.push(segPath);
		st.agg.clear();
		st.aggEntries = 0;
		st.aggBytes = 0;
	};
	const READ_RUN_GAP = 4096;
	const READ_RUN_CAP = 1 << 20;
	const fileSizes = /* @__PURE__ */ new Map();
	const sizeOf = (file) => {
		let s = fileSizes.get(file);
		if (s === void 0) {
			s = fs.fstatSync(fdFor(file)).size;
			fileSizes.set(file, s);
		}
		return s;
	};
	let runBuf = null;
	let runFile = null;
	let runStart = 0;
	const valueAt = (file, off, len) => {
		if (runBuf === null || runFile !== file || off < runStart || off + len > runStart + runBuf.length) {
			const runLen = Math.min(READ_RUN_CAP, Math.max(len, READ_RUN_GAP), sizeOf(file) - off);
			runBuf = readAtSync(fdFor(file), off, runLen);
			runFile = file;
			runStart = off;
		}
		return runBuf.subarray(off - runStart, off - runStart + len);
	};
	try {
		for (const [kstr, loc] of ordered) {
			const raw = valueAt(loc.file, loc.off, loc.len);
			let doc;
			try {
				doc = JSON.parse(raw.toString("utf8"));
			} catch {
				doc = void 0;
			}
			if (doc === null || typeof doc !== "object") continue;
			const docID = keys.length;
			keys.push(kstr);
			for (const st of states) {
				const text = extractText(st.spec.fields, doc);
				const tokens = st.tokenizer(text);
				st.docLens.set(docID, tokens.length);
				if (tokens.length === 0) continue;
				const counts = /* @__PURE__ */ new Map();
				for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
				for (const [t, c] of counts) {
					let m = st.agg.get(t);
					if (!m) {
						st.agg.set(t, m = /* @__PURE__ */ new Map());
						st.aggBytes += AGG_TERM_BYTES + Buffer.byteLength(t, "utf8");
					}
					m.set(docID, c);
					st.aggEntries++;
					st.aggBytes += AGG_ENTRY_BYTES;
				}
				if (st.aggBytes >= spec.memoryBudgetBytes) await flushState(st);
			}
			docsIndexed++;
			progressDocs++;
			if (progressDocs >= PROGRESS_DOCS) {
				progressDocs = 0;
				throwIfAborted();
				await new Promise((r) => setImmediate(r));
				spec.onProgress?.({
					docs: docID + 1,
					terms: states.reduce((a, s) => a + s.agg.size, 0),
					segments: states.reduce((a, s) => a + s.segments.length, 0)
				});
			}
		}
		throwIfAborted();
		const results = [];
		for (const st of states) {
			if (st.segments.length > 0) await flushState(st);
			const dict = /* @__PURE__ */ new Map();
			const writer = await RawPostingsWriter.open(st.spec.postingsPath, { syncIo: spec.syncIo ?? false });
			let postingsInfo;
			try {
				if (st.segments.length === 0) {
					const terms = [...st.agg.keys()].sort();
					for (const term of terms) {
						const entries = st.agg.get(term);
						const rec = encodeRecord(term, entries.size, encodePostingList(entries));
						const at = await writer.write(rec);
						dict.set(term, {
							off: at,
							len: rec.length,
							df: entries.size
						});
					}
				} else await mergeSegments(st.segments, writer, dict);
				postingsInfo = await writer.finish();
			} catch (error) {
				await writer.abort();
				throw error;
			} finally {
				for (const segPath of st.segments) await fs$1.rm(segPath, { force: true }).catch(() => {});
			}
			throwIfAborted();
			const dictionaryInfo = await writeTextDictionaryImage(st.spec.dictionaryPath, (function* () {
				for (const [term, e] of dict) yield {
					term,
					off: e.off,
					len: e.len,
					df: e.df
				};
			})());
			const baseDocsInfo = await writeBaseDocsImage(st.spec.baseDocsPath, keys, st.docLens);
			results.push({
				name: st.spec.name,
				liveCount: docsIndexed,
				dictTerms: dict.size,
				postingsInfo,
				dictionaryInfo,
				baseDocsInfo,
				segmentsFlushed: st.segments.length
			});
			spec.onProgress?.({
				docs: keys.length,
				terms: dict.size,
				segments: st.segments.length
			});
		}
		return {
			indexes: results,
			scannedLiveKeys: live.size,
			expiredSkipped,
			docsIndexed
		};
	} finally {
		for (const fd of fds.values()) fs.closeSync(fd);
	}
}
/** K-way external merge of sorted segment files into the postings file:
*  docIDs ascend within and across segments (they are assigned in key order
*  and segments flush in docID order), so a term's lists concatenate without
*  a re-sort; only the delta chains are re-encoded jointly. */
async function mergeSegments(segments, writer, dict) {
	const readers = await Promise.all(segments.map((p) => SegmentReader.open(p)));
	try {
		for (;;) {
			let minTerm = null;
			for (const r of readers) {
				const cur = r.current;
				if (cur !== null && (minTerm === null || cur.term < minTerm)) minTerm = cur.term;
			}
			if (minTerm === null) break;
			const merged = [];
			for (const r of readers) {
				const cur = r.current;
				if (cur === null || cur.term !== minTerm) continue;
				const pairs = decodePostingList(cur.payload);
				for (const p of pairs) merged.push(p);
				await r.advance();
			}
			const rec = encodeRecord(minTerm, merged.length, encodePostingList(merged));
			const at = await writer.write(rec);
			dict.set(minTerm, {
				off: at,
				len: rec.length,
				df: merged.length
			});
		}
	} finally {
		for (const r of readers) r.close();
	}
}
// ../../packages/minidb/src/worker/text-build-worker.ts
const controller = new AbortController();
parentPort?.on("message", (m) => {
	if (m && m.type === "cancel") controller.abort();
});
const spec = {
	...workerData,
	signal: controller.signal,
	syncIo: true,
	onProgress: (progress) => {
		parentPort?.postMessage({
			type: "progress",
			...progress
		});
	}
};
parentPort?.postMessage({
	type: "ready",
	version: 1
});
try {
	const message = {
		type: "done",
		result: await buildTextArtifacts(spec)
	};
	parentPort?.postMessage(message);
} catch (error) {
	const message = {
		type: "failed",
		error: error instanceof Error ? error.message : String(error),
		aborted: error?.name === "AbortError"
	};
	parentPort?.postMessage(message);
}
export {};
