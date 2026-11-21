import fs, { writeSync } from "node:fs";
import { Worker, parentPort, workerData } from "node:worker_threads";
import path, { join, relative } from "node:path";
import fs$1 from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
// ../../packages/minidb/src/worker-runtime.ts
let configuredEntry = null;
function assertRegularFile(filePath) {
	let stat;
	try {
		stat = fs.statSync(filePath);
	} catch (error) {
		throw new TypeError(`MiniDb text-build worker entry is not readable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	if (!stat.isFile()) throw new TypeError("MiniDb text-build worker entry must be a regular file");
}
/** Configure the packaged worker entry once during process startup. */
function configureTextBuildWorkerRuntime(entry) {
	let next;
	if (typeof entry === "string") {
		if (!path.isAbsolute(entry)) throw new TypeError("MiniDb packaged text-build worker entry must be an absolute path");
		assertRegularFile(entry);
		next = {
			kind: "packaged",
			path: entry
		};
	} else {
		if (entry.protocol !== "file:" || !entry.pathname.endsWith(".ts")) throw new TypeError("MiniDb source text-build worker entry must be a file: URL to a .ts file");
		assertRegularFile(Bun.fileURLToPath(entry));
		next = {
			kind: "source",
			url: entry
		};
	}
	if (configuredEntry !== null) {
		if ((configuredEntry.kind === "packaged" ? configuredEntry.path : configuredEntry.url.href) !== (next.kind === "packaged" ? next.path : next.url.href)) throw new Error("MiniDb text-build worker runtime is already configured");
		return {
			configured: true,
			entry: configuredEntry
		};
	}
	configuredEntry = next;
	return {
		configured: true,
		entry: configuredEntry
	};
}
function getTextBuildWorkerRuntimeState() {
	return configuredEntry === null ? { configured: false } : {
		configured: true,
		entry: configuredEntry
	};
}
// ../../packages/kap-server/src/search/contract.ts
var GlobalSearchError = class extends Error {
	reason;
	constructor(reason, message) {
		super(message);
		this.reason = reason;
		this.name = "GlobalSearchError";
	}
};
// ../../packages/minidb/src/rename-replace.ts
const sleep$1 = (ms) => new Promise((r) => setTimeout(r, ms));
async function retryEperm(op, opts = {}) {
	const retries = opts.retries ?? 100;
	const base = opts.baseDelayMs ?? 20;
	for (let attempt = 0;; attempt++) try {
		return await op();
	} catch (e) {
		if (e.code !== "EPERM" || attempt >= retries) throw e;
		await sleep$1(base + Math.floor(Math.random() * (base + 10)));
	}
}
async function withWindowsEpermRetry(op, opts = {}) {
	if (process.platform !== "win32") return op();
	return retryEperm(op, opts);
}
async function renameReplace(src, dst, opts = {}) {
	return withWindowsEpermRetry(() => fs$1.rename(src, dst), opts);
}
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
var CorruptFrameError = class extends Error {
	offset;
	constructor(message, offset) {
		super(message);
		this.name = "CorruptFrameError";
		this.offset = offset;
	}
};
const EMPTY = Buffer.alloc(0);
/**
* Encode one record into a single Buffer.
*/
function encodeFrame({ type, key, value = null, meta = null, expireAt = 0 }) {
	if (!Buffer.isBuffer(key)) throw new TypeError("key must be a Buffer");
	if (key.length > 65535) throw new RangeError("key too large");
	const val = value ?? EMPTY;
	const met = meta ?? EMPTY;
	if (type === 1 && !Buffer.isBuffer(val)) throw new TypeError("value must be a Buffer for SET");
	if (!Buffer.isBuffer(met)) throw new TypeError("meta must be a Buffer");
	if (val.length > 4294967295) throw new RangeError("value too large");
	if (met.length > 4294967295) throw new RangeError("meta too large");
	const frame = Buffer.allocUnsafe(22 + key.length + val.length + met.length + 4);
	let o = 0;
	MAGIC.copy(frame, o);
	o += 2;
	frame.writeUInt8(type, o);
	o += 1;
	frame.writeUInt8(0, o);
	o += 1;
	frame.writeUInt16LE(key.length, o);
	o += 2;
	frame.writeUInt32LE(val.length, o);
	o += 4;
	frame.writeUInt32LE(met.length, o);
	o += 4;
	frame.writeBigInt64LE(BigInt(expireAt ?? 0), o);
	o += 8;
	key.copy(frame, o);
	o += key.length;
	val.copy(frame, o);
	o += val.length;
	met.copy(frame, o);
	o += met.length;
	const c = crc32(frame.subarray(2, o));
	frame.writeUInt32LE(c, o);
	return frame;
}
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
function encodeBatchOps(ops) {
	let total = 2;
	for (const op of ops) {
		if (op.type !== 1 && op.type !== 2) throw new RangeError(`batch op type must be SET or DEL, got ${op.type}`);
		total += SUB_HEADER + op.key.length + (op.value ? op.value.length : 0) + (op.meta ? op.meta.length : 0);
	}
	const body = Buffer.allocUnsafe(total);
	let o = 0;
	body.writeUInt16LE(ops.length, o);
	o += 2;
	for (const op of ops) {
		const key = op.key;
		const val = op.value ?? EMPTY;
		const met = op.meta ?? EMPTY;
		body.writeUInt8(op.type, o);
		o += 1;
		body.writeUInt16LE(key.length, o);
		o += 2;
		body.writeUInt32LE(val.length, o);
		o += 4;
		body.writeUInt32LE(met.length, o);
		o += 4;
		body.writeBigInt64LE(BigInt(op.expireAt ?? 0), o);
		o += 8;
		key.copy(body, o);
		o += key.length;
		val.copy(body, o);
		o += val.length;
		met.copy(body, o);
		o += met.length;
	}
	return body;
}
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
const yieldToLoop$3 = () => new Promise((r) => setImmediate(r));
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
			await yieldToLoop$3();
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
// ../../packages/minidb/src/snapshot.ts
const yieldToLoop$2 = () => new Promise((r) => setImmediate(r));
const FLUSH_BYTES$3 = 1 << 20;
/** Stage 6 defaults: at most this many positioned reads in flight, and at
*  most this many value bytes collected per work slice. */
const DEFAULT_READ_CONCURRENCY = 8;
const DEFAULT_SLICE_BYTES = 8 << 20;
async function writeSnapshot(store, tmpPath, opts = {}) {
	const yieldEvery = opts.yieldEvery ?? 2e3;
	const readConcurrency = Math.max(1, opts.readConcurrency ?? DEFAULT_READ_CONCURRENCY);
	const sliceBytes = Math.max(1, opts.sliceBytes ?? DEFAULT_SLICE_BYTES);
	const fh = await fs$1.open(tmpPath, "w");
	let count = 0;
	let bytes = 0;
	let batch = [];
	let batchBytes = 0;
	const locs = /* @__PURE__ */ new Map();
	const flushBatch = async () => {
		if (batch.length === 0) return;
		let bufs = batch;
		let off = 0;
		while (bufs.length > 0) {
			const toWrite = off > 0 ? [bufs[0].subarray(off), ...bufs.slice(1)] : bufs;
			const { bytesWritten } = await fh.writev(toWrite);
			if (bytesWritten === 0) throw new Error("snapshot writev made no progress (short write)");
			bytes += bytesWritten;
			let rem = bytesWritten;
			while (rem > 0 && bufs.length > 0) {
				const left = bufs[0].length - off;
				if (rem < left) {
					off += rem;
					rem = 0;
				} else {
					rem -= left;
					bufs.shift();
					off = 0;
				}
			}
		}
		batch = [];
		batchBytes = 0;
	};
	const writeRecord = async (key, value, expireAt, dt) => {
		const frame = encodeFrame({
			type: 1,
			key,
			value,
			expireAt,
			meta: dt ? Buffer.from(JSON.stringify({ dt })) : null
		});
		const frameOff = bytes + batchBytes;
		locs.set(key.toString("binary"), {
			file: "snapshot",
			off: frameOff + 22 + key.length,
			len: value.length
		});
		batch.push(frame);
		batchBytes += frame.length;
		count++;
		if (batchBytes >= FLUSH_BYTES$3) await flushBatch();
		if (count % yieldEvery === 0) await yieldToLoop$2();
	};
	try {
		const memRecs = [];
		const diskRecs = [];
		for (const r of store.rawRefRecords()) {
			const key = Buffer.from(r.kstr, "binary");
			if (r.ref.kind === "memory") memRecs.push({
				key,
				value: r.ref.value,
				loc: null,
				expireAt: r.expireAt,
				dt: r.dt
			});
			else diskRecs.push({
				key,
				value: null,
				loc: r.ref.loc,
				expireAt: r.expireAt,
				dt: r.dt
			});
		}
		for (const rec of memRecs) await writeRecord(rec.key, rec.value, rec.expireAt, rec.dt);
		if (diskRecs.length > 0) {
			diskRecs.sort((a, b) => a.loc.file < b.loc.file ? -1 : a.loc.file > b.loc.file ? 1 : a.loc.off - b.loc.off);
			if (!opts.readValueAsync) for (const rec of diskRecs) {
				const value = store.get(rec.key);
				if (value === void 0) continue;
				await writeRecord(rec.key, value, rec.expireAt, rec.dt);
			}
			else {
				const readValue = opts.readValueAsync;
				let i = 0;
				while (i < diskRecs.length) {
					let sliceLen = 0;
					let j = i;
					while (j < diskRecs.length && (j === i || sliceLen < sliceBytes)) {
						sliceLen += diskRecs[j].loc.len;
						j++;
					}
					const slice = diskRecs.slice(i, j);
					const values = Array.from({ length: slice.length });
					let cursor = 0;
					const workers = Array.from({ length: Math.min(readConcurrency, slice.length) }, async () => {
						for (;;) {
							const idx = cursor++;
							if (idx >= slice.length) return;
							const rec = slice[idx];
							values[idx] = await readValue(rec.loc);
						}
					});
					await Promise.all(workers);
					for (let k = 0; k < slice.length; k++) {
						const value = values[k];
						if (value === void 0) continue;
						const rec = slice[k];
						await writeRecord(rec.key, value, rec.expireAt, rec.dt);
					}
					i = j;
					await yieldToLoop$2();
				}
			}
		}
		await flushBatch();
		await fh.sync();
	} finally {
		await fh.close();
	}
	return {
		count,
		bytes,
		locs
	};
}
// ../../packages/minidb/src/op-tracker.ts
var OpTracker = class {
	count = 0;
	open = true;
	pausers = 0;
	permanentlyClosed = false;
	idleWaiters = [];
	closePromise = null;
	/** In-flight op count (diagnostics and tests). */
	get inFlight() {
		return this.count;
	}
	/** False once the gate is closed (pause or close). */
	get gateOpen() {
		return this.open;
	}
	/** Try to register one op. True: the caller owns exactly one leave().
	*  False: the gate is closed — reject or skip the op, never block. */
	enter() {
		if (!this.open) return false;
		this.count++;
		return true;
	}
	/** Release one enter(). Resolves every idle waiter when the count hits 0. */
	leave() {
		if (this.count <= 0) throw new Error("OpTracker: leave() without a matching enter()");
		this.count--;
		if (this.count === 0) {
			const waiters = this.idleWaiters;
			this.idleWaiters = [];
			for (const resolve of waiters) resolve();
		}
	}
	/** Resolve the next time the in-flight count reaches 0 (gate untouched). */
	whenIdle() {
		if (this.count === 0) return Promise.resolve();
		return new Promise((resolve) => this.idleWaiters.push(resolve));
	}
	/** Close the gate and wait for the drain; reopen with resume(). The gate
	*  closes SYNCHRONOUSLY at call time (the async keyword only defers the
	*  whenIdle await), and pause is reference-counted: overlapping pausers all
	*  drain and the gate reopens only when the last one resumes. The drain
	*  completion is the caller's quiescence point. */
	async pause() {
		this.pausers++;
		this.open = false;
		await this.whenIdle();
	}
	/** Release one pause(); reopens the gate when the last pauser resumes.
	*  No-op after close() (close is terminal). */
	resume() {
		if (this.permanentlyClosed) return;
		if (this.pausers > 0) this.pausers--;
		if (this.pausers === 0) this.open = true;
	}
	/** Permanently close the gate and resolve once drained. Idempotent and
	*  shared: concurrent close() calls await the same drain. */
	close() {
		if (!this.closePromise) {
			this.permanentlyClosed = true;
			this.open = false;
			this.closePromise = this.whenIdle();
		}
		return this.closePromise;
	}
};
// ../../packages/minidb/src/wal.ts
const POLICIES = /* @__PURE__ */ new Set([
	"always",
	"everysec",
	"no"
]);
var WAL = class {
	path;
	policy;
	syncIntervalMs;
	fh = null;
	size = 0;
	nextOffset = 0;
	queue = [];
	queuedBytes = 0;
	flushing = false;
	inflight = null;
	scheduled = false;
	/** When sealed, appendLoc rejects new frames (code 'WAL_SEALED') while the
	*  already-queued frames can still be flushed. Compaction rotation seals the
	*  old WAL so no append can slip between the final flush and close(): any
	*  frame that will ever land in the old file is durable after one flush. */
	sealed = false;
	/** Set by the first failed flush (or poisonPending): the WAL stops accepting
	*  appends until the owner recovers it in place (see the header). Distinct
	*  from `sealed`: seal is a normal compaction rotation (rejections are
	*  retried against the new WAL), poison is a fault state (hard failures). */
	poisoned = null;
	/** Id of the batch the next drain will carry. appendLoc stamps each frame
	*  with it so the owner can track per-flush-group pre-state; flushBatch
	*  increments it at drain time, so same-tick appends always share an id. */
	nextBatchId = 1;
	timer = null;
	closed = false;
	stats;
	/** Durability watermark, Redis-AOF style: writeGen counts the writev batches
	*  that landed in the OS page cache, syncedGen the watermark the last
	*  successful fsync is known to cover. The WAL is dirty while they differ.
	*  A generation (not a boolean) so a successful fsync never clears writes a
	*  concurrent flush landed while the fsync was in flight. */
	writeGen = 0;
	syncedGen = 0;
	/** Set while a background (everysec) sync is in flight, so a slow fsync
	*  never stacks a second background fsync on top of itself. */
	bgSyncing = false;
	/** Tracks every in-flight background sync so close() can drain them before
	*  the final flush/sync/fd-close (review #13): the timer only FIRES ticks,
	*  the tracker owns their lifetimes. */
	bgSync = new OpTracker();
	constructor(path, opts = {}) {
		const policy = opts.fsyncPolicy ?? "everysec";
		if (!POLICIES.has(policy)) throw new RangeError(`unknown fsyncPolicy: ${policy}`);
		this.path = path;
		this.policy = policy;
		this.syncIntervalMs = opts.syncIntervalMs ?? 1e3;
		this.stats = opts.stats ?? null;
	}
	async open() {
		if (this.fh) return;
		this.fh = await fs$1.open(this.path, "a");
		const st = await this.fh.stat();
		this.size = st.size;
		this.nextOffset = st.size;
		if (this.policy === "everysec") {
			this.timer = setInterval(() => {
				this.backgroundTick();
			}, this.syncIntervalMs);
			this.timer.unref?.();
		}
	}
	/** One everysec background-sync tick. Extracted from the timer callback so
	*  tests can drive it deterministically (the wal/stats suites open with a
	*  huge syncIntervalMs and call this directly instead of racing the wall
	*  clock). Returns the tracked sync's settle promise, or null when the tick
	*  was skipped: the WAL is clean (idle ticks must not fsync — the previous
	*  unconditional fsync cost one syscall + disk wake-up per second for the
	*  database's whole lifetime), a sync is already in flight, or close() shut
	*  the tracker's gate. Sync failures do not reject any write (the page-cache
	*  copy is the acknowledged one); they are recorded in stats.walFsyncErrors /
	*  lastWalFsyncError instead of being silently swallowed. */
	backgroundTick() {
		if (this.writeGen === this.syncedGen || this.bgSyncing) return null;
		if (!this.bgSync.enter()) return null;
		this.bgSyncing = true;
		return this.sync().catch(() => {}).finally(() => {
			this.bgSyncing = false;
			this.bgSync.leave();
		});
	}
	/** Reject new appends from now on; already-queued frames stay flushable.
	*  Idempotent. */
	seal() {
		this.sealed = true;
	}
	/** Append one frame and return its predicted absolute file offset plus the
	*  id of the flush batch that will carry it. The offset is known
	*  synchronously because frames are flushed strictly in append order.
	*  NOTE: the frame's bytes are NOT in the file yet — they sit in the in-memory
	*  queue until a later writev lands — so the offset must not be published as a
	*  disk value pointer before `done` resolves: a synchronous positioned read in
	*  that window would hit a short read past the current end of the file.
	*  batchId is -1 for frames that never entered a group (immediate
	*  rejections: closed/poisoned/sealed/invalid). */
	appendLoc(frame) {
		if (this.closed) {
			const err = /* @__PURE__ */ new Error("WAL is closed");
			err.code = "WAL_CLOSED";
			return {
				offset: -1,
				batchId: -1,
				done: Promise.reject(err)
			};
		}
		if (this.poisoned) return {
			offset: -1,
			batchId: -1,
			done: Promise.reject(this.poisonError())
		};
		if (this.sealed) {
			const err = /* @__PURE__ */ new Error("WAL is sealed by a compaction rotation; retry against the new WAL");
			err.code = "WAL_SEALED";
			return {
				offset: -1,
				batchId: -1,
				done: Promise.reject(err)
			};
		}
		if (!Buffer.isBuffer(frame)) return {
			offset: -1,
			batchId: -1,
			done: Promise.reject(/* @__PURE__ */ new TypeError("frame must be a Buffer"))
		};
		const offset = this.nextOffset;
		this.nextOffset += frame.length;
		return {
			offset,
			batchId: this.nextBatchId,
			done: new Promise((resolve, reject) => {
				this.queue.push({
					buf: frame,
					resolve,
					reject
				});
				this.queuedBytes += frame.length;
				if (this.stats) {
					this.stats.walQueuedBytes += frame.length;
					if (this.stats.walQueuedBytes > this.stats.walMaxQueuedBytes) this.stats.walMaxQueuedBytes = this.stats.walQueuedBytes;
				}
				if (!this.flushing && !this.scheduled) {
					this.scheduled = true;
					setImmediate(() => {
						this.flushBatch();
					});
				}
			})
		};
	}
	/** Append one frame. Resolves once written to the OS page cache; for
	* fsyncPolicy 'always' it additionally waits for fsync. */
	append(frame) {
		return this.appendLoc(frame).done;
	}
	async flushBatch() {
		this.scheduled = false;
		if (this.flushing) return this.inflight;
		if (this.queue.length === 0) return null;
		if (this.poisoned) return null;
		this.flushing = true;
		const run = async () => {
			const batch = this.queue;
			this.queue = [];
			const batchBytes = this.queuedBytes;
			this.queuedBytes = 0;
			this.nextBatchId++;
			if (this.stats) {
				this.stats.walQueuedBytes -= batchBytes;
				this.stats.walGroupCommits++;
				this.stats.walGroupCommitFrames += batch.length;
			}
			const batchStartOffset = this.nextOffset - batchBytes;
			let bufs = batch.map((b) => b.buf);
			let off = 0;
			let failure = null;
			try {
				while (bufs.length > 0) {
					const toWrite = off > 0 ? [bufs[0].subarray(off), ...bufs.slice(1)] : bufs;
					const { bytesWritten } = await this.fh.writev(toWrite);
					if (bytesWritten === 0) throw new Error("WAL writev made no progress (short write)");
					this.size += bytesWritten;
					if (this.stats) this.stats.walBytesWritten += bytesWritten;
					this.writeGen++;
					let rem = bytesWritten;
					while (rem > 0 && bufs.length > 0) {
						const left = bufs[0].length - off;
						if (rem < left) {
							off += rem;
							rem = 0;
						} else {
							rem -= left;
							bufs.shift();
							off = 0;
						}
					}
				}
			} catch (error) {
				failure = error;
				if (this.stats) this.stats.walWriteErrors++;
			}
			if (!failure && this.policy === "always") try {
				await this.sync();
			} catch (error) {
				failure = error;
			}
			if (failure) {
				this.poisonWith(batchStartOffset, failure);
				const perr = this.poisonError();
				this.rejectQueued(perr);
				for (const b of batch) b.reject(failure);
			} else for (const b of batch) b.resolve();
			this.flushing = false;
			this.inflight = null;
			if (this.queue.length > 0 && !this.closed && !this.poisoned) {
				this.scheduled = true;
				setImmediate(() => {
					this.flushBatch();
				});
			}
		};
		this.inflight = run();
		return this.inflight;
	}
	/** Non-null while the WAL is poisoned by a failed flush (or poisonPending):
	*  the failure and the owner's in-place recovery truncation point. */
	get poison() {
		return this.poisoned;
	}
	/** The logical next append offset, including queued-but-unflushed frames:
	*  every frame already accepted sits strictly below it, and any later frame
	*  starts at/above it. Stage 5's generation build seals its checkpoint at
	*  this watermark (every op applied so far has its frame below it, because
	*  a commit body appends before it applies, in the same tick). */
	get appendOffset() {
		return this.nextOffset;
	}
	/** Clear the poison after the owner truncated the file to failedAtOffset
	*  and re-synced size bookkeeping via refreshSize(): the write path resumes. */
	clearPoison() {
		this.poisoned = null;
	}
	/** Poison the WAL from outside the flush path — used when a post-append
	*  in-memory apply fails (MiniDb's applyOp contract violation): every queued
	*  frame is un-acked and must never reach disk, exactly as if the flush
	*  carrying it had failed. The truncation point is the start of the queued
	*  region; an in-flight batch keeps its own fate. */
	poisonPending(error) {
		if (this.closed) return;
		this.poisonWith(this.nextOffset - this.queuedBytes, error);
		this.rejectQueued(this.poisonError());
	}
	poisonWith(failedAtOffset, error) {
		if (this.poisoned) {
			this.poisoned.failedAtOffset = Math.min(this.poisoned.failedAtOffset, failedAtOffset);
			return;
		}
		this.poisoned = {
			failedAtOffset,
			error
		};
	}
	/** Reject every queued frame with `perr` in reverse enqueue order (see the
	*  flushBatch failure path for why newest-first matters). */
	rejectQueued(perr) {
		if (this.queue.length === 0) return;
		for (let i = this.queue.length - 1; i >= 0; i--) this.queue[i].reject(perr);
		if (this.stats) this.stats.walQueuedBytes -= this.queuedBytes;
		this.queue = [];
		this.queuedBytes = 0;
	}
	/** The rejection appends and flush() see while poisoned. 'WAL_POISONED' is
	*  deliberately distinct from 'WAL_SEALED': seal is a normal rotation
	*  (callers retry against the new WAL), poison is a hard failure the caller
	*  must treat as ambiguous. */
	poisonError() {
		const cause = this.poisoned?.error;
		const err = /* @__PURE__ */ new Error(`WAL is poisoned by a previous write failure: ${cause instanceof Error ? cause.message : String(cause)}`);
		err.code = "WAL_POISONED";
		err.cause = cause;
		return err;
	}
	/** Await the currently in-flight flush (if any) without scheduling new
	*  ones. Used by the owner's in-place recovery: a poisonPending truncation
	*  point is predicted against the in-flight batch fully landing, so the
	*  truncate must wait for that batch to settle — on success the point lies
	*  beyond its bytes, on failure poisonWith already widened the point to
	*  cover them. Never rejects (flushBatch settles its frames itself). */
	async whenIdle() {
		await this.inflight;
	}
	/** Re-sync size/nextOffset with the file on disk. Required after recovery
	*  truncates a torn WAL tail: the truncate happens on the path behind this
	*  WAL's back, and stale bookkeeping would otherwise make later appends
	*  publish value pointers offset by the torn byte count (reads then hit the
	*  wrong frames). */
	async refreshSize() {
		if (!this.fh) return;
		const st = await this.fh.stat();
		this.size = st.size;
		this.nextOffset = st.size;
	}
	/** Force an fsync of the underlying file. On success the durability
	*  watermark advances to the write generation sampled when the fsync was
	*  issued; a failure is recorded (walFsyncErrors + sticky lastWalFsyncError)
	*  and rethrown, and the WAL stays dirty. A no-op while poisoned: the tail
	*  is about to be truncated by the owner's recovery, so syncing it reports
	*  nothing actionable. */
	async sync() {
		if (!this.fh || this.poisoned) return;
		const gen = this.writeGen;
		try {
			await this.fh.sync();
		} catch (error) {
			if (this.stats) {
				this.stats.walFsyncErrors++;
				this.stats.lastWalFsyncError = error;
			}
			throw error;
		}
		if (this.stats) this.stats.walFsyncs++;
		if (this.syncedGen < gen) this.syncedGen = gen;
	}
	/** Flush buffered frames to the OS (without necessarily fsync'ing).
	*  Loops until everything queued up to now has been flushed: an earlier
	*  version only awaited the in-flight batch and could return while newer
	*  frames were still queued, which let compaction truncate un-flushed data.
	*  Throws the poison error when the WAL is (or becomes) poisoned: a caller
	*  that needs a durable fence (compaction, backup) must fail there instead
	*  of building on a tail the owner's recovery is about to truncate. */
	async flush() {
		for (;;) {
			if (this.poisoned) throw this.poisonError();
			if (this.queue.length === 0 && !this.inflight) return;
			if (this.inflight) await this.inflight;
			if (this.queue.length > 0) await this.flushBatch();
		}
	}
	async close() {
		if (this.closed) return;
		this.closed = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		await this.bgSync.close();
		try {
			if (!this.poisoned) {
				try {
					await this.flush();
				} catch (error) {
					if (!this.poisoned) throw error;
				}
				if (this.fh) await this.sync();
			}
		} finally {
			const fh = this.fh;
			this.fh = null;
			if (fh) await fh.close().catch(() => {});
		}
	}
};
// ../../packages/minidb/src/compaction.ts
function shouldCompact(db) {
	return Boolean(db.wal && db.wal.size >= db.compactThresholdBytes);
}
const COPY_CHUNK = 1 << 20;
const SMALL_DELTA = 65536;
const rotateReplace = (src, dst) => renameReplace(src, dst);
const MAX_PRECOPY_PASSES = 5;
const CONVERGE_RATIO = .7;
function isUnsupportedDirectoryFsyncError(code, platform = process.platform) {
	return code === "EINVAL" || code === "ENOTSUP" || platform === "win32" && code === "EPERM";
}
async function fsyncDir(dir, opts = {}) {
	let fh = null;
	try {
		fh = await fs$1.open(dir, "r");
		await fh.sync();
	} catch (error) {
		const code = error.code;
		if (isUnsupportedDirectoryFsyncError(code)) {
			if (opts.stats) opts.stats.dirFsyncUnsupported = true;
			return;
		}
		if (opts.strict) throw error;
	} finally {
		if (fh) await fh.close().catch(() => {});
	}
}
/** Stream src[start:end] into dst, fsync'ing dst before returning. With
*  `append: true` the bytes are appended to an existing dst; otherwise dst is
*  created/truncated. Uses its own file handles, independent of the WAL's
*  append handle, so it is safe to read the live WAL while writers append. A
*  zero-length range still creates/truncates dst (so the new WAL file exists
*  even when there is no post-fence tail). */
async function copyFileRange(srcPath, dstPath, start, end, opts = {}) {
	if (end < start) throw new RangeError(`copyFileRange: end (${end}) < start (${start})`);
	const dst = await fs$1.open(dstPath, opts.append ? "a" : "w");
	try {
		if (end > start) {
			const src = await fs$1.open(srcPath, "r");
			try {
				const buf = Buffer.allocUnsafe(COPY_CHUNK);
				let pos = start;
				while (pos < end) {
					const len = Math.min(buf.length, end - pos);
					const { bytesRead } = await src.read(buf, 0, len, pos);
					if (bytesRead === 0) break;
					let written = 0;
					while (written < bytesRead) {
						const { bytesWritten } = await dst.write(buf, written, bytesRead - written);
						if (bytesWritten === 0) throw new Error("copyFileRange: write made no progress (short write)");
						written += bytesWritten;
					}
					pos += bytesRead;
				}
			} finally {
				await src.close().catch(() => {});
			}
		}
		await dst.sync();
	} finally {
		await dst.close().catch(() => {});
	}
}
async function compact(db) {
	if (db.compacting) return db._compactDone ?? void 0;
	db.compacting = true;
	db._compactDone = (async () => {
		const t0 = performance.now();
		try {
			await runCompaction(db);
			await db.onCompacted?.();
			db.stats.compactions++;
			db.stats.compactionDurationMs = (db.stats.compactionDurationMs ?? 0) + (performance.now() - t0);
			db.lastCompactError = null;
		} catch (error) {
			db.stats.compactErrors = (db.stats.compactErrors ?? 0) + 1;
			db.lastCompactError = error;
			throw error;
		} finally {
			db.compacting = false;
			db._rotateLock = null;
		}
	})();
	return db._compactDone;
}
async function runCompaction(db) {
	const tmp = path.join(db.dir, "db.snapshot.tmp");
	const snap = path.join(db.dir, "db.snapshot");
	const walTmp = path.join(db.dir, "db.wal.tmp");
	await db.wal.flush();
	const baseOffset = db.wal.size;
	const snapT0 = performance.now();
	const snapRes = await writeSnapshot(db.store, tmp, { readValueAsync: db.valueReader?.readAsync ? (loc) => db.valueReader.readAsync(loc) : void 0 });
	db.stats.snapshotBytesWritten += snapRes.bytes;
	db.stats.compactionSnapshotDurationMs = (db.stats.compactionSnapshotDurationMs ?? 0) + (performance.now() - snapT0);
	let copiedUpTo = baseOffset;
	let appended = false;
	let prevGap = Number.POSITIVE_INFINITY;
	for (let pass = 0; pass < MAX_PRECOPY_PASSES; pass++) {
		await db.wal.flush();
		const head = db.wal.size;
		const gap = head - copiedUpTo;
		if (gap <= SMALL_DELTA) break;
		if (pass > 0 && gap > prevGap * CONVERGE_RATIO) break;
		await copyFileRange(db.walPath, walTmp, copiedUpTo, head, { append: appended });
		appended = true;
		copiedUpTo = head;
		prevGap = gap;
	}
	let releaseRotation;
	db._rotateLock = new Promise((resolve) => {
		releaseRotation = resolve;
	});
	const rotateT0 = performance.now();
	db.onMaintenancePhase?.("publishing");
	let rotated = false;
	let remapped = false;
	const remap = () => {
		if (remapped) return;
		const snapLocs = snapRes.locs;
		db.store.remapLocs((k, loc) => {
			if (loc.file === "wal" && loc.off >= baseOffset) return {
				file: "wal",
				off: loc.off - baseOffset,
				len: loc.len
			};
			return snapLocs.get(k);
		});
		remapped = true;
	};
	try {
		db.wal.seal();
		for (;;) {
			await db.wal.flush();
			const endOffset = db.wal.size;
			if (endOffset === copiedUpTo && appended) break;
			await copyFileRange(db.walPath, walTmp, copiedUpTo, endOffset, { append: appended });
			appended = true;
			copiedUpTo = endOffset;
		}
		await db.wal.close();
		if (process.platform === "win32") db.valueReader?.close?.();
		await rotateReplace(tmp, snap);
		await fsyncDir(db.dir, {
			strict: true,
			stats: db.stats
		});
		await rotateReplace(walTmp, db.walPath);
		rotated = true;
		await fsyncDir(db.dir, {
			strict: true,
			stats: db.stats
		});
		const fresh = new WAL(db.walPath, {
			fsyncPolicy: db.fsyncPolicy,
			syncIntervalMs: db.syncIntervalMs,
			stats: db.stats
		});
		db.wal = fresh;
		await fresh.open();
		remap();
		db.valueReader?.reopenBoth();
	} catch (error) {
		try {
			await db.wal.close().catch(() => {});
			const fresh = new WAL(db.walPath, {
				fsyncPolicy: db.fsyncPolicy,
				syncIntervalMs: db.syncIntervalMs,
				stats: db.stats
			});
			await fresh.open();
			db.wal = fresh;
			if (rotated) {
				remap();
				db.valueReader?.reopenBoth();
			}
		} catch {}
		throw error;
	} finally {
		releaseRotation();
		db._rotateLock = null;
		db.onMaintenancePhase?.("running");
		db.stats.compactionRotationDurationMs = (db.stats.compactionRotationDurationMs ?? 0) + (performance.now() - rotateT0);
	}
}
// ../../packages/minidb/src/generation.ts
/** The primary data pair recovery pairs up: the snapshot, then the WAL. */
const SNAPSHOT_FILE = "db.snapshot";
const WAL_FILE = "db.wal";
/** Index-definition sidecars, rewritten atomically (tmp + rename) on every
*  definition change. */
const SECONDARY_INDEXES_FILE = "db.indexes.json";
const COMPOUND_INDEXES_FILE = "db.compound-indexes.json";
const TEXT_INDEXES_FILE = "db.textindexes.json";
const SIDECAR_FILES = [
	SECONDARY_INDEXES_FILE,
	COMPOUND_INDEXES_FILE,
	TEXT_INDEXES_FILE
];
/** Per-text-index postings files at the ROOT are the legacy (pre-generation)
*  location: read-only in-memory-base instances and the generations-disabled
*  fallback still use them, and a writer deletes a root postings file once a
*  published generation covers that index. */
const POSTINGS_PATTERN = /^db\.text-.*\.postings$/;
/** On-disk postings file name for a text index (root location). */
function rootPostingsFile(name) {
	return `db.text-${sanitizeIndexName(name)}.postings`;
}
const GENERATIONS_DIR = "generations";
const CURRENT_FILE = "CURRENT";
const MANIFEST_FILE = "manifest.json";
const STORE_IMAGE_FILE = "store";
const DT_INDEX_FILE = "dt.index";
const SECONDARY_INDEX_FILE = "secondary.index";
const COMPOUND_INDEX_FILE = "compound.index";
const GEN_SNAPSHOT_FILE = "snapshot";
/** Text-index artifact file names inside a generation directory. */
function textDictionaryFile(name) {
	return `text-${sanitizeIndexName(name)}.dictionary`;
}
function textPostingsFile(name) {
	return `text-${sanitizeIndexName(name)}.postings`;
}
function textDocsFile(name) {
	return `text-${sanitizeIndexName(name)}.docs`;
}
/** Index names land in file names; keep the same sanitization the legacy
*  root postings path used so both locations agree. */
function sanitizeIndexName(name) {
	return name.replaceAll(/[^a-zA-Z0-9_.-]/g, "_");
}
/** Generation directory id: monotonically increasing, zero-padded so
*  lexicographic order equals numeric order. */
function generationId(n) {
	return `g-${String(n).padStart(6, "0")}`;
}
const GEN_ID_PATTERN = /^g-(\d+)$/;
/** Parse a generation directory name into its numeric id, or null. */
function parseGenerationId(name) {
	const m = GEN_ID_PATTERN.exec(name);
	return m ? Number(m[1]) : null;
}
/** In-flight generation build directories (crash-stranded ones are swept by
*  the next writer open; a live build's tmp is never matched for another
*  process because only the lock holder builds). */
const GEN_TMP_PATTERN = /^g-\d+\.tmp-.*$/;
/** Canonical definition hash: crc32 of the JSON of the definition with
*  sorted keys, hex-encoded. Both sides (build and load) derive it from the
*  SAME persisted definition shape (the sidecar entries), so a sidecar
*  round-trip never changes it. */
function indexDefHash(def) {
	return crc32(Buffer.from(stableJson(def), "utf8")).toString(16).padStart(8, "0");
}
function stableJson(v) {
	if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
	if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
	return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
}
[...SIDECAR_FILES];
/** Is `name` one of MiniDb's persistent top-level entries (a primary data
*  file, an index-definition sidecar, a legacy postings file, CURRENT, or the
*  generations directory)? backup/restore filter on this. */
function isPersistentFile(name) {
	return name === "db.snapshot" || name === "db.wal" || name === "CURRENT" || name === "generations" || SIDECAR_FILES.includes(name) || POSTINGS_PATTERN.test(name);
}
/** Atomic-write temp siblings a crashed previous run may have left behind:
*  a compaction's snapshot/WAL temps (fixed names), plus sidecar-definition
*  temps from before sidecar writes gained unique suffixes. Current sidecar
*  writes use `<file>.tmp-<pid>-<seq>` names, matched by isStaleTmpFile
*  instead. Only the sole writer may delete them at open — a read-only
*  opener must never touch a live writer's in-flight temps. */
const STALE_TMP_FILES = [
	SNAPSHOT_FILE,
	WAL_FILE,
	...SIDECAR_FILES
].map((f) => `${f}.tmp`);
/** Is `name` a unique-suffixed atomic-write temp (`<file>.tmp-<pid>-<seq>`)
*  of one of the primary/sidecar/CURRENT files, orphaned by a crash between
*  the tmp write and the rename? Whitelisted per known file so a LockFile's
*  `db.lock.tmp-*` — possibly in flight in ANOTHER process right now — is
*  never matched. Same deletion discipline as STALE_TMP_FILES: only the sole
*  writer at open. */
function isStaleTmpFile(name) {
	return [
		SNAPSHOT_FILE,
		WAL_FILE,
		CURRENT_FILE,
		...SIDECAR_FILES
	].some((f) => name.startsWith(`${f}.tmp-`));
}
/** A failed postings rebuild orphans `db.text-*.postings.tmp` (its atomic
*  rename never ran). Postings are pure derived state, so such temps are
*  always safe for the writer to delete, for any index name. */
const STALE_POSTINGS_TMP_PATTERN = /^db\.text-.*\.postings\.tmp$/;
// ../../packages/minidb/src/backup.ts
/** Unique suffixes for backup's temp/aside dirs (see copyBackupAtomic). */
let backupTmpSeq = 0;
/** The rejection a write op gets while a backup holds the write gate: the
*  fence is short (file copies) and retryable, so callers can simply
*  re-issue the write afterwards. */
function backupInProgressError() {
	return Object.assign(/* @__PURE__ */ new Error("MiniDb backup is in progress: writes are fenced until it completes"), { code: "BACKUP_IN_PROGRESS" });
}
/** Write a consistent online backup of this database directory.
*
*  Semantics (plan 12): backup pauses the write gate — new writes reject
*  with BACKUP_IN_PROGRESS — and waits for every in-flight write to settle.
*  That drain completion IS the linearization point: every write
*  acknowledged before it is included in the backup, every write submitted
*  after it is not. The copy itself is an atomic commit: persistent files
*  go to a sibling temp dir, every copied file is fsync'd, the manifest is
*  written LAST (the commit marker — a manifest on disk implies every file
*  it lists is fully copied and durable), then the temp dir is renamed over
*  the destination (an existing previous backup is swapped aside first and
*  restored if the rename fails). A failure anywhere before the rename
*  leaves the destination untouched and the temp dir removed — never a half
*  backup. Concurrent backups serialize on serializeBackups. */
async function backup(deps, destDir, opts = {}) {
	deps.ensureOpen();
	if (!destDir) throw new TypeError("backup: destDir is required");
	if (deps.compacting()) await deps.compactDone();
	if (opts.compact !== false && !deps.readOnly()) await deps.compact();
	if (deps.compacting()) await deps.compactDone();
	const drain = deps.pauseWrites();
	try {
		await deps.serializeBackups(async () => {
			await drain;
			if (deps.compacting()) await deps.compactDone();
			await deps.walRecoveryChain();
			await deps.flushWal();
			await copyBackupAtomic(deps, destDir);
		});
	} finally {
		deps.resumeWrites();
	}
}
/** The atomic-copy core of backup(): temp dir → per-file fsync → manifest
*  (commit marker) → dir fsync → rename swap → parent fsync. Runs with the
*  write gate paused. */
async function copyBackupAtomic(deps, destDir) {
	const parent = path.dirname(destDir);
	const base = path.basename(destDir);
	const tmp = path.join(parent, `.${base}.backup-tmp-${process.pid}-${++backupTmpSeq}`);
	const aside = path.join(parent, `.${base}.backup-old-${process.pid}-${++backupTmpSeq}`);
	await fs$1.mkdir(parent, { recursive: true });
	for (const name of await fs$1.readdir(parent)) if (name.startsWith(`.${base}.backup-tmp-`) || name.startsWith(`.${base}.backup-old-`)) await fs$1.rm(path.join(parent, name), {
		recursive: true,
		force: true
	});
	await fs$1.mkdir(tmp);
	try {
		const files = await persistentFiles(deps.dir());
		const copied = [];
		const copiedFiles = [];
		for (const name of files) {
			const kind = await copyIfExists(deps.dir(), name, tmp);
			if (kind === void 0) continue;
			copied.push(name);
			if (kind === "file") copiedFiles.push(name);
		}
		for (const name of copiedFiles) await fsyncCopiedFile(path.join(tmp, name));
		const manifest = path.join(tmp, "backup.manifest.json");
		await fs$1.writeFile(manifest, JSON.stringify({
			version: 1,
			createdAt: Date.now(),
			files: copied
		}, null, 2), "utf8");
		await fsyncCopiedFile(manifest);
		await fsyncDir(tmp, {
			strict: true,
			stats: deps.stats
		});
		let asideUsed = false;
		try {
			try {
				await fs$1.rename(destDir, aside);
				asideUsed = true;
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			await fs$1.rename(tmp, destDir);
		} catch (error) {
			if (asideUsed) await fs$1.rename(aside, destDir).catch(() => {});
			throw error;
		}
		await fs$1.rm(aside, {
			recursive: true,
			force: true
		});
		await fsyncDir(parent, {
			strict: true,
			stats: deps.stats
		});
	} finally {
		await fs$1.rm(tmp, {
			recursive: true,
			force: true
		}).catch(() => {});
	}
}
async function persistentFiles(dir) {
	return (await fs$1.readdir(dir)).filter(isPersistentFile);
}
/** Fsync one copied backup file. The handle is opened WRITABLE on purpose:
*  Windows refuses fsync on a read-only handle (`EPERM: operation not
*  permitted, fsync`), and the manifest's durability promise below ("a durable
*  manifest must imply durable payloads") needs the payload fsync to actually
*  happen on every platform rather than be degraded away. */
async function fsyncCopiedFile(file) {
	const h = await fs$1.open(file, "r+");
	try {
		await h.sync();
	} finally {
		await h.close();
	}
}
async function copyIfExists(dir, name, destDir) {
	try {
		const src = path.join(dir, name);
		if ((await fs$1.stat(src)).isDirectory()) {
			await fs$1.cp(src, path.join(destDir, name), { recursive: true });
			return "directory";
		}
		await fs$1.copyFile(src, path.join(destDir, name));
		return "file";
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		throw error;
	}
}
// ../../packages/minidb/src/skiplist.ts
const MAX_LEVEL = 32;
const P = .25;
const cmpNumber = (a, b) => a - b;
const cmpString = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function randomLevel() {
	let lvl = 1;
	while (Math.random() < P && lvl < MAX_LEVEL) lvl++;
	return lvl;
}
var SkipNode = class {
	key;
	val;
	backward = null;
	level;
	constructor(key, val, level) {
		this.key = key;
		this.val = val;
		this.level = Array.from({ length: level }, () => ({
			forward: null,
			span: 0
		}));
	}
};
var SkipList = class SkipList {
	cmpK;
	cmpV;
	header;
	tail = null;
	length = 0;
	level = 1;
	constructor(opts = {}) {
		this.cmpK = opts.compareKey ?? cmpNumber;
		this.cmpV = opts.compareVal ?? cmpString;
		this.header = new SkipNode(void 0, void 0, MAX_LEVEL);
	}
	/** Deterministic O(N) construction from entries already sorted by (key, val)
	*  ascending — the load path for a persisted index image (stage 5), where
	*  inserting one node at a time would cost O(N log N) with random levels.
	*  Levels are assigned as a balanced 4-ary tower (node at 0-based index i
	*  rises past level l when (i+1) % 4^l === 0) and every span is computed
	*  directly, so the result satisfies the exact same forward/span/backward
	*  invariants insert()/delete() maintain; later mutations re-randomize
	*  locally through the normal paths. Duplicate (key, val) pairs are skipped
	*  (insert() would never create them either). */
	static bulkLoad(entries, opts = {}) {
		const list = new SkipList(opts);
		const n = entries.length;
		if (n === 0) return list;
		const nodes = [];
		for (let i = 0; i < n; i++) {
			const e = entries[i];
			if (nodes.length > 0) {
				const prev = nodes[nodes.length - 1];
				if (list.cmpK(prev.key, e.key) === 0 && list.cmpV(prev.val, e.val) === 0) continue;
			}
			let lvl = 1;
			for (let m = i + 1; m % 4 === 0 && lvl < MAX_LEVEL; m = m / 4) lvl++;
			nodes.push(new SkipNode(e.key, e.val, lvl));
		}
		const count = nodes.length;
		list.level = 1;
		for (const node of nodes) if (node.level.length > list.level) list.level = node.level.length;
		const lastAt = [];
		for (let l = 0; l < list.level; l++) lastAt.push({
			node: list.header,
			index: -1
		});
		for (let i = 0; i < count; i++) {
			const node = nodes[i];
			for (let l = 0; l < node.level.length; l++) {
				const pred = lastAt[l];
				pred.node.level[l].forward = node;
				pred.node.level[l].span = i - pred.index;
				lastAt[l] = {
					node,
					index: i
				};
			}
			node.backward = i === 0 ? null : nodes[i - 1];
		}
		for (let l = 0; l < list.level; l++) {
			const pred = lastAt[l];
			pred.node.level[l].span = pred.index === -1 ? count : 0;
		}
		list.tail = nodes[count - 1];
		list.length = count;
		return list;
	}
	/** Sliced variant of bulkLoad (the open-time main-thread load paths):
	*  builds the exact same balanced tower, but yields to the event loop every
	*  `sliceEvery` source entries in the two O(N) passes (node creation,
	*  level linking), so a large image load never runs as one synchronous
	*  slice. */
	static async bulkLoadAsync(entries, opts = {}, slice = {}) {
		const sliceEvery = slice.sliceEvery ?? 65536;
		const yieldToLoop = () => new Promise((r) => setImmediate(r));
		const list = new SkipList(opts);
		const n = entries.length;
		if (n === 0) return list;
		const nodes = [];
		for (let i = 0; i < n; i++) {
			if (i > 0 && i % sliceEvery === 0) await yieldToLoop();
			const e = entries[i];
			if (nodes.length > 0) {
				const prev = nodes[nodes.length - 1];
				if (list.cmpK(prev.key, e.key) === 0 && list.cmpV(prev.val, e.val) === 0) continue;
			}
			let lvl = 1;
			for (let m = i + 1; m % 4 === 0 && lvl < MAX_LEVEL; m = m / 4) lvl++;
			nodes.push(new SkipNode(e.key, e.val, lvl));
		}
		const count = nodes.length;
		list.level = 1;
		for (const node of nodes) if (node.level.length > list.level) list.level = node.level.length;
		const lastAt = [];
		for (let l = 0; l < list.level; l++) lastAt.push({
			node: list.header,
			index: -1
		});
		for (let i = 0; i < count; i++) {
			if (i > 0 && i % sliceEvery === 0) await yieldToLoop();
			const node = nodes[i];
			for (let l = 0; l < node.level.length; l++) {
				const pred = lastAt[l];
				pred.node.level[l].forward = node;
				pred.node.level[l].span = i - pred.index;
				lastAt[l] = {
					node,
					index: i
				};
			}
			node.backward = i === 0 ? null : nodes[i - 1];
		}
		for (let l = 0; l < list.level; l++) {
			const pred = lastAt[l];
			pred.node.level[l].span = pred.index === -1 ? count : 0;
		}
		list.tail = nodes[count - 1];
		list.length = count;
		return list;
	}
	nodeLess(a, b) {
		const c = this.cmpK(a.key, b.key);
		return c < 0 || c === 0 && this.cmpV(a.val, b.val) < 0;
	}
	insert(key, val) {
		const update = Array.from({ length: MAX_LEVEL });
		const rank = Array.from({ length: MAX_LEVEL }, () => 0);
		let x = this.header;
		const target = {
			key,
			val
		};
		for (let i = this.level - 1; i >= 0; i--) {
			rank[i] = i === this.level - 1 ? 0 : rank[i + 1];
			let f = x.level[i].forward;
			while (f && this.nodeLess(f, target)) {
				rank[i] += x.level[i].span;
				x = f;
				f = x.level[i].forward;
			}
			update[i] = x;
		}
		let lvl = randomLevel();
		if (lvl > this.level) {
			for (let i = this.level; i < lvl; i++) {
				rank[i] = 0;
				update[i] = this.header;
				update[i].level[i].span = this.length;
			}
			this.level = lvl;
		}
		x = new SkipNode(key, val, lvl);
		for (let i = 0; i < lvl; i++) {
			x.level[i].forward = update[i].level[i].forward;
			update[i].level[i].forward = x;
			x.level[i].span = update[i].level[i].span - (rank[0] - rank[i]);
			update[i].level[i].span = rank[0] - rank[i] + 1;
		}
		for (let i = lvl; i < this.level; i++) update[i].level[i].span++;
		x.backward = update[0] === this.header ? null : update[0];
		if (x.level[0].forward) x.level[0].forward.backward = x;
		else this.tail = x;
		this.length++;
		return x;
	}
	deleteNode(x, update) {
		for (let i = 0; i < this.level; i++) if (update[i].level[i].forward === x) {
			update[i].level[i].span += x.level[i].span - 1;
			update[i].level[i].forward = x.level[i].forward;
		} else update[i].level[i].span--;
		if (x.level[0].forward) x.level[0].forward.backward = x.backward;
		else this.tail = x.backward;
		while (this.level > 1 && this.header.level[this.level - 1].forward === null) this.level--;
		this.length--;
	}
	delete(key, val) {
		const update = Array.from({ length: MAX_LEVEL });
		let x = this.header;
		const target = {
			key,
			val
		};
		for (let i = this.level - 1; i >= 0; i--) {
			let f = x.level[i].forward;
			while (f && this.nodeLess(f, target)) {
				x = f;
				f = x.level[i].forward;
			}
			update[i] = x;
		}
		const last = x.level[0].forward;
		if (last && this.cmpK(last.key, key) === 0 && this.cmpV(last.val, val) === 0) {
			this.deleteNode(last, update);
			return true;
		}
		return false;
	}
	/** First node with key >= bound (or > bound if strict). */
	lowerBound(bound, { strict = false } = {}) {
		let x = this.header;
		for (let i = this.level - 1; i >= 0; i--) {
			let f;
			while ((f = x.level[i].forward) && (strict ? this.cmpK(f.key, bound) <= 0 : this.cmpK(f.key, bound) < 0)) x = f;
		}
		return x.level[0].forward;
	}
	/** 0-based rank of (key, val), or null if absent. */
	getRank(key, val) {
		let x = this.header;
		let rank = 0;
		const target = {
			key,
			val
		};
		for (let i = this.level - 1; i >= 0; i--) {
			let f = x.level[i].forward;
			while (f && (this.nodeLess(f, target) || this.cmpK(f.key, key) === 0 && this.cmpV(f.val, val) === 0)) {
				rank += x.level[i].span;
				x = f;
				f = x.level[i].forward;
			}
		}
		if (x !== this.header && this.cmpK(x.key, key) === 0 && this.cmpV(x.val, val) === 0) return rank - 1;
		return null;
	}
	/** Node at 0-based rank, or null. */
	getByRank(rank) {
		if (rank < 0 || rank >= this.length) return null;
		const target = rank + 1;
		let x = this.header;
		let traversed = 0;
		for (let i = this.level - 1; i >= 0; i--) {
			let f = x.level[i].forward;
			while (f && traversed + x.level[i].span <= target) {
				traversed += x.level[i].span;
				x = f;
				f = x.level[i].forward;
			}
			if (traversed === target) return {
				key: x.key,
				val: x.val
			};
		}
		return null;
	}
	/** Range scan. */
	range(opts = {}) {
		let offset = opts.offset ?? 0;
		let count = opts.count ?? Infinity;
		const out = [];
		if (opts.reverse) {
			let x;
			if (opts.lte !== void 0) {
				const after = this.lowerBound(opts.lte, { strict: true });
				x = after ? after.backward : this.tail;
			} else if (opts.lt !== void 0) {
				const after = this.lowerBound(opts.lt, { strict: false });
				x = after ? after.backward : this.tail;
			} else x = this.tail;
			while (x) {
				if (opts.gte !== void 0 && this.cmpK(x.key, opts.gte) < 0) break;
				if (opts.gt !== void 0 && this.cmpK(x.key, opts.gt) <= 0) break;
				if (offset > 0) offset--;
				else if (count > 0) {
					out.push({
						key: x.key,
						val: x.val
					});
					count--;
				} else break;
				x = x.backward;
			}
			return out;
		}
		let x = opts.gte !== void 0 || opts.gt !== void 0 ? this.lowerBound(opts.gte !== void 0 ? opts.gte : opts.gt, { strict: opts.gt !== void 0 }) : this.header.level[0].forward;
		while (x) {
			if (opts.lte !== void 0 && this.cmpK(x.key, opts.lte) > 0) break;
			if (opts.lt !== void 0 && this.cmpK(x.key, opts.lt) >= 0) break;
			if (offset > 0) offset--;
			else if (count > 0) {
				out.push({
					key: x.key,
					val: x.val
				});
				count--;
			} else break;
			x = x.level[0].forward;
		}
		return out;
	}
	/** Lazy range scan. Same bounds/offset/count/reverse semantics as range(),
	*  but yields entries one by one so a caller can stop early without
	*  materializing the whole range. */
	*iterate(opts = {}) {
		let offset = opts.offset ?? 0;
		let count = opts.count ?? Infinity;
		if (opts.reverse) {
			let x;
			if (opts.lte !== void 0) {
				const after = this.lowerBound(opts.lte, { strict: true });
				x = after ? after.backward : this.tail;
			} else if (opts.lt !== void 0) {
				const after = this.lowerBound(opts.lt, { strict: false });
				x = after ? after.backward : this.tail;
			} else x = this.tail;
			while (x) {
				if (opts.gte !== void 0 && this.cmpK(x.key, opts.gte) < 0) break;
				if (opts.gt !== void 0 && this.cmpK(x.key, opts.gt) <= 0) break;
				if (offset > 0) offset--;
				else if (count > 0) {
					yield {
						key: x.key,
						val: x.val
					};
					count--;
				} else break;
				x = x.backward;
			}
			return;
		}
		let x = opts.gte !== void 0 || opts.gt !== void 0 ? this.lowerBound(opts.gte !== void 0 ? opts.gte : opts.gt, { strict: opts.gt !== void 0 }) : this.header.level[0].forward;
		while (x) {
			if (opts.lte !== void 0 && this.cmpK(x.key, opts.lte) > 0) break;
			if (opts.lt !== void 0 && this.cmpK(x.key, opts.lt) >= 0) break;
			if (offset > 0) offset--;
			else if (count > 0) {
				yield {
					key: x.key,
					val: x.val
				};
				count--;
			} else break;
			x = x.level[0].forward;
		}
	}
	toArray() {
		const out = [];
		let x = this.header.level[0].forward;
		while (x) {
			out.push({
				key: x.key,
				val: x.val
			});
			x = x.level[0].forward;
		}
		return out;
	}
};
// ../../packages/minidb/src/compound-index.ts
function getPath$1(doc, path) {
	return path.split(".").reduce((o, k) => o === null || o === void 0 ? void 0 : o[k], doc);
}
var CompoundIndexManager = class CompoundIndexManager {
	indexes = /* @__PURE__ */ new Map();
	/** In-flight createCompoundIndex transactions (plan 10's staged → persist →
	*  publish), same discipline as IndexManager.staged: invisible to every
	*  query path until the sidecar persist succeeds and publish() moves the
	*  entry into the live map. */
	staged = /* @__PURE__ */ new Map();
	static entry(def) {
		const orderType = def.orderType ?? "number";
		return {
			def: {
				groupBy: def.groupBy,
				orderBy: def.orderBy,
				orderType
			},
			cmp: orderType === "string" ? cmpString : cmpNumber,
			groups: /* @__PURE__ */ new Map(),
			byPk: /* @__PURE__ */ new Map()
		};
	}
	create(name, def) {
		if (this.indexes.has(name)) throw new Error(`compound index "${name}" already exists`);
		this.indexes.set(name, CompoundIndexManager.entry(def));
	}
	/** Stage a new compound index definition off to the side (see `staged`). */
	stage(name, def) {
		if (this.indexes.has(name) || this.staged.has(name)) throw new Error(`compound index "${name}" already exists`);
		this.staged.set(name, CompoundIndexManager.entry(def));
	}
	/** Rebuild ONE staged index from entries of { key, value, dt }. Touches
	*  nothing live, so a failure midway leaves every published index intact. */
	rebuildStaged(name, entries) {
		const entry = this.staged.get(name);
		if (!entry) throw new Error(`no staged compound index: ${name}`);
		for (const { key, value, dt } of entries) this.addToEntry(entry, typeof key === "string" ? key : Buffer.from(key).toString("binary"), value, dt ?? null);
	}
	/** The staged definition in its persisted (CompoundIndexInfo) shape. */
	stagedInfo(name) {
		const e = this.staged.get(name);
		if (!e) throw new Error(`no staged compound index: ${name}`);
		return {
			name,
			groupBy: e.def.groupBy,
			orderBy: e.def.orderBy,
			orderType: e.def.orderType
		};
	}
	/** Move a staged index into the live registry (its sidecar persist already
	*  succeeded). */
	publish(name) {
		const entry = this.staged.get(name);
		if (!entry) throw new Error(`no staged compound index: ${name}`);
		this.staged.delete(name);
		this.indexes.set(name, entry);
	}
	/** Drop a staged index without publishing it (the create failed). */
	discardStaged(name) {
		this.staged.delete(name);
	}
	drop(name) {
		return this.indexes.delete(name);
	}
	/** Live + staged count (a staged entry must be fed by the write paths
	*  exactly like a live one; see `staged`). */
	get size() {
		return this.indexes.size + this.staged.size;
	}
	list() {
		return [...this.indexes.entries()].map(([name, e]) => ({
			name,
			groupBy: e.def.groupBy,
			orderBy: e.def.orderBy,
			orderType: e.def.orderType
		}));
	}
	groupOf(entry, group) {
		let list = entry.groups.get(group);
		if (!list) {
			list = new SkipList({
				compareKey: entry.cmp,
				compareVal: cmpString
			});
			entry.groups.set(group, list);
		}
		return list;
	}
	extract(entry, doc, dt) {
		return {
			group: getPath$1(doc, entry.def.groupBy),
			order: dt && entry.def.orderBy in dt ? dt[entry.def.orderBy] : getPath$1(doc, entry.def.orderBy)
		};
	}
	validOrder(entry, order) {
		if (entry.def.orderType === "number") return typeof order === "number" && Number.isFinite(order);
		return typeof order === "string";
	}
	/** Add/update a document in one compound index entry. */
	addToEntry(entry, pk, doc, dt) {
		const { group, order } = this.extract(entry, doc, dt);
		const prev = entry.byPk.get(pk);
		const valid = group !== void 0 && group !== null && this.validOrder(entry, order);
		if (prev && valid && prev.group === group && prev.order === order) return;
		if (prev) {
			const oldList = entry.groups.get(prev.group);
			if (oldList) {
				oldList.delete(prev.order, pk);
				if (oldList.length === 0) entry.groups.delete(prev.group);
			}
		}
		if (valid) {
			this.groupOf(entry, group).insert(order, pk);
			entry.byPk.set(pk, {
				group,
				order
			});
		} else entry.byPk.delete(pk);
	}
	/** Add/update a document across all compound indexes — live AND staged (a
	*  staged entry is kept exactly as current as the live ones, so publish()
	*  is a bare map move; see `staged`). */
	add(pk, doc, dt) {
		for (const entry of this.indexes.values()) this.addToEntry(entry, pk, doc, dt);
		for (const entry of this.staged.values()) this.addToEntry(entry, pk, doc, dt);
	}
	remove(pk, _doc, _dt) {
		for (const entry of this.indexes.values()) CompoundIndexManager.removeFromEntry(entry, pk);
		for (const entry of this.staged.values()) CompoundIndexManager.removeFromEntry(entry, pk);
	}
	static removeFromEntry(entry, pk) {
		const prev = entry.byPk.get(pk);
		if (prev) {
			const oldList = entry.groups.get(prev.group);
			if (oldList) {
				oldList.delete(prev.order, pk);
				if (oldList.length === 0) entry.groups.delete(prev.group);
			}
			entry.byPk.delete(pk);
		}
	}
	/** Range over a group, ordered by the order key. */
	range(name, groupValue, opts = {}) {
		const entry = this.indexes.get(name);
		if (!entry) throw new Error(`no such compound index: ${name}`);
		const list = entry.groups.get(groupValue);
		if (!list) return [];
		return list.range({
			...opts,
			count: opts.limit ?? opts.count
		}).map((n) => ({
			key: n.val,
			orderValue: n.key
		}));
	}
	/** Rebuild from entries of { key, value, dt }. */
	rebuild(entries) {
		const b = this.beginRebuild();
		for (const { key, value, dt } of entries) b.add(typeof key === "string" ? key : Buffer.from(key).toString("binary"), value, dt ?? null);
		b.commit();
	}
	/** Stage a rebuild in fresh per-index state and swap it in on commit(), so
	*  a rebuild that fails midway leaves the previous indexes fully intact. */
	beginRebuild() {
		const staged = [];
		for (const entry of this.indexes.values()) staged.push({
			entry,
			next: {
				...entry,
				groups: /* @__PURE__ */ new Map(),
				byPk: /* @__PURE__ */ new Map()
			}
		});
		return {
			add: (pk, doc, dt) => {
				for (const { next } of staged) this.addToEntry(next, pk, doc, dt);
			},
			commit: () => {
				for (const { entry, next } of staged) {
					entry.groups = next.groups;
					entry.byPk = next.byPk;
				}
			}
		};
	}
	/** Stage-5 generation: export every LIVE compound index's full state for
	*  image serialization (group entries in ascending (order, pk) order).
	*  Indexes whose group values include a non-serializable type (objects —
	*  Map identity semantics cannot survive a round-trip) are SKIPPED and
	*  named in `skipped`; the loader rebuilds those from the store. */
	exportImage() {
		const images = [];
		const skipped = [];
		for (const [name, entry] of this.indexes) {
			let serializable = true;
			const groups = [];
			for (const [group, list] of entry.groups) {
				const t = typeof group;
				if (group !== null && t !== "number" && t !== "string" && t !== "boolean") {
					serializable = false;
					break;
				}
				groups.push({
					group,
					entries: list.toArray().map((n) => ({
						order: n.key,
						pk: n.val
					}))
				});
			}
			if (!serializable) {
				skipped.push(name);
				continue;
			}
			images.push({
				name,
				groupBy: entry.def.groupBy,
				orderBy: entry.def.orderBy,
				orderType: entry.def.orderType,
				groups
			});
		}
		return {
			images,
			skipped
		};
	}
	/** Replace ONE live compound index's state from a loaded generation image
	*  (the caller already matched the definition hash). Group lists are
	*  bulk-built in O(N); the byPk placement map is derived from them. */
	loadImage(image) {
		const entry = this.indexes.get(image.name);
		if (!entry) throw new Error(`no such compound index: ${image.name}`);
		const groups = /* @__PURE__ */ new Map();
		const byPk = /* @__PURE__ */ new Map();
		for (const g of image.groups) {
			const list = SkipList.bulkLoad(g.entries.map((e) => ({
				key: e.order,
				val: e.pk
			})), {
				compareKey: entry.cmp,
				compareVal: cmpString
			});
			groups.set(g.group, list);
			for (const e of g.entries) byPk.set(e.pk, {
				group: g.group,
				order: e.order
			});
		}
		entry.groups = groups;
		entry.byPk = byPk;
	}
	/** Sliced variant of loadImage (the open-time main-thread path): identical
	*  resulting state, but the group/byPk map construction yields to the
	*  event loop every `sliceEvery` entries. The state swap itself stays one
	*  synchronous segment (the containers are detached until then), and the
	*  store is not published until open() returns, so a mid-load yield is
	*  never observable. */
	async loadImageAsync(image, opts = {}) {
		const sliceEvery = opts.sliceEvery ?? 32768;
		const entry = this.indexes.get(image.name);
		if (!entry) throw new Error(`no such compound index: ${image.name}`);
		const groups = /* @__PURE__ */ new Map();
		const byPk = /* @__PURE__ */ new Map();
		let n = 0;
		for (const g of image.groups) {
			const list = await SkipList.bulkLoadAsync(g.entries.map((e) => ({
				key: e.order,
				val: e.pk
			})), {
				compareKey: entry.cmp,
				compareVal: cmpString
			}, { sliceEvery });
			groups.set(g.group, list);
			for (const e of g.entries) {
				byPk.set(e.pk, {
					group: g.group,
					order: e.order
				});
				if (++n % sliceEvery === 0) await new Promise((r) => setImmediate(r));
			}
		}
		entry.groups = groups;
		entry.byPk = byPk;
	}
};
// ../../packages/minidb/src/dt-index.ts
var DtIndex = class {
	cols = /* @__PURE__ */ new Map();
	byKey = /* @__PURE__ */ new Map();
	col(name) {
		let c = this.cols.get(name);
		if (!c) {
			c = {
				list: new SkipList({
					compareKey: cmpNumber,
					compareVal: cmpString
				}),
				byKey: /* @__PURE__ */ new Map()
			};
			this.cols.set(name, c);
		}
		return c;
	}
	/** Set/replace the dt columns for a key. dt = { col: ms } or null. */
	set(key, dt) {
		const old = this.byKey.get(key) ?? {};
		const next = dt ?? {};
		for (const col of Object.keys(old)) if (!(col in next) || old[col] !== next[col]) {
			const c = this.cols.get(col);
			if (c) {
				c.list.delete(old[col], key);
				c.byKey.delete(key);
				if (c.byKey.size === 0) this.cols.delete(col);
			}
		}
		for (const col of Object.keys(next)) {
			const ms = next[col];
			if (typeof ms !== "number" || !Number.isFinite(ms)) continue;
			if (old[col] === ms) continue;
			const c = this.col(col);
			c.list.insert(ms, key);
			c.byKey.set(key, ms);
		}
		if (Object.keys(next).length > 0) this.byKey.set(key, { ...next });
		else this.byKey.delete(key);
	}
	del(key) {
		const old = this.byKey.get(key);
		if (!old) return;
		for (const col of Object.keys(old)) {
			const c = this.cols.get(col);
			if (c) {
				c.list.delete(old[col], key);
				c.byKey.delete(key);
				if (c.byKey.size === 0) this.cols.delete(col);
			}
		}
		this.byKey.delete(key);
	}
	/** Range over a dt column. */
	range(col, opts = {}) {
		const c = this.cols.get(col);
		if (!c) return [];
		return c.list.range(opts).map((n) => ({
			key: n.val,
			value: n.key
		}));
	}
	/** Lazy range over a dt column; yields { key: recordKey, value: ts } like
	*  range() but lets the caller stop early without materializing everything. */
	*iterate(col, opts = {}) {
		const c = this.cols.get(col);
		if (!c) return;
		for (const n of c.list.iterate(opts)) yield {
			key: n.val,
			value: n.key
		};
	}
	columns() {
		return [...this.cols.keys()];
	}
	/** Rebuild from an iterator of { key, dt }. */
	rebuild(entries) {
		const b = this.beginRebuild();
		for (const { key, dt } of entries) b.add(key, dt);
		b.commit();
	}
	/** Stage-5 generation: export the whole index as columns with entries in
	*  ascending (ms, key) order — the image serialization order. */
	exportImage() {
		return [...this.cols.entries()].map(([name, c]) => ({
			name,
			entries: c.list.toArray().map((n) => ({
				ms: n.key,
				key: n.val
			}))
		}));
	}
	/** Replace the whole index from a loaded generation image: the columns are
	*  bulk-built (O(N)) and the byKey reverse map is derived from them. */
	loadImage(cols) {
		const nextCols = /* @__PURE__ */ new Map();
		const nextByKey = /* @__PURE__ */ new Map();
		for (const { name, entries } of cols) {
			const list = SkipList.bulkLoad(entries.map((e) => ({
				key: e.ms,
				val: e.key
			})), {
				compareKey: cmpNumber,
				compareVal: cmpString
			});
			const byKey = /* @__PURE__ */ new Map();
			for (const e of entries) {
				byKey.set(e.key, e.ms);
				const rec = nextByKey.get(e.key) ?? {};
				rec[name] = e.ms;
				nextByKey.set(e.key, rec);
			}
			nextCols.set(name, {
				list,
				byKey
			});
		}
		this.cols = nextCols;
		this.byKey = nextByKey;
	}
	/** Stage a rebuild in fresh state and swap it in on commit(), so a rebuild
	*  that fails midway leaves the previous index fully intact. Rebuild keys
	*  are unique (one store record each), so add() is a pure insert — the
	*  diff-based set() logic is not needed here. */
	beginRebuild() {
		const cols = /* @__PURE__ */ new Map();
		const byKey = /* @__PURE__ */ new Map();
		return {
			add: (key, dt) => {
				if (!dt) return;
				const rec = {};
				for (const [name, ms] of Object.entries(dt)) {
					if (typeof ms !== "number" || !Number.isFinite(ms)) continue;
					let c = cols.get(name);
					if (!c) {
						c = {
							list: new SkipList({
								compareKey: cmpNumber,
								compareVal: cmpString
							}),
							byKey: /* @__PURE__ */ new Map()
						};
						cols.set(name, c);
					}
					c.list.insert(ms, key);
					c.byKey.set(key, ms);
					rec[name] = ms;
				}
				if (Object.keys(rec).length > 0) byKey.set(key, rec);
			},
			commit: () => {
				this.cols = cols;
				this.byKey = byKey;
			}
		};
	}
};
// ../../packages/minidb/src/gen-codec.ts
/** Thrown by every reader on a malformed/truncated/crc-mismatched generation
*  file. Distinct from CorruptFrameError so the loader can route precisely. */
var GenerationCorruptError = class extends Error {
	code = "GENERATION_CORRUPT";
	constructor(message) {
		super(message);
		this.name = "GenerationCorruptError";
	}
};
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
var ByteReader = class {
	buf;
	off = 0;
	constructor(buf) {
		this.buf = buf;
	}
	need(n) {
		if (this.off + n > this.buf.length) throw new GenerationCorruptError("generation file truncated");
	}
	u8() {
		this.need(1);
		const v = this.buf.readUInt8(this.off);
		this.off += 1;
		return v;
	}
	u16() {
		this.need(2);
		const v = this.buf.readUInt16LE(this.off);
		this.off += 2;
		return v;
	}
	u32() {
		this.need(4);
		const v = this.buf.readUInt32LE(this.off);
		this.off += 4;
		return v;
	}
	u64() {
		this.need(8);
		const v = Number(this.buf.readBigUInt64LE(this.off));
		this.off += 8;
		return v;
	}
	i64() {
		this.need(8);
		const v = Number(this.buf.readBigInt64LE(this.off));
		this.off += 8;
		return v;
	}
	f64() {
		this.need(8);
		const v = this.buf.readDoubleLE(this.off);
		this.off += 8;
		return v;
	}
	bytes(n) {
		this.need(n);
		const b = this.buf.subarray(this.off, this.off + n);
		this.off += n;
		return b;
	}
	key() {
		const n = this.u16();
		return this.bytes(n).toString("binary");
	}
	text() {
		const n = this.u32();
		return this.bytes(n).toString("utf8");
	}
	term() {
		const n = this.u16();
		return this.bytes(n).toString("utf8");
	}
	get done() {
		return this.off === this.buf.length;
	}
};
const FLUSH_BYTES$2 = 1 << 20;
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
		if (this.queued >= FLUSH_BYTES$2) await this.flush();
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
/** Sliced variant of readGenerationFileChecked (stage 6): the file is read
*  and crc'd in 1 MiB slices with event-loop yields, so verifying a large
*  dictionary/docs image never blocks the loop for the whole pass. The
*  payload still lands in RAM wholesale (it becomes in-memory state), only
*  the read + verification is sliced. */
async function readGenerationFileCheckedAsync(path, magic, version, expected) {
	let buf;
	try {
		buf = await fs$1.readFile(path);
	} catch (error) {
		throw new GenerationCorruptError(`generation file unreadable: ${error.code ?? String(error)}`);
	}
	if (buf.length < 12) throw new GenerationCorruptError("generation file too short");
	for (let i = 0; i < 4; i++) if (buf.readUInt8(i) !== magic.charCodeAt(i)) throw new GenerationCorruptError(`bad magic (want ${magic})`);
	if (buf.readUInt32LE(4) !== version) throw new GenerationCorruptError(`unsupported file version (want ${version})`);
	const stored = buf.readUInt32LE(buf.length - 4);
	let crc = 0;
	const SLICE = 1 << 20;
	for (let pos = 0; pos < buf.length - 4; pos += SLICE) {
		crc = crc32(buf.subarray(pos, Math.min(pos + SLICE, buf.length - 4)), crc);
		await new Promise((r) => setImmediate(r));
	}
	if (stored !== crc) throw new GenerationCorruptError("generation file crc mismatch");
	if (buf.length !== expected.bytes || stored !== expected.crc32) throw new GenerationCorruptError("generation file does not match manifest record");
	return new ByteReader(buf.subarray(8, buf.length - 4));
}
const yieldToLoop$1 = () => new Promise((r) => setImmediate(r));
/** The read/verify chunk size of verifyFileIntegrityAsync: one crc32 slice per
*  chunk, then a yield — a large postings file verifies in bounded ~ms
*  slices instead of one synchronous pass. */
const VERIFY_CHUNK_BYTES = 1 << 20;
/** Async sliced variant of verifyFileIntegritySync (the open-time main-thread
*  path): bounded 1 MiB positioned reads, a crc32 slice and an event-loop
*  yield per chunk, so verifying a large postings file never blocks the loop
*  for the whole pass. Identical error semantics. */
async function verifyFileIntegrityAsync(path, expected) {
	const fh = await fs$1.open(path, "r");
	try {
		const st = await fh.stat();
		if (st.size !== expected.bytes) throw new GenerationCorruptError("file size does not match manifest record");
		let crc = 0;
		const buf = Buffer.allocUnsafe(Math.min(VERIFY_CHUNK_BYTES, Math.max(st.size, 1)));
		let pos = 0;
		while (pos < st.size) {
			const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, st.size - pos), pos);
			if (bytesRead === 0) throw new GenerationCorruptError("file shrank during integrity check");
			crc = crc32(buf.subarray(0, bytesRead), crc);
			pos += bytesRead;
			await yieldToLoop$1();
		}
		if (crc >>> 0 !== expected.crc32) throw new GenerationCorruptError("file crc does not match manifest record");
	} finally {
		await fh.close().catch(() => {});
	}
}
const STORE_MAGIC = "MDGS";
const TAG_INLINE = 0;
const TAG_SNAPSHOT_LOC = 1;
const TAG_WAL_LOC = 2;
/** The Store's dt accounting value for one record (mirrors Store.metaBytes:
*  byte length of the canonical `{"dt":...}` meta JSON, 0 for none). */
function dtMetaBytes(dt) {
	return dt ? Buffer.byteLength(JSON.stringify({ dt }), "utf8") : 0;
}
/** Stream the store image to `path`. `records` must yield live records in
*  ascending canonical-key order (the load path bulk-builds the ordered index
*  from file order). Returns the manifest file info + the record count. */
async function writeStoreImage(path, records) {
	const w = await GenFileWriter.open(path, STORE_MAGIC, 4);
	let count = 0;
	try {
		for (const r of records) {
			await w.writeRecord((b) => {
				b.key(r.kstr);
				b.i64(r.expireAt);
				const cols = r.dt ? Object.entries(r.dt) : [];
				b.u32(dtMetaBytes(r.dt));
				b.u32(cols.length);
				for (const [name, ms] of cols) {
					const nb = Buffer.from(name, "utf8");
					b.u32(nb.length);
					b.bytes(nb);
					b.f64(ms);
				}
				if (r.ref.kind === "memory") {
					b.u8(TAG_INLINE);
					b.u32(r.ref.value.length);
					b.bytes(r.ref.value);
				} else {
					b.u8(r.ref.loc.file === "snapshot" ? TAG_SNAPSHOT_LOC : TAG_WAL_LOC);
					b.u64(r.ref.loc.off);
					b.u32(r.ref.loc.len);
				}
			});
			count++;
		}
		return {
			...await w.finish(),
			count
		};
	} catch (error) {
		await w.abort();
		throw error;
	}
}
/** Parse a store image payload, yielding records in file (sorted) order.
*  Values are COPIED out of the shared file buffer (the store must own its
*  memory refs) and metaBytes carries the exact Store accounting hint. */
function* readStoreImage(r) {
	while (!r.done) {
		const kstr = r.key();
		const expireAt = r.i64();
		const metaBytes = r.u32();
		const colCount = r.u32();
		let dt = null;
		if (colCount > 0) {
			dt = {};
			for (let i = 0; i < colCount; i++) {
				const nameLen = r.u32();
				const name = r.bytes(nameLen).toString("utf8");
				dt[name] = r.f64();
			}
		}
		const tag = r.u8();
		let ref;
		if (tag === TAG_INLINE) {
			const len = r.u32();
			ref = {
				kind: "memory",
				value: Buffer.from(r.bytes(len))
			};
		} else if (tag === TAG_SNAPSHOT_LOC || tag === TAG_WAL_LOC) {
			const off = r.u64();
			const len = r.u32();
			ref = {
				kind: "disk",
				loc: {
					file: tag === TAG_SNAPSHOT_LOC ? "snapshot" : "wal",
					off,
					len
				}
			};
		} else throw new GenerationCorruptError(`store image: unknown value tag ${tag}`);
		yield {
			kstr,
			ref,
			expireAt,
			dt,
			metaBytes
		};
	}
}
const DT_MAGIC = "MDGD";
const DT_VERSION = 1;
async function writeDtIndexImage(path, cols) {
	const w = await GenFileWriter.open(path, DT_MAGIC, DT_VERSION);
	try {
		await w.writeRecord((b) => b.u32(cols.length));
		for (const c of cols) {
			await w.writeRecord((b) => {
				b.text(c.name);
				b.u64(c.entries.length);
			});
			for (const e of c.entries) await w.writeRecord((b) => {
				b.f64(e.ms);
				b.key(e.key);
			});
		}
		return await w.finish();
	} catch (error) {
		await w.abort();
		throw error;
	}
}
function readDtIndexImage(r) {
	const colCount = r.u32();
	const cols = [];
	for (let i = 0; i < colCount; i++) {
		const name = r.text();
		const n = r.u64();
		const entries = [];
		for (let j = 0; j < n; j++) entries.push({
			ms: r.f64(),
			key: r.key()
		});
		cols.push({
			name,
			entries
		});
	}
	if (!r.done) throw new GenerationCorruptError("dt index image: trailing bytes");
	return cols;
}
const SECONDARY_MAGIC = "MDSI";
const SECONDARY_VERSION = 1;
async function writeSecondaryIndexImage(path, indexes) {
	const w = await GenFileWriter.open(path, SECONDARY_MAGIC, SECONDARY_VERSION);
	try {
		await w.writeRecord((b) => b.u32(indexes.length));
		for (const idx of indexes) {
			await w.writeRecord((b) => {
				b.text(idx.name);
				b.text(idx.field);
				b.u8(idx.type === "range" ? 2 : 1);
				b.u8((idx.unique ? 1 : 0) | (idx.sparse ? 2 : 0));
			});
			if (idx.type === "equality") {
				const values = idx.equality ?? [];
				await w.writeRecord((b) => b.u64(values.length));
				for (const v of values) {
					await w.writeRecord((b) => {
						b.text(v.scalarKey);
						b.u64(v.pks.length);
					});
					for (const pk of v.pks) await w.writeRecord((b) => b.key(pk));
				}
			} else {
				const entries = idx.range ?? [];
				await w.writeRecord((b) => b.u64(entries.length));
				for (const e of entries) await w.writeRecord((b) => {
					b.f64(e.value);
					b.key(e.pk);
				});
			}
		}
		return await w.finish();
	} catch (error) {
		await w.abort();
		throw error;
	}
}
/** Sliced variant of readSecondaryIndexImage (stage 6): identical result,
*  with event-loop yields every `yieldEvery` parsed entries so a large image
*  never parses in one synchronous run. */
async function readSecondaryIndexImageAsync(r, yieldEvery = 32768) {
	const count = r.u32();
	const out = [];
	let n = 0;
	const tick = async () => {
		if (++n % yieldEvery === 0) await yieldToLoop$1();
	};
	for (let i = 0; i < count; i++) {
		const name = r.text();
		const field = r.text();
		const typeTag = r.u8();
		const flags = r.u8();
		const type = typeTag === 2 ? "range" : typeTag === 1 ? "equality" : null;
		if (type === null) throw new GenerationCorruptError(`secondary image: unknown index type ${typeTag}`);
		let equality = null;
		let range = null;
		if (type === "equality") {
			equality = [];
			const valueCount = r.u64();
			for (let v = 0; v < valueCount; v++) {
				const scalarKey = r.text();
				const pkCount = r.u64();
				const pks = [];
				for (let p = 0; p < pkCount; p++) {
					pks.push(r.key());
					await tick();
				}
				equality.push({
					scalarKey,
					pks
				});
			}
		} else {
			range = [];
			const m = r.u64();
			for (let j = 0; j < m; j++) {
				range.push({
					value: r.f64(),
					pk: r.key()
				});
				await tick();
			}
		}
		out.push({
			name,
			field,
			type,
			unique: (flags & 1) !== 0,
			sparse: (flags & 2) !== 0,
			equality,
			range
		});
	}
	if (!r.done) throw new GenerationCorruptError("secondary index image: trailing bytes");
	return out;
}
const COMPOUND_MAGIC = "MDCI";
const COMPOUND_VERSION = 1;
const GTAG_NUMBER = 1;
const GTAG_STRING = 2;
const GTAG_FALSE = 3;
const GTAG_TRUE = 4;
const GTAG_NULL = 5;
function writeGroupValue(b, v) {
	if (v === null) b.u8(GTAG_NULL);
	else if (typeof v === "number") {
		b.u8(GTAG_NUMBER);
		b.f64(v);
	} else if (typeof v === "string") {
		b.u8(GTAG_STRING);
		b.text(v);
	} else if (v === false) b.u8(GTAG_FALSE);
	else b.u8(GTAG_TRUE);
}
function readGroupValue(r) {
	const tag = r.u8();
	if (tag === GTAG_NUMBER) return r.f64();
	if (tag === GTAG_STRING) return r.text();
	if (tag === GTAG_FALSE) return false;
	if (tag === GTAG_TRUE) return true;
	if (tag === GTAG_NULL) return null;
	throw new GenerationCorruptError(`compound image: unknown group tag ${tag}`);
}
async function writeCompoundIndexImage(path, indexes) {
	const w = await GenFileWriter.open(path, COMPOUND_MAGIC, COMPOUND_VERSION);
	try {
		await w.writeRecord((b) => b.u32(indexes.length));
		for (const idx of indexes) {
			await w.writeRecord((b) => {
				b.text(idx.name);
				b.text(idx.groupBy);
				b.text(idx.orderBy);
				b.u8(idx.orderType === "string" ? 2 : 1);
				b.u64(idx.groups.length);
			});
			for (const g of idx.groups) {
				await w.writeRecord((b) => {
					writeGroupValue(b, g.group);
					b.u64(g.entries.length);
				});
				for (const e of g.entries) await w.writeRecord((b) => {
					if (idx.orderType === "string") b.text(String(e.order));
					else b.f64(Number(e.order));
					b.key(e.pk);
				});
			}
		}
		return await w.finish();
	} catch (error) {
		await w.abort();
		throw error;
	}
}
/** Sliced variant of readCompoundIndexImage (stage 6): identical result, with
*  event-loop yields every `yieldEvery` parsed entries. */
async function readCompoundIndexImageAsync(r, yieldEvery = 32768) {
	const count = r.u32();
	const out = [];
	let n = 0;
	const tick = async () => {
		if (++n % yieldEvery === 0) await yieldToLoop$1();
	};
	for (let i = 0; i < count; i++) {
		const name = r.text();
		const groupBy = r.text();
		const orderBy = r.text();
		const ot = r.u8();
		const orderType = ot === 2 ? "string" : ot === 1 ? "number" : null;
		if (orderType === null) throw new GenerationCorruptError(`compound image: unknown order type ${ot}`);
		const groupCount = r.u64();
		const groups = [];
		for (let g = 0; g < groupCount; g++) {
			const group = readGroupValue(r);
			const m = r.u64();
			const entries = [];
			for (let j = 0; j < m; j++) {
				const order = orderType === "string" ? r.text() : r.f64();
				entries.push({
					order,
					pk: r.key()
				});
				await tick();
			}
			groups.push({
				group,
				entries
			});
		}
		out.push({
			name,
			groupBy,
			orderBy,
			orderType,
			groups
		});
	}
	if (!r.done) throw new GenerationCorruptError("compound index image: trailing bytes");
	return out;
}
const TEXT_DICT_MAGIC = "MDTD";
const TEXT_DICT_VERSION = 1;
const TEXT_DOCS_MAGIC = "MDTC";
const TEXT_DOCS_VERSION = 1;
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
/** Sliced variant (stage 6): identical result, with event-loop yields every
*  `yieldEvery` entries so a million-term dictionary never parses in one
*  synchronous run. */
async function readTextDictionaryImageAsync(r, yieldEvery = 65536) {
	const out = [];
	let n = 0;
	while (!r.done) {
		out.push({
			term: r.term(),
			off: r.u64(),
			len: r.u32(),
			df: r.u32()
		});
		if (++n % yieldEvery === 0) await new Promise((res) => setImmediate(res));
	}
	return out;
}
async function writeTextDocsImage(path, image) {
	const w = await GenFileWriter.open(path, TEXT_DOCS_MAGIC, TEXT_DOCS_VERSION);
	try {
		await w.writeRecord((b) => {
			b.u64(image.keys.length);
			b.u64(image.liveCount);
			b.u64(image.removed.length);
			b.u64(image.delta.length);
		});
		for (let i = 0; i < image.keys.length; i++) {
			const k = image.keys[i];
			await w.writeRecord((b) => {
				if (k === void 0) b.u8(0);
				else {
					b.u8(1);
					b.key(k);
				}
				b.u32(image.docLens[i] ?? 0);
			});
		}
		for (const id of image.removed) await w.writeRecord((b) => b.u32(id));
		for (const d of image.delta) {
			await w.writeRecord((b) => {
				b.term(d.term);
				b.u64(d.docs.length);
			});
			for (const doc of d.docs) await w.writeRecord((b) => {
				b.u32(doc.docID);
				b.u32(doc.freq);
			});
		}
		return await w.finish();
	} catch (error) {
		await w.abort();
		throw error;
	}
}
/** Sliced variant of readTextDocsImage (stage 6): identical result, with
*  event-loop yields every `yieldEvery` parsed entries so a large doc table
*  or delta never parses in one synchronous run. */
async function readTextDocsImageAsync(r, yieldEvery = 32768) {
	const docCount = r.u64();
	const liveCount = r.u64();
	const removedCount = r.u64();
	const deltaCount = r.u64();
	let n = 0;
	const tick = async () => {
		if (++n % yieldEvery === 0) await yieldToLoop$1();
	};
	const keys = [];
	const docLens = [];
	for (let i = 0; i < docCount; i++) {
		const present = r.u8();
		if (present === 1) {
			keys.push(r.key());
			docLens.push(r.u32());
		} else if (present === 0) {
			keys.push(void 0);
			const len = r.u32();
			docLens.push(len === 0 ? void 0 : len);
		} else throw new GenerationCorruptError(`text docs image: unknown presence tag ${present}`);
		await tick();
	}
	const removed = [];
	for (let i = 0; i < removedCount; i++) {
		removed.push(r.u32());
		await tick();
	}
	const delta = [];
	for (let i = 0; i < deltaCount; i++) {
		const term = r.term();
		const m = r.u64();
		const docs = [];
		for (let j = 0; j < m; j++) {
			docs.push({
				docID: r.u32(),
				freq: r.u32()
			});
			await tick();
		}
		delta.push({
			term,
			docs
		});
	}
	if (!r.done) throw new GenerationCorruptError("text docs image: trailing bytes");
	return {
		keys,
		docLens,
		liveCount,
		removed,
		delta
	};
}
// ../../packages/minidb/src/generation-files.ts
function generationsDir(dir) {
	return path.join(dir, GENERATIONS_DIR);
}
function generationDir(dir, id) {
	return path.join(dir, GENERATIONS_DIR, id);
}
/** The published generation id (one line), or null when no generation has
*  ever been published (legacy database) or CURRENT is unreadable junk —
*  both mean "use the legacy full recovery". Never throws on missing/corrupt
*  content: CURRENT is a hint, the manifest validation is the gate. */
async function readCurrent(dir) {
	try {
		const id = (await fs$1.readFile(path.join(dir, CURRENT_FILE), "utf8")).trim();
		return parseGenerationId(id) === null ? null : id;
	} catch {
		return null;
	}
}
/** List generation directories (both published and stray tmp dirs), newest
*  first by numeric id. */
async function listGenerations(dir) {
	let names;
	try {
		names = await fs$1.readdir(generationsDir(dir));
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	const out = [];
	for (const name of names) {
		if (GEN_TMP_PATTERN.test(name)) {
			const n = parseGenerationId(name.split(".tmp-")[0]);
			if (n !== null) out.push({
				id: name,
				n,
				tmp: true
			});
			continue;
		}
		const n = parseGenerationId(name);
		if (n !== null) out.push({
			id: name,
			n,
			tmp: false
		});
	}
	out.sort((a, b) => b.n - a.n);
	return out;
}
/** Read + validate a generation's manifest. Throws GenerationCorruptError on
*  any structural violation — INCLUDING an unknown (newer) format version:
*  the caller must fall back WITHOUT deleting anything, so a newer binary's
*  generations survive an older binary's open. */
async function readManifest(dir, id) {
	let parsed;
	try {
		const raw = await fs$1.readFile(path.join(generationDir(dir, id), MANIFEST_FILE), "utf8");
		parsed = JSON.parse(raw);
	} catch (error) {
		if (error.code === "ENOENT") throw new GenerationCorruptError(`generation ${id}: manifest missing`);
		throw new GenerationCorruptError(`generation ${id}: manifest unreadable: ${error.message}`);
	}
	if (typeof parsed !== "object" || parsed === null) throw new GenerationCorruptError(`generation ${id}: manifest not an object`);
	if (parsed.format !== 1) throw new GenerationCorruptError(`generation ${id}: unknown format version ${String(parsed.format)}`);
	if (parsed.id !== id) throw new GenerationCorruptError(`generation ${id}: manifest id mismatch (${String(parsed.id)})`);
	const cp = parsed.checkpoint;
	if (!cp || typeof cp.walOffset !== "number" || typeof cp.walDev !== "number" || typeof cp.walIno !== "number" || typeof cp.walSize !== "number" || cp.walOffset < 0 || cp.walSize < cp.walOffset) throw new GenerationCorruptError(`generation ${id}: manifest checkpoint invalid`);
	if (parsed.valueMode !== "memory" && parsed.valueMode !== "disk") throw new GenerationCorruptError(`generation ${id}: unknown value mode`);
	if (typeof parsed.files !== "object" || parsed.files === null) throw new GenerationCorruptError(`generation ${id}: manifest files invalid`);
	return parsed;
}
/** Write the manifest LAST inside the tmp generation dir and fsync it (every
*  payload file is already durable, so a visible manifest implies a complete
*  generation). */
async function writeManifest(tmpDir, manifest) {
	const p = path.join(tmpDir, MANIFEST_FILE);
	const h = await fs$1.open(p, "w");
	try {
		await h.writeFile(JSON.stringify(manifest, null, 1), "utf8");
		await h.sync();
	} finally {
		await h.close().catch(() => {});
	}
}
/** The publish sequence: rename the fully-written tmp dir to its final
*  generation name, fsync generations/, then atomically replace CURRENT and
*  fsync the db dir. After this resolves, openers can only see either the
*  previous CURRENT or a complete generation — never a partial one. */
async function publishGeneration(dir, tmpName, id, opts = {}) {
	const gens = generationsDir(dir);
	await renameReplace(path.join(gens, tmpName), path.join(gens, id));
	await fsyncDir(gens, {
		strict: true,
		stats: opts.stats
	});
	const currentTmp = path.join(dir, `${CURRENT_FILE}.tmp-${process.pid}-${Date.now()}`);
	try {
		const h = await fs$1.open(currentTmp, "w");
		try {
			await h.writeFile(`${id}\n`, "utf8");
			await h.sync();
		} finally {
			await h.close().catch(() => {});
		}
		await renameReplace(currentTmp, path.join(dir, CURRENT_FILE));
	} finally {
		await fs$1.rm(currentTmp, { force: true }).catch(() => {});
	}
	await fsyncDir(dir, {
		strict: true,
		stats: opts.stats
	});
}
/** Remove every generation directory that is neither in `keep`, nor the
*  CURRENT-published one (re-read HERE, so concurrent cleanups with stale
*  keep-sets can never delete the live generation — a cleanup racing a later
*  publish must not remove what CURRENT now names), nor a live tmp build.
*  Best-effort: failures are counted, never thrown (a stray directory wastes
*  disk but can never corrupt the CURRENT-pointed state). */
async function cleanupGenerations(dir, keep) {
	const keepAll = new Set(keep);
	const current = await readCurrent(dir);
	if (current) keepAll.add(current);
	let errors = 0;
	for (const g of await listGenerations(dir)) {
		if (keepAll.has(g.id)) continue;
		try {
			await fs$1.rm(path.join(generationsDir(dir), g.id), {
				recursive: true,
				force: true
			});
		} catch {
			errors++;
		}
	}
	return errors;
}
/** Open-time sweep (writer only): remove stranded build tmp dirs. */
async function sweepGenerationTemps(dir) {
	for (const g of await listGenerations(dir)) if (g.tmp) await fs$1.rm(path.join(generationsDir(dir), g.id), {
		recursive: true,
		force: true
	}).catch(() => {});
}
// ../../packages/minidb/src/index-manager.ts
var UniqueViolationError = class extends Error {
	constructor(index, value) {
		super(`unique index "${index}" violation on value ${JSON.stringify(value)}`);
		this.name = "UniqueViolationError";
	}
};
function getField(doc, path) {
	return path.split(".").reduce((o, k) => o === null || o === void 0 ? void 0 : o[k], doc);
}
function stableStringify(v) {
	if (v === null || typeof v !== "object") return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
	return `{${Object.keys(v).toSorted().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}
function scalarKey(v) {
	const t = typeof v;
	if (t === "string" || t === "number" || t === "boolean") return `${t}:${String(v)}`;
	return `json:${stableStringify(v)}`;
}
function flatten(value) {
	return Array.isArray(value) ? value : [value];
}
/** A live-index holder of a batch-claimed value must be the claimant itself
*  or a key the batch vacates (deletes, or overwrites with a doc that no
*  longer carries the value); anything else is a final-state conflict. The
*  "touched and still claims it" sub-case never reaches a verdict here: it is
*  detected by the batch-local claim map when the holder's own final claims
*  are checked, so a 'set' final op is always treated as vacated at this
*  point. */
function assertVacated(idx, holder, claimant, value, lastOp) {
	if (holder === claimant) return;
	if (!lastOp.get(holder)) throw new UniqueViolationError(idx.name, value);
}
/** Insert one doc into an index's given state (shared by the incremental
*  write path and staged rebuilds). */
function insertDoc(idx, pk, doc) {
	const value = getField(doc, idx.field);
	if (value === void 0 && idx.sparse) return;
	if (idx.type === "range") {
		const vals = [...new Set(flatten(value).filter((v) => typeof v === "number" && Number.isFinite(v)))];
		if (vals.length === 0) return;
		for (const v of vals) idx.list.insert(v, pk);
		idx.byPk.set(pk, vals);
	} else {
		const keys = [];
		for (const v of flatten(value)) {
			const sk = scalarKey(v);
			let set = idx.map.get(sk);
			if (!set) idx.map.set(sk, set = /* @__PURE__ */ new Set());
			set.add(pk);
			keys.push(sk);
		}
		idx.byPk.set(pk, keys);
	}
}
/** Remove one key from an index's given state (the per-index body of
*  IndexManager.remove). */
function removeFromIndex(idx, pk) {
	if (idx.type === "range") {
		const old = idx.byPk.get(pk);
		if (old) {
			for (const v of old) idx.list.delete(v, pk);
			idx.byPk.delete(pk);
		}
	} else {
		const keys = idx.byPk.get(pk);
		if (keys) {
			for (const sk of keys) {
				const set = idx.map.get(sk);
				if (set) {
					set.delete(pk);
					if (set.size === 0) idx.map.delete(sk);
				}
			}
			idx.byPk.delete(pk);
		}
	}
}
/** Throw a UniqueViolationError if adding `doc` for `pk` would violate this
*  one index (the per-index body of IndexManager.checkUnique). */
function checkUniqueOnIndex(idx, pk, doc) {
	if (!idx.unique) return;
	const value = getField(doc, idx.field);
	if (value === void 0 && idx.sparse) return;
	for (const v of flatten(value)) if (idx.type === "range") {
		if (typeof v !== "number" || !Number.isFinite(v)) continue;
		const hit = idx.list.range({
			gte: v,
			lte: v,
			count: 1
		});
		if (hit.length > 0 && hit[0].val !== pk) throw new UniqueViolationError(idx.name, v);
	} else {
		const set = idx.map.get(scalarKey(v));
		if (set && (set.size > 1 || set.size === 1 && !set.has(pk))) throw new UniqueViolationError(idx.name, v);
	}
}
/** Validate one unique index for a batch of ops against the index state AFTER
*  the whole batch (the per-index body of IndexManager.checkUniqueBatch;
*  `lastOp` is the batch's last op per key). */
function checkUniqueBatchOnIndex(idx, lastOp) {
	if (!idx.unique) return;
	const claimed = /* @__PURE__ */ new Map();
	for (const [pk, o] of lastOp) {
		if (o.op === "del") continue;
		const value = getField(o.doc, idx.field);
		if (value === void 0 && idx.sparse) continue;
		for (const v of flatten(value)) if (idx.type === "range") {
			if (typeof v !== "number" || !Number.isFinite(v)) continue;
			const prev = claimed.get(v);
			if (prev !== void 0 && prev !== pk) throw new UniqueViolationError(idx.name, v);
			claimed.set(v, pk);
			const hit = idx.list.range({
				gte: v,
				lte: v,
				count: 1
			});
			if (hit.length > 0) assertVacated(idx, hit[0].val, pk, v, lastOp);
		} else {
			const sk = scalarKey(v);
			const prev = claimed.get(sk);
			if (prev !== void 0 && prev !== pk) throw new UniqueViolationError(idx.name, v);
			claimed.set(sk, pk);
			const set = idx.map.get(sk);
			if (set) for (const h of set) assertVacated(idx, h, pk, v, lastOp);
		}
	}
}
var IndexManager = class IndexManager {
	indexes = /* @__PURE__ */ new Map();
	/** Definitions of in-flight createIndex transactions (plan 10's staged →
	*  persist → publish): an index under construction lives ONLY here until
	*  the definition sidecar is durably persisted and publish() moves it into
	*  the live map. It is invisible to every QUERY path (get/list/find*), but
	*  the write-maintenance paths (add/remove/checkUnique) feed it exactly like
	*  a live index: the staged rebuild covered the store as of stage time and
	*  every later write transitions it, so publish() is a bare map move and a
	*  staged unique index already constrains writes during its persist window.
	*  A failed create discards the staged entry, so the live registry never
	*  carries a phantom. */
	staged = /* @__PURE__ */ new Map();
	/** Live + staged count. The write paths guard their secondary-index
	*  maintenance with this (a staged index must be fed exactly like a live
	*  one); query paths keep using `indexes` directly. */
	get size() {
		return this.indexes.size + this.staged.size;
	}
	/** Any unique index, live or staged. While a unique create is in its
	*  persist window the staged index is fully built and must already
	*  constrain/check writes (and route them through the unique-write
	*  serializer), or a concurrent write could violate the constraint the
	*  publish is about to enforce. */
	hasUnique() {
		for (const idx of this.indexes.values()) if (idx.unique) return true;
		for (const idx of this.staged.values()) if (idx.unique) return true;
		return false;
	}
	/** Validate the definition and construct the (empty) index state. */
	static build(name, { field, type = "equality", unique = false, sparse = true }) {
		if (!field) throw new TypeError("index requires a field");
		return type === "range" ? {
			name,
			field,
			type,
			unique,
			sparse,
			list: new SkipList({
				compareKey: cmpNumber,
				compareVal: cmpString
			}),
			byPk: /* @__PURE__ */ new Map()
		} : {
			name,
			field,
			type,
			unique,
			sparse,
			map: /* @__PURE__ */ new Map(),
			byPk: /* @__PURE__ */ new Map()
		};
	}
	create(name, def = {}) {
		const idx = IndexManager.build(name, def);
		if (this.indexes.has(name)) throw new Error(`index "${name}" already exists`);
		this.indexes.set(name, idx);
		return idx;
	}
	/** Stage a new index definition off to the side (see `staged`). The field
	*  validation runs before the name collision check, matching create()'s
	*  error precedence. */
	stage(name, def) {
		const idx = IndexManager.build(name, def);
		if (this.indexes.has(name) || this.staged.has(name)) throw new Error(`index "${name}" already exists`);
		this.staged.set(name, idx);
	}
	/** Rebuild ONE staged index from an iterator of { key, value } (value =
	*  decoded doc). Unlike rebuild() this touches nothing live: a failure
	*  midway leaves every published index fully intact. */
	rebuildStaged(name, entries) {
		const idx = this.staged.get(name);
		if (!idx) throw new Error(`no staged index: ${name}`);
		for (const { key, value } of entries) {
			if (!value || typeof value !== "object") continue;
			insertDoc(idx, typeof key === "string" ? key : Buffer.from(key).toString("binary"), value);
		}
	}
	/** The staged definition in its persisted (IndexInfo) shape — the content a
	*  create transaction adds to the sidecar BEFORE publishing. */
	stagedInfo(name) {
		const idx = this.staged.get(name);
		if (!idx) throw new Error(`no staged index: ${name}`);
		const { name: n, field, type, unique, sparse } = idx;
		return {
			name: n,
			field,
			type,
			unique,
			sparse
		};
	}
	/** Move a staged index into the live registry. Pure in-memory switch — the
	*  sidecar persist already succeeded when this runs. */
	publish(name) {
		const idx = this.staged.get(name);
		if (!idx) throw new Error(`no staged index: ${name}`);
		this.staged.delete(name);
		this.indexes.set(name, idx);
	}
	/** Drop a staged index without publishing it (the create failed). */
	discardStaged(name) {
		this.staged.delete(name);
	}
	drop(name) {
		return this.indexes.delete(name);
	}
	get(name) {
		const idx = this.indexes.get(name);
		if (!idx) throw new Error(`no such index: ${name}`);
		return idx;
	}
	list() {
		return [...this.indexes.values()].map(({ name, field, type, unique, sparse }) => ({
			name,
			field,
			type,
			unique,
			sparse
		}));
	}
	/** Throw a UniqueViolationError if adding `doc` for `pk` would violate a unique index.
	*  `doc` must be the CANONICAL (persisted-view) value — what the json codec
	*  actually stored — so the constraint view always matches what a reopen
	*  rebuilds (stage 11). */
	checkUnique(pk, doc) {
		for (const idx of this.indexes.values()) checkUniqueOnIndex(idx, pk, doc);
		for (const idx of this.staged.values()) checkUniqueOnIndex(idx, pk, doc);
	}
	/**
	* Validate unique constraints for a batch of ops against the index state
	* AFTER the whole batch. The check is order-independent, so valid
	* transformations like swapping a unique value between two keys, or deleting
	* one key and reusing its value in another, are accepted (their final state
	* is still unique).
	*
	* `ops` is the full op list (set AND del); the last op per key wins. Every
	* `doc` must be the CANONICAL (persisted-view) value, the same contract as
	* checkUnique (stage 11).
	*
	* Incremental: for every value claimed by the batch it probes only that
	* value's current posting (O(1) equality / O(log N) range per value) and a
	* batch-local claim map — it never copies the full per-index owner state,
	* so a small batch stays cheap on a large index.
	*/
	checkUniqueBatch(ops) {
		const lastOp = /* @__PURE__ */ new Map();
		for (const o of ops) lastOp.set(o.pk, o);
		for (const idx of this.indexes.values()) checkUniqueBatchOnIndex(idx, lastOp);
		for (const idx of this.staged.values()) checkUniqueBatchOnIndex(idx, lastOp);
	}
	/**
	* Verify that an already-built unique index contains no duplicate values.
	* Used when creating a unique index over pre-existing data: if the data
	* already violates the constraint, the index must not be created. A
	* createIndex transaction validates its STAGED index (not yet reachable via
	* get()), so the staged map is consulted first.
	*/
	assertUniqueValid(name) {
		const idx = this.staged.get(name) ?? this.get(name);
		if (!idx.unique) return;
		if (idx.type === "range") {
			const owner = /* @__PURE__ */ new Map();
			for (const [pk, vals] of idx.byPk) for (const v of vals) {
				const prev = owner.get(v);
				if (prev !== void 0 && prev !== pk) throw new UniqueViolationError(idx.name, v);
				owner.set(v, pk);
			}
		} else for (const [, set] of idx.map) if (set.size > 1) {
			const sample = [...set][0];
			throw new UniqueViolationError(idx.name, `${set.size} keys (e.g. ${sample})`);
		}
	}
	add(pk, doc) {
		for (const idx of this.indexes.values()) insertDoc(idx, pk, doc);
		for (const idx of this.staged.values()) insertDoc(idx, pk, doc);
	}
	remove(pk, _doc) {
		for (const idx of this.indexes.values()) removeFromIndex(idx, pk);
		for (const idx of this.staged.values()) removeFromIndex(idx, pk);
	}
	findEq(name, value) {
		const idx = this.get(name);
		if (idx.type !== "equality") throw new Error(`index "${name}" is not an equality index`);
		const set = idx.map.get(scalarKey(value));
		return set ? [...set] : [];
	}
	/** O(1) membership test: is `pk` indexed under `value` on this equality
	*  index? Avoids materializing the full posting list like findEq does. */
	hasEq(name, value, pk) {
		const idx = this.get(name);
		if (idx.type !== "equality") throw new Error(`index "${name}" is not an equality index`);
		const set = idx.map.get(scalarKey(value));
		return !!set && set.has(pk);
	}
	findRange(name, opts = {}) {
		const idx = this.get(name);
		if (idx.type !== "range") throw new Error(`index "${name}" is not a range index`);
		const r = {};
		if (opts.min !== void 0) {
			if (opts.minExclusive) r.gt = opts.min;
			else r.gte = opts.min;
		}
		if (opts.max !== void 0) {
			if (opts.maxExclusive) r.lt = opts.max;
			else r.lte = opts.max;
		}
		if (opts.offset) r.offset = opts.offset;
		if (opts.count !== void 0) r.count = opts.count;
		if (opts.reverse) r.reverse = true;
		return idx.list.range(r).map((n) => ({
			pk: n.val,
			value: n.key
		}));
	}
	/** Rebuild all indexes from an iterator of { key, value } (value = decoded doc). */
	rebuild(entries) {
		const b = this.beginRebuild();
		for (const { key, value } of entries) {
			const pk = typeof key === "string" ? key : Buffer.from(key).toString("binary");
			b.add(pk, value);
		}
		b.commit();
	}
	/** Stage a rebuild in fresh per-index state and swap it in on commit(), so
	*  a rebuild that fails midway leaves the previous indexes fully intact. */
	beginRebuild() {
		const staged = [];
		for (const idx of this.indexes.values()) {
			const next = idx.type === "range" ? {
				...idx,
				list: new SkipList({
					compareKey: cmpNumber,
					compareVal: cmpString
				}),
				byPk: /* @__PURE__ */ new Map()
			} : {
				...idx,
				map: /* @__PURE__ */ new Map(),
				byPk: /* @__PURE__ */ new Map()
			};
			staged.push({
				idx,
				next
			});
		}
		return {
			add: (pk, doc) => {
				if (!doc || typeof doc !== "object") return;
				for (const { next } of staged) insertDoc(next, pk, doc);
			},
			commit: () => {
				for (const { idx, next } of staged) {
					if (idx.type === "range" && next.type === "range") idx.list = next.list;
					else if (idx.type === "equality" && next.type === "equality") idx.map = next.map;
					idx.byPk = next.byPk;
				}
			}
		};
	}
	/** Stage-5 generation: export every LIVE index's full state (equality maps
	*  and range lists in ascending order) for image serialization. */
	exportImage() {
		const out = [];
		for (const idx of this.indexes.values()) if (idx.type === "range") out.push({
			name: idx.name,
			field: idx.field,
			type: "range",
			unique: idx.unique,
			sparse: idx.sparse,
			equality: null,
			range: idx.list.toArray().map((n) => ({
				value: n.key,
				pk: n.val
			}))
		});
		else out.push({
			name: idx.name,
			field: idx.field,
			type: "equality",
			unique: idx.unique,
			sparse: idx.sparse,
			equality: [...idx.map.entries()].map(([scalarKey, set]) => ({
				scalarKey,
				pks: [...set]
			})),
			range: null
		});
		return out;
	}
	/** Replace ONE live index's state from a loaded generation image (the
	*  caller already matched the definition hash). Range lists are bulk-built
	*  in O(N); byPk reverse maps are derived from the forward state. */
	loadImage(image) {
		const idx = this.indexes.get(image.name);
		if (!idx) throw new Error(`no such index: ${image.name}`);
		if (idx.type !== image.type) throw new Error(`index "${image.name}" image type mismatch`);
		if (idx.type === "range" && image.range) {
			idx.list = SkipList.bulkLoad(image.range.map((e) => ({
				key: e.value,
				val: e.pk
			})), {
				compareKey: cmpNumber,
				compareVal: cmpString
			});
			const byPk = /* @__PURE__ */ new Map();
			for (const e of image.range) {
				const arr = byPk.get(e.pk);
				if (arr) arr.push(e.value);
				else byPk.set(e.pk, [e.value]);
			}
			idx.byPk = byPk;
		} else if (idx.type === "equality" && image.equality) {
			const map = /* @__PURE__ */ new Map();
			const byPk = /* @__PURE__ */ new Map();
			for (const v of image.equality) {
				map.set(v.scalarKey, new Set(v.pks));
				for (const pk of v.pks) {
					const arr = byPk.get(pk);
					if (arr) arr.push(v.scalarKey);
					else byPk.set(pk, [v.scalarKey]);
				}
			}
			idx.map = map;
			idx.byPk = byPk;
		} else throw new Error(`index "${image.name}" image payload missing`);
	}
	/** Sliced variant of loadImage (the open-time main-thread path): identical
	*  resulting state, but the forward/reverse map construction yields to the
	*  event loop every `sliceEvery` entries. The state swap itself (assigning
	*  the freshly built containers) stays one synchronous segment, so a
	*  mid-load yield can never expose a half-built index. Safe to yield while
	*  building: the containers are detached until the swap, and the store is
	*  not published until open() returns. */
	async loadImageAsync(image, opts = {}) {
		const sliceEvery = opts.sliceEvery ?? 32768;
		const idx = this.indexes.get(image.name);
		if (!idx) throw new Error(`no such index: ${image.name}`);
		if (idx.type !== image.type) throw new Error(`index "${image.name}" image type mismatch`);
		let n = 0;
		const tick = async () => {
			if (++n % sliceEvery === 0) await new Promise((r) => setImmediate(r));
		};
		if (idx.type === "range" && image.range) {
			const list = await SkipList.bulkLoadAsync(image.range.map((e) => ({
				key: e.value,
				val: e.pk
			})), {
				compareKey: cmpNumber,
				compareVal: cmpString
			}, { sliceEvery });
			const byPk = /* @__PURE__ */ new Map();
			for (const e of image.range) {
				const arr = byPk.get(e.pk);
				if (arr) arr.push(e.value);
				else byPk.set(e.pk, [e.value]);
				await tick();
			}
			idx.list = list;
			idx.byPk = byPk;
		} else if (idx.type === "equality" && image.equality) {
			const map = /* @__PURE__ */ new Map();
			const byPk = /* @__PURE__ */ new Map();
			for (const v of image.equality) {
				map.set(v.scalarKey, new Set(v.pks));
				for (const pk of v.pks) {
					const arr = byPk.get(pk);
					if (arr) arr.push(v.scalarKey);
					else byPk.set(pk, [v.scalarKey]);
					await tick();
				}
			}
			idx.map = map;
			idx.byPk = byPk;
		} else throw new Error(`index "${image.name}" image payload missing`);
	}
};
// ../../packages/minidb/src/maintenance.ts
var MaintenanceBackpressureError = class extends Error {
	code = "MAINTENANCE_BACKPRESSURE";
	constructor(kind) {
		super(`maintenance queue is full; cannot queue ${kind}`);
		this.name = "MaintenanceBackpressureError";
	}
};
var MaintenanceClosedError = class extends Error {
	code = "MAINTENANCE_CLOSED";
	constructor() {
		super("maintenance scheduler is closed");
		this.name = "MaintenanceClosedError";
	}
};
var MaintenanceCancelledError = class extends Error {
	code = "MAINTENANCE_CANCELLED";
	constructor(kind) {
		super(`maintenance task ${kind} was cancelled`);
		this.name = "AbortError";
	}
};
const HISTORY_LIMIT = 16;
var MaintenanceScheduler = class {
	nextId = 1;
	running = null;
	queue = [];
	history = [];
	closed = false;
	tracker = new OpTracker();
	maxQueue;
	estimateBytes;
	statfsFn;
	dir;
	/** The task whose run() is currently on the stack: a NESTED submission
	*  from inside a task (compaction's onCompacted hook submitting a
	*  generation build) must not queue behind its own task — that
	*  self-deadlocks the one-at-a-time invariant. Nested submissions run
	*  inline within the submitting task instead. */
	als = new AsyncLocalStorage();
	constructor(opts) {
		this.maxQueue = opts.maxQueue ?? 4;
		this.estimateBytes = opts.estimateBytes;
		this.statfsFn = opts.statfs ?? (async (dir) => (await import("node:fs/promises")).statfs(dir));
		this.dir = opts.dir;
	}
	/** Snapshot of every live task plus the most recent finished ones. */
	status() {
		const out = [];
		const push = (t) => {
			out.push({
				id: t.id,
				kind: t.kind,
				state: t.state,
				queuedAt: t.queuedAt,
				startedAt: t.startedAt,
				finishedAt: t.finishedAt,
				error: t.error
			});
		};
		if (this.running) push(this.running);
		for (const t of this.queue) push(t);
		return [...out, ...this.history];
	}
	/** The currently running task's kind (diagnostics/tests). */
	get runningKind() {
		return this.running?.kind ?? null;
	}
	/** Whether a task of this kind is waiting in the queue. */
	hasQueued(kind) {
		return this.queue.some((t) => t.kind === kind);
	}
	/**
	* Queue a heavy task. At most one task runs at a time; a same-kind task
	* already queued or running is NOT duplicated — the caller receives the
	* in-flight task's promise (dedupe backpressure). A full queue of
	* other-kind tasks rejects with MaintenanceBackpressureError.
	*/
	submit(kind, run, opts = {}) {
		const current = this.als.getStore();
		if (current) {
			if (current.kind === kind) return current.promise ?? Promise.resolve();
			return run({
				signal: current.controller.signal,
				markPublishing: () => {
					if (current.state === "running") current.state = "publishing";
				}
			});
		}
		if (this.closed) return Promise.reject(new MaintenanceClosedError());
		if (this.running?.kind === kind) return this.promiseOf(this.running);
		const queued = this.queue.find((t) => t.kind === kind);
		if (queued) return this.promiseOf(queued);
		if (this.queue.length >= this.maxQueue) return Promise.reject(new MaintenanceBackpressureError(kind));
		if (!this.tracker.enter()) return Promise.reject(new MaintenanceClosedError());
		const task = {
			id: this.nextId++,
			kind,
			state: "queued",
			queuedAt: Date.now(),
			run,
			controller: new AbortController(),
			resolve: () => {},
			reject: () => {}
		};
		const promise = new Promise((resolve, reject) => {
			task.resolve = resolve;
			task.reject = reject;
		});
		task.promise = promise;
		if (opts.deadlineMs !== void 0) {
			task.deadlineTimer = setTimeout(() => task.controller.abort(), opts.deadlineMs);
			task.deadlineTimer.unref?.();
		}
		this.queue.push(task);
		this.pump();
		return promise;
	}
	promiseOf(task) {
		return task.promise;
	}
	async pump() {
		if (this.running !== null) return;
		const task = this.queue.shift();
		if (!task) return;
		this.running = task;
		task.state = "running";
		task.startedAt = Date.now();
		try {
			await this.preflight(task.kind);
		} catch (error) {
			this.finish(task, error);
			this.pump();
			return;
		}
		const ctx = {
			signal: task.controller.signal,
			markPublishing: () => {
				if (task.state === "running") task.state = "publishing";
			}
		};
		try {
			await this.als.run(task, () => task.run(ctx));
			this.finish(task, null);
		} catch (error) {
			this.finish(task, error);
		}
		this.pump();
	}
	/** Disk free-space preflight: a task whose estimated footprint exceeds the
	*  filesystem's available bytes fails BEFORE doing any work (the ENOSPC
	*  surfaces as a clean task failure, never a half-written artifact). A
	*  statfs failure or a null estimate skips the check — the preflight must
	*  never block maintenance on platforms without statfs. */
	async preflight(kind) {
		if (!this.estimateBytes) return;
		const need = await this.estimateBytes(kind);
		if (need === null || need <= 0) return;
		let free;
		try {
			const st = await this.statfsFn(this.dir);
			free = st.bavail * st.bsize;
		} catch {
			return;
		}
		if (free < need) {
			const err = /* @__PURE__ */ new Error(`insufficient disk space for ${kind}: need ~${need} bytes, have ${free} bytes`);
			err.code = "ENOSPC_PREFLIGHT";
			throw err;
		}
	}
	finish(task, error) {
		if (task.deadlineTimer) clearTimeout(task.deadlineTimer);
		task.state = error ? "failed" : "complete";
		task.finishedAt = Date.now();
		if (error) {
			task.error = error instanceof Error ? error.message : `non-Error thrown: ${Object.prototype.toString.call(error)}`;
			task.reject(error);
		} else task.resolve();
		this.history.unshift({
			id: task.id,
			kind: task.kind,
			state: task.state,
			queuedAt: task.queuedAt,
			startedAt: task.startedAt,
			finishedAt: task.finishedAt,
			error: task.error
		});
		if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT;
		if (this.running === task) this.running = null;
		this.tracker.leave();
	}
	/**
	* Shutdown (plan 12's drain/cancel): cancel every queued task and every
	* running task that has NOT reached its publishing critical section;
	* publishing tasks are awaited. Resolves once every task settled.
	* Idempotent; after close() new submissions reject with
	* MaintenanceClosedError.
	*/
	async close() {
		if (this.closed) return;
		this.closed = true;
		for (const t of this.queue.splice(0)) {
			if (t.deadlineTimer) clearTimeout(t.deadlineTimer);
			t.state = "failed";
			t.finishedAt = Date.now();
			t.error = "cancelled by shutdown";
			t.reject(new MaintenanceCancelledError(t.kind));
			this.history.unshift({
				id: t.id,
				kind: t.kind,
				state: t.state,
				queuedAt: t.queuedAt,
				startedAt: t.startedAt,
				finishedAt: t.finishedAt,
				error: t.error
			});
			this.tracker.leave();
		}
		const running = this.running;
		if (running && running.state !== "publishing") running.controller.abort();
		await this.tracker.close();
	}
};
/** Process-wide cap on concurrently spawned maintenance worker threads
* (stage 6's CPU-worker budget). A worker build acquires a slot before
* spawning and releases it when the worker exits; additional builds wait (or
* the caller falls back to the in-thread path). */
var WorkerSlots = class {
	total;
	available;
	waiters = [];
	constructor(total) {
		this.total = total;
		this.available = total;
	}
	/** Try to take a slot without waiting. */
	tryAcquire() {
		if (this.available <= 0) return null;
		this.available--;
		return () => this.release();
	}
	/** Wait for a slot (observing the optional abort signal). */
	async acquire(signal) {
		const immediate = this.tryAcquire();
		if (immediate) return immediate;
		if (signal?.aborted) throw new MaintenanceCancelledError("generation-build");
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				const i = this.waiters.indexOf(grant);
				if (i >= 0) this.waiters.splice(i, 1);
				reject(new MaintenanceCancelledError("generation-build"));
			};
			const grant = () => {
				signal?.removeEventListener("abort", onAbort);
				resolve(() => this.release());
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.waiters.push(grant);
		});
	}
	/** TUI-safe slot policy: queue for a slot up to `waitMs` (observing the
	*  optional abort signal) instead of dropping a large worker-eligible
	*  build onto the main thread the moment every slot is busy. Resolves null
	*  on timeout — the caller decides whether its bounded inline core is an
	*  acceptable last resort. Rejects MaintenanceCancelledError on abort. */
	async acquireBounded(waitMs, signal) {
		const immediate = this.tryAcquire();
		if (immediate) return immediate;
		if (signal?.aborted) throw new MaintenanceCancelledError("generation-build");
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				const i = this.waiters.indexOf(grant);
				if (i >= 0) this.waiters.splice(i, 1);
			};
			const timer = setTimeout(() => {
				cleanup();
				resolve(null);
			}, waitMs);
			timer.unref?.();
			const onAbort = () => {
				cleanup();
				reject(new MaintenanceCancelledError("generation-build"));
			};
			const grant = () => {
				cleanup();
				resolve(() => this.release());
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) {
				onAbort();
				return;
			}
			this.waiters.push(grant);
		});
	}
	release() {
		const next = this.waiters.shift();
		if (next) {
			next();
			return;
		}
		this.available++;
	}
};
/** The process-wide default worker slot pool: half the CPUs, at least one,
*  capped at two — one worker build already saturates a core for seconds,
*  and the main thread must stay responsive. */
const defaultWorkerSlots = new WorkerSlots(Math.max(1, Math.min(2, Math.floor(os.cpus().length / 2))));
/** Default budget of the TUI-safe slot queue (WorkerSlots.acquireBounded):
*  a worker-eligible text build waits this long for a slot before falling
*  back to the bounded inline core as the explicit last resort — large
*  full-text builds are never dropped onto the main thread UNCONDITIONALLY. */
const TEXT_BUILD_SLOT_WAIT_MS = 3e4;
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
function setPath(obj, path, value) {
	const tokens = tokenizePath(path);
	if (tokens.length === 0) return obj;
	let cur = obj;
	for (let i = 0; i < tokens.length - 1; i++) {
		const t = tokens[i];
		if (cur[t] === null || cur[t] === void 0 || typeof cur[t] !== "object") cur[t] = typeof tokens[i + 1] === "number" ? [] : {};
		cur = cur[t];
	}
	cur[tokens[tokens.length - 1]] = value;
	return obj;
}
/** Keep only the given paths (inclusion). Returns a new object. */
function project(doc, paths) {
	if (!paths || paths.length === 0) return doc;
	const out = {};
	for (const p of paths) {
		const v = getPath(doc, p);
		if (v !== void 0) setPath(out, p, v);
	}
	return out;
}
function matchCond(val, cond) {
	if (cond === null || typeof cond !== "object" || cond instanceof RegExp) {
		if (cond instanceof RegExp) {
			cond.lastIndex = 0;
			return typeof val === "string" && cond.test(val);
		}
		return val === cond;
	}
	for (const op of Object.keys(cond)) {
		const arg = cond[op];
		switch (op) {
			case "$eq":
				if (val !== arg) return false;
				break;
			case "$ne":
				if (val === arg) return false;
				break;
			case "$gt":
				if (!(val > arg)) return false;
				break;
			case "$gte":
				if (!(val >= arg)) return false;
				break;
			case "$lt":
				if (!(val < arg)) return false;
				break;
			case "$lte":
				if (!(val <= arg)) return false;
				break;
			case "$in":
				if (!Array.isArray(arg) || !arg.includes(val)) return false;
				break;
			case "$nin":
				if (!Array.isArray(arg) || arg.includes(val)) return false;
				break;
			case "$regex": {
				const re = arg instanceof RegExp ? arg : Array.isArray(arg) ? new RegExp(arg[0], arg[1]) : new RegExp(arg);
				if (typeof val !== "string") return false;
				re.lastIndex = 0;
				if (!re.test(val)) return false;
				break;
			}
			case "$exists":
				if (val !== void 0 !== !!arg) return false;
				break;
			case "$contains":
				if (!Array.isArray(val) || !val.includes(arg)) return false;
				break;
			case "$type":
				if (typeof val !== arg) return false;
				break;
			default: return false;
		}
	}
	return true;
}
/** Does `doc` satisfy the Mongo-like `filter`? */
function match(doc, filter) {
	if (!filter || Object.keys(filter).length === 0) return true;
	for (const key of Object.keys(filter)) {
		const cond = filter[key];
		if (key === "$and") {
			if (!Array.isArray(cond) || !cond.every((f) => match(doc, f))) return false;
		} else if (key === "$or") {
			if (!Array.isArray(cond) || !cond.some((f) => match(doc, f))) return false;
		} else if (key === "$nor") {
			if (!Array.isArray(cond) || cond.some((f) => match(doc, f))) return false;
		} else if (key === "$not") {
			if (match(doc, cond)) return false;
		} else if (!matchCond(getPath(doc, key), cond)) return false;
	}
	return true;
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
const MAX_TERM_BYTES = 65535;
const yieldToLoop = () => new Promise((r) => setImmediate(r));
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
// ../../packages/minidb/src/recovery.ts
function readAtSync$1(fd, off, len) {
	if (len === 0) return Buffer.alloc(0);
	const buf = Buffer.allocUnsafe(len);
	let got = 0;
	while (got < len) {
		const r = fs.readSync(fd, buf, got, len - got, off + got);
		if (r === 0) throw new Error("recovery: short read past EOF");
		got += r;
	}
	return buf;
}
/** Width of the fingerprint window (one small pread per catch-up). */
const WAL_TAIL_FINGERPRINT_BYTES = 4096;
/** Fingerprint the window ending at `end` through an ALREADY-VERIFIED fd
*  (the anchor's dev/ino were fstat-checked on it). Returns null when the
*  window cannot be read — nothing to fingerprint at offset 0, or the file is
*  shorter than the watermark claims (never a valid continuation). */
function readWalTailFd(fd, end) {
	const len = Math.min(WAL_TAIL_FINGERPRINT_BYTES, end);
	if (len <= 0) return null;
	const off = end - len;
	try {
		return {
			off,
			len,
			crc32: crc32(readAtSync$1(fd, off, len))
		};
	} catch {
		return null;
	}
}
/** Do two fingerprints describe the same bytes? null (unknown) never matches
*  a real fingerprint. */
function sameWalTail(a, b) {
	if (!a || !b) return false;
	return a.off === b.off && a.len === b.len && a.crc32 === b.crc32;
}
function parseMeta(meta) {
	if (!meta) return null;
	return JSON.parse(meta.toString("utf8")).dt ?? null;
}
function* setRefToOps(f, file, fd, valueMode) {
	if (f.expireAt && f.expireAt <= Date.now()) {
		yield {
			type: 2,
			key: f.key,
			ref: null,
			expireAt: 0,
			dt: null
		};
		return;
	}
	const dt = parseMeta(f.meta);
	const ref = valueMode === "disk" ? {
		kind: "disk",
		loc: {
			file,
			off: f.valueOff,
			len: f.valLen
		}
	} : {
		kind: "memory",
		value: readAtSync$1(fd, f.valueOff, f.valLen)
	};
	yield {
		type: 1,
		key: f.key,
		ref,
		expireAt: f.expireAt,
		dt
	};
}
/** Unroll one recovered frame into primitive ops. SET frames carry their value
*  ref (inline bytes in memory mode, a {file, off, len} pointer in disk mode);
*  expired-at-replay SETs become DELs (see setRefToOps). A BATCH frame yields
*  its sub-ops in order; a malformed body with a valid outer CRC skips the
*  whole batch rather than half-applying it (and is reported through
*  `onCorruptBatch` so recovery can account it). Unknown frame types yield nothing. */
function* frameToOps(f, file, fd, valueMode, onCorruptBatch) {
	if (f.type === 1) yield* setRefToOps(f, file, fd, valueMode);
	else if (f.type === 2) yield {
		type: 2,
		key: f.key,
		ref: null,
		expireAt: 0,
		dt: null
	};
	else if (f.type === 3) {
		let ops;
		try {
			ops = scanBatchOpRefs(readAtSync$1(fd, f.valueOff, f.valLen), f.valueOff);
		} catch {
			onCorruptBatch?.();
			return;
		}
		for (const op of ops) if (op.type === 1) yield* setRefToOps(op, file, fd, valueMode);
		else if (op.type === 2) yield {
			type: 2,
			key: op.key,
			ref: null,
			expireAt: 0,
			dt: null
		};
	}
}
/** Cooperative slicing for the recovered-op apply loops: reports true when
*  either budget (primitive ops, or wall-clock since the last yield) is
*  exhausted and the loop should yieldToLoop(). Yielding mid-apply is safe on
*  both consumers: at open the store is not published until open() returns,
*  so nothing observes a half-applied pass; during replica catch-up
*  (catchUpWalAsync) concurrent readers can observe intermediate apply
*  states, which the replica's eventual-consistency contract permits (the
*  caller's watermark only advances once the whole delta has applied). */
function walApplySlicer() {
	let ops = 0;
	let sliceStart = performance.now();
	return () => {
		if (++ops < 512 && performance.now() - sliceStart < 8) return false;
		ops = 0;
		sliceStart = performance.now();
		return true;
	};
}
/** Apply recovered frames to the store. This is pure in-memory bookkeeping —
*  one synchronous pass per file would be a noticeable event-loop stall on a
*  large db (the open-time freeze used to be dominated by the index rebuild
*  AFTER this pass, but the pass itself is not free either), so it yields
*  periodically. Safe: the store is not published until open() returns, so
*  nothing can observe a half-applied pass. */
async function applyFrames(frames, file, fd, store, valueMode, onCorruptBatch) {
	const slice = walApplySlicer();
	for (const f of frames) for (const op of frameToOps(f, file, fd, valueMode, onCorruptBatch)) {
		if (op.type === 1) store.setRef(op.key, op.ref, op.expireAt, op.dt);
		else if (op.type === 2) store.del(op.key);
		if (slice()) await yieldToLoop();
	}
}
/** Thrown when recovery kept detecting snapshot/WAL generation switches
*  across every bounded retry — the writer is rotating files faster than a
*  consistent pair can be scanned. Callers with a refresh loop (kap-server's
*  readonly degrade path, the cluster shard reader) treat it as transient. */
var RecoveryGenerationChurnError = class extends Error {
	attempts;
	code = "RECOVERY_GENERATION_CHURN";
	constructor(attempts) {
		super(`recovery: snapshot/WAL generation kept changing across ${attempts} attempt(s)`);
		this.attempts = attempts;
		this.name = "RecoveryGenerationChurnError";
	}
};
const GENERATION_RETRY_BASE_MS = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function statIdentity(p) {
	try {
		const st = fs.statSync(p);
		return {
			dev: st.dev,
			ino: st.ino,
			size: st.size
		};
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}
/** The pairing rule (see the file header): the file a pass scanned must still
*  be the file at its path after the pass's last read — same dev+ino, and a
*  size that never dropped below `sizeFloor` (append-only growth on the same
*  inode is safe: the extra bytes are a staleness window catch-up covers).
*  A null↔non-null transition (the file appeared or vanished mid-pass) cannot
*  be verified and is treated as a generation switch. */
function sameGeneration(scanned, after, sizeFloor) {
	if (scanned === null || after === null) return scanned === null && after === null;
	if (scanned.dev !== after.dev || scanned.ino !== after.ino) return false;
	return after.size >= sizeFloor;
}
/** Discard every record a churned pass applied, restoring the (always
*  initially empty) Store for the next pass. del() keeps the bytes/expiry
*  accounting consistent; stale TTL-heap entries are reaped lazily by their
*  seq guard. (Map iteration survives deletion mid-iteration.) */
function resetStore(store) {
	for (const k of store.map.keys()) store.del(k);
}
async function recover({ dir, store, mode = "resync", truncate = true, valueMode = "memory", maxGenerationRetries = 4, attachValueReader, signal, timings }) {
	const snapPath = path.join(dir, SNAPSHOT_FILE);
	const walPath = path.join(dir, WAL_FILE);
	let delay = GENERATION_RETRY_BASE_MS;
	for (let attempt = 0;; attempt++) {
		let pass;
		try {
			pass = await recoverPass({
				snapPath,
				walPath,
				store,
				mode,
				truncate,
				valueMode,
				signal,
				timings
			});
		} catch (error) {
			if (error.name === "AbortError") resetStore(store);
			throw error;
		}
		if (pass.consistent && (!attachValueReader || attachValueReader(pass.anchors))) {
			pass.info.generationRetries = attempt;
			if (pass.walTail) pass.info.walScanTail = pass.walTail;
			return pass.info;
		}
		resetStore(store);
		if (attempt >= maxGenerationRetries) throw new RecoveryGenerationChurnError(attempt + 1);
		await sleep(delay);
		delay *= 2;
	}
}
/** One recovery pass: scan + apply the snapshot then the WAL, recording the
*  identity of each opened fd BEFORE scanning it (forensics round 1), then
*  re-stat both paths AFTER the last read (round 2) and apply the pairing
*  rule. Returns the recovered state plus the scanned inode anchors when the
*  pass is generation-consistent; the caller retries otherwise. */
async function recoverPass({ snapPath, walPath, store, mode, truncate, valueMode, signal, timings }) {
	let corruptBatches = 0;
	const countCorruptBatch = () => {
		corruptBatches++;
	};
	let snapshotFrames = 0;
	let snapshotBytes = 0;
	let snapshotCorrupt = [];
	let snapScanned = null;
	if (fs.existsSync(snapPath)) {
		const fd = fs.openSync(snapPath, "r");
		try {
			const st = fs.fstatSync(fd);
			snapScanned = {
				dev: st.dev,
				ino: st.ino,
				size: st.size
			};
			snapshotBytes = st.size;
			const snapScanT0 = performance.now();
			const r = await scanFrameRefsFdAsync(fd, {
				onCorrupt: mode,
				signal
			});
			if (timings) timings.walScanMs += performance.now() - snapScanT0;
			const snapApplyT0 = performance.now();
			await applyFrames(r.frames, "snapshot", fd, store, valueMode, countCorruptBatch);
			if (timings) timings.walApplyMs += performance.now() - snapApplyT0;
			snapshotFrames = r.frames.length;
			snapshotCorrupt = r.corruptRanges;
		} finally {
			fs.closeSync(fd);
		}
	}
	let walFrames = 0;
	let walBytes = 0;
	let walCorrupt = [];
	let truncatedWal = false;
	let walScanEnd = 0;
	let walTail = null;
	let walScanned = null;
	let walSizeFloor = 0;
	if (fs.existsSync(walPath)) {
		const fd = fs.openSync(walPath, "r");
		try {
			const st = fs.fstatSync(fd);
			walScanned = {
				dev: st.dev,
				ino: st.ino,
				size: st.size
			};
			walSizeFloor = st.size;
			walBytes = st.size;
			const walScanT0 = performance.now();
			const r = await scanFrameRefsFdAsync(fd, {
				onCorrupt: mode,
				signal
			});
			if (timings) timings.walScanMs += performance.now() - walScanT0;
			const walApplyT0 = performance.now();
			await applyFrames(r.frames, "wal", fd, store, valueMode, countCorruptBatch);
			if (timings) timings.walApplyMs += performance.now() - walApplyT0;
			walFrames = r.frames.length;
			walCorrupt = r.corruptRanges;
			walScanEnd = r.eofOffset;
			walTail = readWalTailFd(fd, walScanEnd);
			const last = r.corruptRanges[r.corruptRanges.length - 1];
			if (last && last[1] === st.size) {
				if (truncate) {
					await fs$1.truncate(walPath, last[0]);
					truncatedWal = true;
					walSizeFloor = last[0];
				}
			}
		} finally {
			fs.closeSync(fd);
		}
	}
	const snapAfter = statIdentity(snapPath);
	const walAfter = statIdentity(walPath);
	if (!sameGeneration(snapScanned, snapAfter, snapScanned?.size ?? 0)) return { consistent: false };
	if (!sameGeneration(walScanned, walAfter, walSizeFloor)) return { consistent: false };
	return {
		consistent: true,
		info: {
			snapshotFrames,
			walFrames,
			snapshotBytes,
			walBytes,
			truncatedWal,
			corruptRanges: walCorrupt,
			snapshotCorruptRanges: snapshotCorrupt,
			lostBytes: [...walCorrupt, ...snapshotCorrupt].reduce((a, [s, e]) => a + (e - s), 0),
			walScanEnd,
			walDev: walScanned?.dev ?? 0,
			walIno: walScanned?.ino ?? 0,
			snapshotDev: snapScanned?.dev ?? 0,
			snapshotIno: snapScanned?.ino ?? 0,
			corruptBatches,
			generationRetries: 0
		},
		anchors: {
			snapshot: snapScanned ? {
				dev: snapScanned.dev,
				ino: snapScanned.ino
			} : null,
			wal: walScanned ? {
				dev: walScanned.dev,
				ino: walScanned.ino
			} : null
		},
		walTail
	};
}
/** Continue a replica from a WAL watermark: strictly scan frames in
*  [offset, EOF) of `walPath` and hand each to `apply(f, fd, slice)` in order.
*
*  Returns the new continuation offset (end of the last fully-valid frame)
*  and how many frames were applied. An invalid/partial frame anywhere stops
*  the scan WITHOUT error (a writer mid-writev leaves such a tail; everything
*  applied before it stands and the next call re-validates from the stopped
*  offset — its CRC passes once the writev lands). Returns null when `offset`
*  cannot be a clean frame-boundary continuation (negative, beyond EOF,
*  pointing at bytes that start no frame, the file is not the `anchor`
*  inode — rotation swapped it in the microseconds between the caller's stat
*  and this open — or the bytes below the watermark no longer match
*  `anchor.tail`: `MiniDb.recoverWalInPlace` truncated the WAL in place and
*  new frames were written back below this offset, so continuing here would
*  describe a history this replica never applied). The caller must fully
*  reopen.
*
*  A successful result additionally reports the fingerprint of the window
*  below the returned offset, so the caller can anchor its next call on the
*  content it just applied instead of on identity alone.
*
*  Cooperative (stage 5 follow-up of the open-path slicing): the frame scan
*  runs through the windowed async scanner and the apply loop yields between
*  primitive ops on the shared walApplySlicer budgets, so a replica that fell
*  far behind no longer blocks the host loop in one synchronous scan+apply.
*  `apply` receives the slicer and MUST await-yield when it fires — a BATCH
*  frame unrolls into thousands of primitive ops, so frame-granular yielding
*  could never bound a slice. Yielding mid-catch-up lets concurrent readers
*  observe intermediate apply states; that is the documented replica contract
*  (a replica is eventually consistent — the caller's watermark only advances
*  once the whole delta has applied). */
async function catchUpWalAsync(walPath, offset, anchor, apply) {
	let fd;
	try {
		fd = fs.openSync(walPath, "r");
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
	try {
		const st = fs.fstatSync(fd);
		if (st.dev !== anchor.dev || st.ino !== anchor.ino) return null;
		const size = st.size;
		if (offset < 0 || offset > size) return null;
		const tail = readWalTailFd(fd, offset);
		if (anchor.tail && (!tail || !sameWalTail(anchor.tail, tail))) return null;
		const r = await scanFrameRefsFdAsync(fd, {
			onCorrupt: "strict",
			startOffset: offset
		});
		if (r.frames.length === 0 && r.eofOffset < size) {
			const n = Math.min(MAGIC.length, size - offset);
			const head = readAtSync$1(fd, offset, n);
			if (!MAGIC.subarray(0, n).equals(head)) return null;
			return {
				offset,
				appliedFrames: 0,
				tail
			};
		}
		const slice = walApplySlicer();
		for (const f of r.frames) await apply(f, fd, slice);
		return {
			offset: r.eofOffset,
			appliedFrames: r.frames.length,
			tail: readWalTailFd(fd, r.eofOffset)
		};
	} finally {
		fs.closeSync(fd);
	}
}
// ../../packages/minidb/src/serialize.ts
/** Create a serializing executor: functions submitted to it run strictly one
*  at a time, in submission order. The executor itself never rejects; each
*  call settles with its own function's result or error. */
function createSerializer() {
	let chain = Promise.resolve();
	return async function serialized(fn) {
		const prev = chain;
		let done;
		chain = new Promise((resolve) => {
			done = resolve;
		});
		await prev;
		try {
			return await fn();
		} finally {
			done();
		}
	};
}
// ../../packages/minidb/src/value-reader.ts
/** Promise wrapper over fs.read (the callback API runs on the libuv thread
*  pool for a plain fd; fs.promises has no fd-level read). Shared with the
*  postings file's async read. */
function readAtAsync(fd, buf, bufOff, len, pos) {
	return new Promise((resolve, reject) => {
		fs.read(fd, buf, bufOff, len, pos, (err, bytesRead) => err ? reject(err) : resolve(bytesRead));
	});
}
var ValueReader = class {
	snapshotPath;
	walPath;
	snapshotFd = null;
	walFd = null;
	constructor(dir) {
		this.snapshotPath = path.join(dir, "db.snapshot");
		this.walPath = path.join(dir, "db.wal");
	}
	/** Open both files (null-safe per side) and return the dev/ino identity of
	*  each attached handle (null = the file does not exist). Recovery's
	*  generation pairing compares these against the inodes it scanned, so a
	*  rotation landing between the scan and this attach is detected instead of
	*  serving old offsets from a new file. */
	open() {
		this.snapshotFd = this.openIfExists(this.snapshotPath);
		this.walFd = this.openIfExists(this.walPath);
		return {
			snapshot: this.ident(this.snapshotFd),
			wal: this.ident(this.walFd)
		};
	}
	ident(fd) {
		if (fd === null) return null;
		const st = fs.fstatSync(fd);
		return {
			dev: st.dev,
			ino: st.ino
		};
	}
	openIfExists(file) {
		try {
			return fs.openSync(file, "r");
		} catch (error) {
			if (error.code === "ENOENT") return null;
			throw error;
		}
	}
	fdFor(loc) {
		const fd = loc.file === "snapshot" ? this.snapshotFd : this.walFd;
		if (fd === null) throw new Error(`value reader: ${loc.file} file is not open`);
		return fd;
	}
	read(loc) {
		if (loc.len === 0) return Buffer.alloc(0);
		const fd = this.fdFor(loc);
		const buf = Buffer.allocUnsafe(loc.len);
		let got = 0;
		while (got < loc.len) {
			const r = fs.readSync(fd, buf, got, loc.len - got, loc.off + got);
			if (r === 0) throw new Error(`value reader: short read from ${loc.file} at ${loc.off + got}`);
			got += r;
		}
		return buf;
	}
	/** Async positioned read (stage 6): identical semantics to read(), served
	*  off the libuv thread pool so a disk-mode miss does not stall the event
	*  loop. Purely additive — the synchronous read path is unchanged. */
	async readAsync(loc) {
		if (loc.len === 0) return Buffer.alloc(0);
		const fd = this.fdFor(loc);
		const buf = Buffer.allocUnsafe(loc.len);
		let got = 0;
		while (got < loc.len) {
			const r = await readAtAsync(fd, buf, got, loc.len - got, loc.off + got);
			if (r === 0) throw new Error(`value reader: short read from ${loc.file} at ${loc.off + got}`);
			got += r;
		}
		return buf;
	}
	reopenSnapshot() {
		if (this.snapshotFd !== null) {
			fs.closeSync(this.snapshotFd);
			this.snapshotFd = null;
		}
		this.snapshotFd = this.openIfExists(this.snapshotPath);
	}
	reopenWal() {
		if (this.walFd !== null) {
			fs.closeSync(this.walFd);
			this.walFd = null;
		}
		this.walFd = this.openIfExists(this.walPath);
	}
	reopenBoth() {
		this.reopenSnapshot();
		this.reopenWal();
	}
	close() {
		if (this.snapshotFd !== null) {
			fs.closeSync(this.snapshotFd);
			this.snapshotFd = null;
		}
		if (this.walFd !== null) {
			fs.closeSync(this.walFd);
			this.walFd = null;
		}
	}
};
// ../../packages/minidb/src/text-postings.ts
const HEADER_LEN = 10;
const CRC_LEN = 4;
const FLUSH_BYTES$1 = 1 << 20;
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
/** Reclaim `<file>.<pid36><ts36>` siblings: files the retired EPERM fallback
*  rename left behind, one per failed replace. Nothing reads them — the
*  generation manifest and every loader key on the fixed name — so without
*  this sweep they accumulate for the lifetime of the directory. Best-effort,
*  scoped to this file's exact stem, and restricted to the 9–16 alnum chars a
*  pid36+ts36 pair can be (which also keeps `.tmp` and `.rebuild` out). */
async function sweepRenamedAside(filePath) {
	const dir = path.dirname(filePath);
	const escaped = path.basename(filePath).replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const renamedAside = new RegExp(`^${escaped}\\.[0-9a-z]{9,16}$`);
	let names;
	try {
		names = await fs$1.readdir(dir);
	} catch {
		return;
	}
	await Promise.all(names.filter((n) => renamedAside.test(n)).map((n) => fs$1.rm(path.join(dir, n), { force: true }).catch(() => {})));
}
/**
* Append-only postings file with synchronous positioned reads. Synchronous I/O
* is deliberate: `TextIndex.search()` is synchronous (so `db.search()` /
* `db.query()` keep their sync API), and hot records are served from the OS
* page cache or the in-memory LRU cache anyway. Rewrites ({@link rebuild}) are
* the async counterpart — they run in the background of a live database.
*/
var PostingsFile = class PostingsFile {
	fd = null;
	/** The path this handle reads. Mutable for exactly one caller: stage 5's
	*  generation builder repoints a freshly committed base from the build's
	*  tmp directory to the published generation directory after the atomic
	*  rename (same file, new name — POSIX keeps the fd valid throughout). */
	path;
	constructor(filePath) {
		this.path = filePath;
	}
	/**
	* Open an existing postings file for positioned reads. Throws if the file is
	* missing — callers treat a missing file as an empty index. Read-only: the
	* file is only ever rewritten wholesale by {@link rebuild}, so the fd
	* stays valid until the next rebuild (which the caller must close + reopen).
	*/
	static open(filePath) {
		const pf = new PostingsFile(filePath);
		pf.fd = fs.openSync(filePath, "r");
		return pf;
	}
	get open() {
		return this.fd !== null;
	}
	/** Read + decode one term's postings record by dictionary pointer. With
	*  `maxEntries`, only the leading (lowest-docID) part of the list is
	*  decoded — see decodePostingList. */
	read(entry, maxEntries) {
		if (this.fd === null) throw new Error("postings file is closed");
		const buf = Buffer.alloc(entry.len);
		let got = 0;
		while (got < entry.len) {
			const r = fs.readSync(this.fd, buf, got, entry.len - got, entry.off + got);
			if (r === 0) throw new Error("postings: short read past EOF");
			got += r;
		}
		return decodePostingList(decodeRecord(buf).payload, maxEntries);
	}
	/** Async twin of read() (stage 6): the positioned read runs on the libuv
	*  thread pool, so a cold postings lookup no longer blocks the event loop
	*  on readSync. Purely additive — the synchronous read path is unchanged. */
	async readAsync(entry, maxEntries) {
		if (this.fd === null) throw new Error("postings file is closed");
		const buf = Buffer.alloc(entry.len);
		let got = 0;
		while (got < entry.len) {
			const r = await readAtAsync(this.fd, buf, got, entry.len - got, entry.off + got);
			if (r === 0) throw new Error("postings: short read past EOF");
			got += r;
		}
		return decodePostingList(decodeRecord(buf).payload, maxEntries);
	}
	close() {
		if (this.fd !== null) {
			fs.closeSync(this.fd);
			this.fd = null;
		}
	}
	/**
	* Build a fresh postings file from an iterator of `{ term, entries }`
	* (entries must be sorted by docID asc). Writes to `<path>.tmp`, fsyncs, and
	* atomically renames over `<path>`. Returns the new term dictionary plus the
	* file's byte length and whole-file crc32 (stage 5's generation manifest
	* records them; the crc streams along with the write batches, so it costs no
	* extra read). The old file (if any) is replaced only after the new one is
	* fully durable, so a crash mid-build leaves the previous file intact.
	*
	* The final name is ALWAYS `filePath`: a replace that the Windows retry
	* window could not land PROPAGATES (the caller keeps its previous base and
	* the next build retries) instead of being renamed aside. The generation
	* manifest records this file by its fixed name and the loader verifies
	* exactly that path, so any other name is a guaranteed ENOENT that discards
	* the whole generation.
	*
	* Async so a large rebuild does not starve the event loop: record writes are
	* coalesced into ~1 MiB writev batches (each batch await is a yield point).
	* The commit section is SYNCHRONOUS — `hooks.beforeRename` (e.g. closing the
	* previous read handle, required on Windows) and the rename itself run as
	* one atomic step, so a reader swaps over without an interleavable gap.
	*/
	static async rebuild(filePath, iter, hooks = {}) {
		const tmp = filePath + ".tmp";
		const dict = /* @__PURE__ */ new Map();
		let off = 0;
		let crc = 0;
		let batch = [];
		let batchBytes = 0;
		const fh = await fs$1.open(tmp, "w");
		const flushBatch = async () => {
			if (batch.length === 0) return;
			const buf = Buffer.concat(batch);
			batch = [];
			batchBytes = 0;
			crc = crc32(buf, crc);
			let written = 0;
			while (written < buf.length) {
				const { bytesWritten } = await fh.write(buf, written);
				if (bytesWritten === 0) throw new Error("postings: rebuild write made no progress");
				written += bytesWritten;
			}
		};
		try {
			for (const { term, entries } of iter) {
				const count = Array.isArray(entries) ? entries.length : entries.size;
				if (count === 0) continue;
				const rec = encodeRecord(term, count, encodePostingList(entries));
				dict.set(term, {
					off,
					len: rec.length,
					df: count
				});
				batch.push(rec);
				batchBytes += rec.length;
				off += rec.length;
				if (batchBytes >= FLUSH_BYTES$1) await flushBatch();
			}
			await flushBatch();
			await fh.sync();
		} finally {
			await fh.close();
		}
		hooks.beforeRename?.();
		await (hooks.rename ?? renameReplace)(tmp, filePath);
		try {
			const dfd = fs.openSync(path.dirname(filePath), "r");
			try {
				fs.fsyncSync(dfd);
			} finally {
				fs.closeSync(dfd);
			}
		} catch {}
		await sweepRenamedAside(filePath);
		return {
			dict,
			bytes: off,
			crc32: crc >>> 0
		};
	}
};
// ../../packages/minidb/src/text-index/builder.ts
const BUILD_YIELD_DOCS = 512;
const BUILD_YIELD_TOKENS = 5e5;
/** Staged text-index rebuild (see TextIndex.beginBuild): feed docs with
*  add(), swap everything in with commit(), or discard with abort(). */
var StagedBuild = class {
	hooks;
	agg = /* @__PURE__ */ new Map();
	newKeys = [];
	newKeyToId = /* @__PURE__ */ new Map();
	newDocLen = /* @__PURE__ */ new Map();
	n = 0;
	done = false;
	constructor(hooks) {
		this.hooks = hooks;
	}
	add(key, value) {
		if (this.done) throw new Error("text index build already finished");
		const tokens = this.hooks.tokensFor(value);
		const docID = this.newKeys.length;
		this.newKeys.push(key);
		this.newKeyToId.set(key, docID);
		const counts = /* @__PURE__ */ new Map();
		for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
		for (const [t, c] of counts) {
			let m = this.agg.get(t);
			if (!m) this.agg.set(t, m = /* @__PURE__ */ new Map());
			m.set(docID, c);
		}
		this.newDocLen.set(docID, tokens.length);
		this.n++;
		return tokens.length;
	}
	async commit() {
		if (this.done) throw new Error("text index build already finished");
		this.done = true;
		try {
			await this.hooks.commit({
				agg: this.agg,
				keys: this.newKeys,
				keyToId: this.newKeyToId,
				docLens: this.newDocLen,
				n: this.n
			});
		} catch (error) {
			this.hooks.disarm();
			throw error;
		}
	}
	abort() {
		if (this.done) return;
		this.done = true;
		this.hooks.disarm();
	}
};
/** The build() feeding loop: push every entry through the staged build,
*  yielding to the event loop at the watermarks above so a large rebuild
*  never hard-blocks the host process, then commit (abort on failure). */
async function feedBuild(b, entries) {
	let docsSinceYield = 0;
	let tokensSinceYield = 0;
	try {
		for (const { key, value } of entries) {
			tokensSinceYield += b.add(key, value);
			docsSinceYield++;
			if (docsSinceYield >= BUILD_YIELD_DOCS || tokensSinceYield >= BUILD_YIELD_TOKENS) {
				docsSinceYield = 0;
				tokensSinceYield = 0;
				await yieldToLoop();
			}
		}
	} catch (error) {
		b.abort();
		throw error;
	}
	await b.commit();
}
// ../../packages/minidb/src/text-index/image.ts
/** Stage-5 generation build: a synchronous deep-enough snapshot of the live
*  state for image serialization. The maps/arrays are copied so later
*  mutations of the live index never reach the serialized image. Must run
*  while no build is in flight (a committed build's state is what a
*  generation serializes). */
function exportImageState(s) {
	return {
		dict: new Map(s.postings),
		keys: [...s.keys],
		docLens: new Map(s.docLen),
		liveCount: s.N,
		removed: new Set(s.removed),
		delta: new Map([...s.delta].map(([t, m]) => [t, new Map(m)]))
	};
}
/** Sliced variant of exportImageState (stage 6): identical content, copied
*  in slices with event-loop yields so a large index's image copy never
*  stalls the loop for the whole pass. Consistency across slices is
*  preserved by ORDER: the doc table (keys) is copied LAST — a write that
*  lands mid-copy appends its docID to keys BEFORE touching delta/docLens
*  (see addPrepared), so every docID referenced by the earlier-copied
*  delta/removed exists in the keys array (a superset is fine; holes are
*  impossible before the copy point). The generation load's WAL-delta
*  replay reconciles any mid-copy write exactly as it reconciles any
*  post-seal write. */
async function exportImageStateAsync(s, opts = {}) {
	const sliceEvery = opts.sliceEvery ?? 65536;
	let n = 0;
	const tick = async () => {
		if (++n % sliceEvery === 0) await yieldToLoop();
	};
	const dict = /* @__PURE__ */ new Map();
	for (const [t, e] of s.postings) {
		dict.set(t, e);
		await tick();
	}
	const delta = /* @__PURE__ */ new Map();
	for (const [t, m] of s.delta) {
		delta.set(t, new Map(m));
		await tick();
	}
	const removed = /* @__PURE__ */ new Set();
	for (const id of s.removed) {
		removed.add(id);
		await tick();
	}
	const docLens = /* @__PURE__ */ new Map();
	for (const [id, len] of s.docLen) {
		docLens.set(id, len);
		await tick();
	}
	return {
		dict,
		keys: [...s.keys],
		docLens,
		liveCount: s.N,
		removed,
		delta
	};
}
/** Stage-5 generation load: attach a persisted base + write-buffer state,
*  making the index exactly equal to the one the generation sealed —
*  dictionary, doc table, tombstones and delta included. Any previous state
*  is replaced; a memory-base instance switches to disk-base on the
*  generation's postings file (read-only opens attach the same way — the
*  file is only ever read). */
function attachImage(s, args) {
	s.close();
	s.memBase = null;
	s.postings.clear();
	for (const [t, e] of args.dict) s.postings.set(t, e);
	s.pf = PostingsFile.open(args.postingsPath);
	s.docLen.clear();
	for (const [id, len] of args.docLens) s.docLen.set(id, len);
	s.keys.length = 0;
	for (const k of args.keys) s.keys.push(k);
	s.keyToId.clear();
	for (let i = 0; i < s.keys.length; i++) {
		const k = s.keys[i];
		if (k !== void 0) s.keyToId.set(k, i);
	}
	s.delta.clear();
	s.deltaDocs.clear();
	s.deltaCount = 0;
	for (const [t, m] of args.delta) {
		s.delta.set(t, m);
		for (const [id] of m) {
			s.deltaCount++;
			let set = s.deltaDocs.get(id);
			if (!set) s.deltaDocs.set(id, set = /* @__PURE__ */ new Set());
			set.add(t);
		}
	}
	s.removed.clear();
	for (const id of args.removed) s.removed.add(id);
	s.clearCache();
	s.N = args.liveCount;
	s.basePending = false;
	s.baseEpoch++;
}
/** Sliced variant of attachImage (the open-time main-thread path): identical
*  resulting state and the same side-effect order, but every O(terms/docs)
*  map construction happens here, in slices with event-loop yields, so
*  attaching a large generation's base never stalls the loop for the whole
*  pass. Safe to yield mid-attach: the index is not serving until open()
*  returns, and the readonly-bound containers (delta, deltaDocs, removed —
*  their bindings are stable by class invariant) are cleared-then-refilled
*  in place exactly like the sync attach, only with yields interleaved. */
async function attachImageAsync(s, args, opts = {}) {
	const sliceEvery = opts.sliceEvery ?? 32768;
	let n = 0;
	const tick = async () => {
		if (++n % sliceEvery === 0) await yieldToLoop();
	};
	s.close();
	s.memBase = null;
	const postings = /* @__PURE__ */ new Map();
	for (const e of args.dictEntries) {
		postings.set(e.term, {
			off: e.off,
			len: e.len,
			df: e.df
		});
		await tick();
	}
	s.postings = postings;
	s.pf = PostingsFile.open(args.postingsPath);
	const keys = args.docs.keys;
	const docLen = /* @__PURE__ */ new Map();
	for (let i = 0; i < keys.length; i++) {
		const len = args.docs.docLens[i];
		if (len !== void 0) docLen.set(i, len);
		await tick();
	}
	const keyToId = /* @__PURE__ */ new Map();
	for (let i = 0; i < keys.length; i++) {
		const k = keys[i];
		if (k !== void 0) keyToId.set(k, i);
		await tick();
	}
	s.docLen = docLen;
	s.keys = keys;
	s.keyToId = keyToId;
	s.delta.clear();
	s.deltaDocs.clear();
	s.deltaCount = 0;
	for (const d of args.docs.delta) {
		const m = /* @__PURE__ */ new Map();
		s.delta.set(d.term, m);
		for (const doc of d.docs) {
			m.set(doc.docID, doc.freq);
			s.deltaCount++;
			let set = s.deltaDocs.get(doc.docID);
			if (!set) s.deltaDocs.set(doc.docID, set = /* @__PURE__ */ new Set());
			set.add(d.term);
			await tick();
		}
	}
	s.removed.clear();
	for (const id of args.docs.removed) {
		s.removed.add(id);
		await tick();
	}
	s.clearCache();
	s.N = args.docs.liveCount;
	s.basePending = false;
	s.baseEpoch++;
}
/** Stage-5 generation build: after the atomic publish rename, repoint the
*  live base handle from the build's tmp directory to the published
*  generation directory (same file, final name). On Windows an open handle
*  would have blocked the directory rename, so the caller closes before the
*  rename and reopens here; POSIX just updates the path (the fd stays valid
*  across the rename). Returns false when the reopen failed — the caller
*  keeps the index's `basePending` flag set so searches raise
*  TextIndexBuildingError instead of silently reading an empty base. */
function repointPostings(s, newPath) {
	if (process.platform === "win32") {
		if (s.pf) s.pf.close();
		s.pf = null;
		try {
			s.pf = PostingsFile.open(newPath);
			return true;
		} catch {
			return false;
		}
	}
	if (!s.pf) return false;
	s.pf.path = newPath;
	return true;
}
// ../../packages/minidb/src/text-index/types.ts
const EMPTY_MAP = /* @__PURE__ */ new Map();
/** Bounded collector for the K best hits by (score desc, key asc). The heap
*  root holds the WORST kept hit, so a new candidate enters only when it beats
*  that root — O(log K) per candidate and K kept in memory, instead of an
*  O(C log C) full sort over every candidate. The key tie-break keeps the
*  order of equal-score hits stable across paginated queries. */
var TopK = class TopK {
	k;
	a = [];
	constructor(k) {
		this.k = k;
	}
	/** x ranks strictly after y (smaller score, or equal score with larger key). */
	static worse(x, y) {
		return x.score < y.score || x.score === y.score && x.key > y.key;
	}
	offer(hit) {
		const a = this.a;
		if (a.length < this.k) {
			a.push(hit);
			let i = a.length - 1;
			while (i > 0) {
				const p = i - 1 >> 1;
				if (!TopK.worse(a[i], a[p])) break;
				[a[p], a[i]] = [a[i], a[p]];
				i = p;
			}
			return;
		}
		if (this.k === 0 || !TopK.worse(a[0], hit)) return;
		a[0] = hit;
		let i = 0;
		for (;;) {
			let w = i;
			const l = 2 * i + 1;
			const r = l + 1;
			if (l < a.length && TopK.worse(a[l], a[w])) w = l;
			if (r < a.length && TopK.worse(a[r], a[w])) w = r;
			if (w === i) break;
			[a[w], a[i]] = [a[i], a[w]];
			i = w;
		}
	}
	/** The kept hits in final rank order: score descending, key ascending. */
	sorted() {
		return this.a.sort((x, y) => y.score - x.score || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
	}
};
// ../../packages/minidb/src/text-index/index.ts
/**
* Raised by text searches while the index's base is (re)building. The
* no-generation fallback open path defers the corpus-scale base build to a
* background bounded build pinned at the recovery checkpoint; until it
* commits — or after a build that finally failed (`basePending`) — serving
* the delta alone would silently return partial results, so searches raise
* this instead. Callers should surface a "building" state and retry once the
* build commits.
*/
var TextIndexBuildingError = class extends Error {
	indexName;
	code = "TEXT_INDEX_BUILDING";
	constructor(indexName) {
		super(`text index${indexName ? ` "${indexName}"` : ""} base is still building`);
		this.indexName = indexName;
		this.name = "TextIndexBuildingError";
	}
};
var TextIndex = class TextIndex {
	fields;
	indexName;
	tokenizer;
	queryTokenizer;
	/** True when a custom (injected) index tokenizer is in use: its output is
	*  untrusted and gets the per-term length validation in tokensFor. The
	*  built-in tokenizer enforces the limit itself and skips the check. A
	*  built-in NAMED tokenizer injected as functions (the registry's ngram
	*  pair, marked via TextIndexOptions.builtinTokenizer) is not custom. */
	customTokenizer;
	/** The rebuild target of a NON-override build (null for a memory base).
	*  Immutable: a build with a `postingsPath` override writes into a caller
	*  directory that is renamed away afterwards, so adopting that path here
	*  would point every later plain rebuild at a vanished file. */
	path;
	cacheTerms;
	cacheBytesCap;
	postings = /* @__PURE__ */ new Map();
	docLen = /* @__PURE__ */ new Map();
	keys = [];
	keyToId = /* @__PURE__ */ new Map();
	delta = /* @__PURE__ */ new Map();
	deltaCount = 0;
	removed = /* @__PURE__ */ new Set();
	deltaDocs = /* @__PURE__ */ new Map();
	/**
	* Ops that landed while a `build()` was in flight. The ops ALSO apply to
	* the live view as usual (searches stay correct during the build); the
	* queue exists so the freshly-staged base can replay them at swap time —
	* the staged iteration may have missed them (already-visited key) or seen
	* them (unvisited key), so replaying the exact op stream onto the new base
	* is what keeps the rebuild precise instead of eventually consistent.
	* Null outside a build.
	*/
	buildQueue = null;
	memBase = null;
	pf = null;
	/** Set while the base is known-unavailable because its build was DEFERRED
	*  (from the deferred open-time build's arm until a base commits) or
	*  finally failed: searches raise TextIndexBuildingError rather than
	*  silently serving the delta alone. Cleared by every successful base
	*  commit/attach (swapDocStateAndReplay, attachImage). */
	basePending = false;
	/** Base-swap epoch, bumped by every base commit (swapDocStateAndReplay)
	*  and generation attach (attachImage). Async base reads stamp it and
	*  re-read from the fresh base when a commit lands mid-read, so a
	*  concurrently swapped base can never leak a stale base's postings — a
	*  different docID namespace — into a query or into the decoded-postings
	*  cache. */
	baseEpoch = 0;
	/** Integrity record of the postings file the last successful commitBuild
	*  wrote (bytes + whole-file crc32). Stage 5's generation builder records
	*  it in the manifest for the generation's copy of the file; the loader
	*  restores it on attach, so a CLEAN index's fast path can re-publish the
	*  unchanged file without re-reading it. */
	postingsFileInfo = null;
	/** The path of the postings file the current base is read from (null for a
	*  memory base). Stage 5's clean-index fast path hard-links THIS file into
	*  the next generation instead of re-tokenizing the corpus. */
	get currentPostingsPath() {
		return this.pf?.path ?? null;
	}
	cache = /* @__PURE__ */ new Map();
	cacheBytes = 0;
	/** Number of live indexed documents. */
	N = 0;
	constructor(opts = {}) {
		this.fields = opts.fields ?? null;
		this.indexName = opts.name;
		this.tokenizer = opts.tokenizer ?? tokenize;
		this.customTokenizer = opts.tokenizer !== void 0 && opts.builtinTokenizer === void 0;
		this.queryTokenizer = opts.queryTokenizer ?? this.tokenizer;
		this.path = opts.postingsPath ?? null;
		this.cacheTerms = opts.cacheTerms ?? 1024;
		this.cacheBytesCap = opts.cacheBytes ?? 67108864;
		if (!this.path) this.memBase = /* @__PURE__ */ new Map();
	}
	/** Approximate byte weight of a cached decoded list (entry pairs plus the
	*  term and array overhead) — the cache's eviction currency. */
	static cacheEntryBytes(term, arr) {
		return 64 + Buffer.byteLength(term, "utf8") + arr.length * 24;
	}
	cacheGet(term) {
		const hit = this.cache.get(term);
		if (!hit) return void 0;
		this.cache.delete(term);
		this.cache.set(term, hit);
		return hit.arr;
	}
	cachePut(term, arr) {
		if (this.cacheTerms <= 0) return;
		const bytes = TextIndex.cacheEntryBytes(term, arr);
		this.cache.set(term, {
			arr,
			bytes
		});
		this.cacheBytes += bytes;
		while (this.cache.size > this.cacheTerms || this.cacheBytesCap > 0 && this.cacheBytes > this.cacheBytesCap) {
			if (this.cache.size === 0) break;
			const oldest = this.cache.keys().next().value;
			const ev = this.cache.get(oldest);
			this.cache.delete(oldest);
			this.cacheBytes -= ev.bytes;
		}
	}
	clearCache() {
		this.cache.clear();
		this.cacheBytes = 0;
	}
	extract(doc) {
		return extractText(this.fields, doc);
	}
	/** Extract + tokenize a document, validating a CUSTOM tokenizer's output at
	*  this boundary: every term must fit the postings record's uint16 utf8
	*  length, or one pathological document would make every later postings
	*  rebuild throw (review #27). Throws BEFORE any state mutates, so a bad
	*  document can never pollute the live view, the delta, or the build queue
	*  (review #24). */
	tokensFor(doc) {
		const tokens = this.tokenizer(this.extract(doc));
		if (this.customTokenizer) {
			for (const t of tokens) if (Buffer.byteLength(t, "utf8") > 65535) throw new RangeError(`text index tokenizer produced a term longer than ${MAX_TERM_BYTES} utf8 bytes`);
		}
		return tokens;
	}
	/** The write path's prepare boundary: tokenize + validate a document for a
	*  later infallible `addPrepared`. A throwing (custom) tokenizer rejects the
	*  write HERE — before the store, delta, or build queue can be touched. */
	prepareAdd(doc) {
		return this.tokensFor(doc);
	}
	/** Number of distinct terms currently indexed (base + delta). */
	termCount() {
		if (this.memBase) {
			let n = this.memBase.size;
			for (const t of this.delta.keys()) if (!this.memBase.has(t)) n++;
			return n;
		}
		let n = this.postings.size;
		for (const t of this.delta.keys()) if (!this.postings.has(t)) n++;
		return n;
	}
	/** Whether a `build()` is currently in flight. */
	get building() {
		return this.buildQueue !== null;
	}
	/** Whether this index tokenizes with an injected custom function (such
	*  tokenizers cannot cross the stage-6 worker boundary — the index stays
	*  on the main-thread staged build). Built-in NAMED tokenizers injected
	*  as functions (the ngram pair, see TextIndexOptions.builtinTokenizer)
	*  report false: the worker reconstructs them from the definition name. */
	get hasCustomTokenizer() {
		return this.customTokenizer;
	}
	/**
	* Whether a postings rebuild would change anything: the write buffer
	* (delta + tombstones) is non-empty. Right after a build both are empty, so
	* a compaction landing immediately after an open-time build does not redo
	* the exact same pass. A build in flight also counts as fresh — its queue
	* replay already folds every concurrent mutation into the new base.
	*/
	needsRebuild() {
		if (this.buildQueue !== null) return false;
		return this.deltaCount > 0 || this.removed.size > 0;
	}
	/**
	* Rebuild the index from scratch over `entries` (the live Store view).
	* Assigns fresh dense docIDs, writes a new postings file (disk mode) or
	* replaces the in-memory base (memory mode), and clears the delta +
	* tombstones. Called on open and on compaction.
	*
	* Async and event-loop friendly: the feeding loop yields every
	* BUILD_YIELD_DOCS docs / BUILD_YIELD_TOKENS tokens and the postings write
	* batches its I/O, so a large rebuild never hard-blocks the host process
	* for many seconds the way the old fully-synchronous build did.
	*/
	async build(entries, opts = {}) {
		await feedBuild(this.beginBuild(opts), entries);
	}
	/**
	* Stage a rebuild: accumulate docs incrementally, then swap everything in on
	* commit(). Lets the caller feed several indexes from one shared Store walk
	* (one decode per record fanned out to every builder). add() is synchronous
	* (pure tokenization) — a caller feeding many docs should yield to the
	* event loop periodically (see build()); commit() is async (batched
	* postings I/O).
	*
	* Mutations arriving while the build is staged keep applying to the live
	* view (searches stay correct) and are recorded in `buildQueue`; once the
	* new base is swapped in, commit() replays the queue synchronously, so the
	* result is exactly as if those ops had arrived after the rebuild.
	*
	* Atomic on failure: everything is staged off to the side first and swapped
	* in only after the new postings file is durably renamed (disk mode), so a
	* failed commit (e.g. a transient ENOSPC/EMFILE inside PostingsFile.rebuild)
	* leaves the PREVIOUS index fully functional instead of silently emptying
	* it until the next successful build. abort() discards the staged state
	* (nothing is written before commit() runs).
	*/
	beginBuild(opts = {}) {
		if (this.buildQueue !== null) throw new Error("text index build already in progress");
		const queue = [];
		this.buildQueue = queue;
		const disarm = () => {
			if (this.buildQueue === queue) this.buildQueue = null;
		};
		return new StagedBuild({
			tokensFor: (value) => this.tokensFor(value),
			commit: (staged) => this.commitBuild(queue, staged.agg, staged.keys, staged.keyToId, staged.docLens, staged.n, opts.postingsPath),
			disarm
		});
	}
	/** Swap a fully staged build into the live index (see beginBuild).
	*  `postingsPathOverride` redirects the new postings file away from
	*  this.path (stage 5: a generation build writes the file INTO the
	*  generation's tmp directory and the live index attaches to it there;
	*  this.path stays the rebuild target for non-generation builds). */
	async commitBuild(queue, agg, newKeys, newKeyToId, newDocLen, n, postingsPathOverride) {
		const targetPath = postingsPathOverride ?? this.path;
		if (targetPath) {
			const oldPf = this.pf;
			let dict;
			try {
				const res = await PostingsFile.rebuild(targetPath, aggToSorted(agg), { beforeRename: process.platform === "win32" && oldPf !== null ? () => {
					oldPf.close();
					if (this.pf === oldPf) this.pf = null;
				} : void 0 });
				dict = res.dict;
				this.postingsFileInfo = {
					bytes: res.bytes,
					crc32: res.crc32
				};
			} catch (error) {
				if (oldPf !== null && !oldPf.open) try {
					this.pf = PostingsFile.open(targetPath);
				} catch {
					this.basePending = true;
				}
				throw error;
			}
			const newPf = PostingsFile.open(targetPath);
			this.postings = dict;
			oldPf?.close();
			this.pf = newPf;
		} else this.memBase = agg;
		this.swapDocStateAndReplay(queue, newKeys, newKeyToId, newDocLen, n);
	}
	/** Drop the write buffer (delta, tombstones, decoded-postings cache) without
	*  touching the base or the doc table. Shared by the base-commit swap (the
	*  fresh base already covers the buffered ops) and by the deferred-build
	*  retry, which re-pins the checkpoint and re-arms the queue from scratch. */
	resetWriteBuffer() {
		this.delta.clear();
		this.deltaCount = 0;
		this.deltaDocs.clear();
		this.removed.clear();
		this.clearCache();
	}
	/** Swap in the staged per-doc state, drop the write buffer, and replay
	*  the ops that landed mid-build onto the new base — one synchronous
	*  segment, so no mutation can interleave mid-swap. Shared by commitBuild
	*  (the base was staged by add()) and commitRebase (the base was built by
	*  the stage-6 worker against a pinned checkpoint). The new containers are
	*  ADOPTED by reference (the caller built them for exactly this purpose),
	*  making the switch O(1) + O(queue); the queue carries validated
	*  mutations (key + tokens), so the replay cannot throw. */
	swapDocStateAndReplay(queue, newKeys, newKeyToId, newDocLen, n) {
		this.docLen = newDocLen;
		this.keys = newKeys;
		this.keyToId = newKeyToId;
		this.resetWriteBuffer();
		this.basePending = false;
		this.baseEpoch++;
		this.N = n;
		this.buildQueue = null;
		for (const op of queue) if (op.kind === "add") this.addPrepared(op.key, op.tokens);
		else this.remove(op.key);
	}
	/** Start capturing mutations for a worker rebase. Must pair with
	*  commitRebase/abortRebase. */
	beginRebase() {
		if (this.buildQueue !== null) throw new Error("text index build already in progress");
		this.buildQueue = [];
	}
	/** Whether a worker rebase is currently capturing. */
	get rebasing() {
		return this.buildQueue !== null;
	}
	/** The containers a worker rebase needs, prepared OFF the commit path
	*  (design rule 5: the main thread only does short atomic switches). All
	*  O(T)/O(N) construction happens here, in slices with event-loop yields;
	*  the commit then swaps references in O(1) plus the queue replay. */
	static async prepareRebaseContainers(dictEntries, keys, docLens, opts = {}) {
		const sliceEvery = opts.sliceEvery ?? 65536;
		const postings = /* @__PURE__ */ new Map();
		let n = 0;
		for (const [t, e] of dictEntries) {
			postings.set(t, e);
			if (++n % sliceEvery === 0) await yieldToLoop();
		}
		const keyToId = /* @__PURE__ */ new Map();
		for (let i = 0; i < keys.length; i++) {
			const k = keys[i];
			if (k !== void 0) keyToId.set(k, i);
			if (i % sliceEvery === sliceEvery - 1) await yieldToLoop();
		}
		return {
			postings,
			keys,
			keyToId,
			docLens
		};
	}
	/** Swap in the worker-built base and replay the captured ops. The postings
	*  file was fully written (and crc-recorded) by the worker; the containers
	*  come from prepareRebaseContainers (sliced), so this commit is a short
	*  atomic switch plus the queue replay. On any failure the capture is
	*  disarmed and the PREVIOUS index stays authoritative — the queued ops
	*  were already applied to it, exactly like a failed commitBuild. */
	commitRebase(base) {
		const queue = this.buildQueue;
		if (queue === null) throw new Error("text index rebase is not in progress");
		const disarm = () => {
			if (this.buildQueue === queue) this.buildQueue = null;
		};
		let newPf;
		try {
			newPf = PostingsFile.open(base.postingsPath);
		} catch (error) {
			disarm();
			throw error;
		}
		this.memBase = null;
		const oldPf = this.pf;
		this.postings = base.containers.postings;
		oldPf?.close();
		this.pf = newPf;
		this.postingsFileInfo = { ...base.postingsFileInfo };
		this.swapDocStateAndReplay(queue, base.containers.keys, base.containers.keyToId, base.containers.docLens, base.liveCount);
	}
	/** Discard the rebase capture without swapping (worker failed/cancelled):
	*  the live index keeps its previous base, untouched by the worker. */
	abortRebase() {
		this.buildQueue = null;
	}
	/** Add or replace a document. Tokenizes (and validates a custom tokenizer's
	*  output) BEFORE any state changes, so a throwing tokenizer leaves the
	*  live view, the delta, and the build queue untouched (review #24); an
	*  overwrite's old document stays searchable. */
	add(key, doc) {
		this.addPrepared(key, this.tokensFor(doc));
	}
	/** Apply an already-tokenized, already-validated document write (see
	*  prepareAdd). Overwrites tombstone the old docID. Must not throw: pure
	*  map/set bookkeeping — this is the only text-index entry point the db's
	*  purified applyOp uses. */
	addPrepared(key, tokens) {
		this.buildQueue?.push({
			kind: "add",
			key,
			tokens
		});
		if (this.keyToId.has(key)) this.removeInner(key);
		const docID = this.keys.length;
		this.keys.push(key);
		this.keyToId.set(key, docID);
		const counts = /* @__PURE__ */ new Map();
		for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
		for (const [t, c] of counts) {
			let m = this.delta.get(t);
			if (!m) this.delta.set(t, m = /* @__PURE__ */ new Map());
			m.set(docID, c);
			this.deltaCount++;
		}
		this.deltaDocs.set(docID, new Set(counts.keys()));
		this.docLen.set(docID, tokens.length);
		this.N++;
	}
	/** Remove a document by key (tombstone its docID). Walks only the doc's own
	*  delta terms via the reverse map — O(terms in document), not O(all delta
	*  terms). */
	remove(key) {
		this.buildQueue?.push({
			kind: "remove",
			key
		});
		this.removeInner(key);
	}
	removeInner(key) {
		const id = this.keyToId.get(key);
		if (id === void 0) return;
		this.removed.add(id);
		this.keyToId.delete(key);
		this.keys[id] = void 0;
		this.docLen.delete(id);
		const terms = this.deltaDocs.get(id);
		if (terms) {
			for (const t of terms) {
				const m = this.delta.get(t);
				if (m?.delete(id)) this.deltaCount--;
				if (m && m.size === 0) this.delta.delete(t);
			}
			this.deltaDocs.delete(id);
		}
		this.N--;
	}
	/**
	* Decoded base postings for a term (disk, cached; or memory), budgeted:
	* with `maxEntries`, a list longer than the budget is capped to its leading
	* (lowest-docID) prefix and flagged `capped`. A capped read never populates
	* the LRU cache, so a later uncapped query still decodes the full list.
	* May still contain tombstoned docIDs — callers filter via `removed`.
	*/
	readBaseBounded(term, maxEntries) {
		if (this.memBase) {
			const m = this.memBase.get(term);
			if (m === void 0 || maxEntries === void 0 || m.size <= maxEntries) return {
				map: m ?? EMPTY_MAP,
				capped: false
			};
			const out = /* @__PURE__ */ new Map();
			let i = 0;
			for (const [id, f] of m) {
				if (i++ >= maxEntries) break;
				out.set(id, f);
			}
			return {
				map: out,
				capped: true
			};
		}
		const entry = this.postings.get(term);
		const pf = this.pf;
		if (pf === null) {
			if (this.postings.size > 0) throw new TextIndexBuildingError(this.indexName);
			return {
				map: EMPTY_MAP,
				capped: false
			};
		}
		if (entry !== void 0 && maxEntries !== void 0 && entry.df > maxEntries) {
			const arr = pf.read(entry, maxEntries);
			const m = /* @__PURE__ */ new Map();
			for (const [id, f] of arr) m.set(id, f);
			return {
				map: m,
				capped: true
			};
		}
		let arr = this.cacheGet(term);
		if (!arr) {
			arr = entry ? pf.read(entry) : [];
			this.cachePut(term, arr);
		}
		const m = /* @__PURE__ */ new Map();
		for (const [id, f] of arr) m.set(id, f);
		return {
			map: m,
			capped: false
		};
	}
	/** Async twin of readBaseBounded (stage 6): identical cache semantics and
	*  results; only the postings file read moves off the event loop.
	*
	*  A base commit can land between the dictionary read and the postings
	*  read (the generation build's staged commit swaps pf+dict+doc-table as
	*  one synchronous segment, exactly where this method awaits): the result
	*  would mix two bases' docID namespaces, and worse, the stale list would
	*  be cached AFTER the commit's cache clear — poisoning later queries
	*  deterministically. Re-read from the fresh base when the swap epoch
	*  moved, and only cache a list provably read under a still-current
	*  epoch. */
	async readBaseBoundedAsync(term, maxEntries) {
		if (this.memBase) return this.readBaseBounded(term, maxEntries);
		for (let attempt = 0;; attempt++) {
			const epoch = this.baseEpoch;
			const pf = this.pf;
			if (pf === null) {
				if (this.postings.size > 0) throw new TextIndexBuildingError(this.indexName);
				return {
					map: EMPTY_MAP,
					capped: false
				};
			}
			const entry = this.postings.get(term);
			let result;
			let cacheable = null;
			try {
				if (entry !== void 0 && maxEntries !== void 0 && entry.df > maxEntries) {
					const arr = await pf.readAsync(entry, maxEntries);
					const m = /* @__PURE__ */ new Map();
					for (const [id, f] of arr) m.set(id, f);
					result = {
						map: m,
						capped: true
					};
				} else {
					let arr = this.cacheGet(term);
					if (!arr) {
						arr = entry ? await pf.readAsync(entry) : [];
						cacheable = arr;
					}
					const m = /* @__PURE__ */ new Map();
					for (const [id, f] of arr) m.set(id, f);
					result = {
						map: m,
						capped: false
					};
				}
			} catch (error) {
				if (this.baseEpoch !== epoch && attempt < 2) continue;
				throw error;
			}
			if (this.baseEpoch === epoch) {
				if (cacheable !== null) this.cachePut(term, cacheable);
				return result;
			}
			if (attempt >= 2) return result;
		}
	}
	/**
	* Live postings for a term = (base ∪ delta) minus tombstones, budgeted: at
	* most `maxEntries` entries are visited (base first, then delta); `capped`
	* flags a shortfall and `visited` reports the decoded/merged entry count
	* feeding the query-level budget accounting.
	*/
	livePostingsBounded(term, maxEntries) {
		const out = /* @__PURE__ */ new Map();
		let capped = false;
		const base = this.readBaseBounded(term, maxEntries);
		if (base.capped) capped = true;
		for (const [id, f] of base.map) if (!this.removed.has(id)) out.set(id, f);
		let visited = base.map.size;
		const d = this.delta.get(term);
		if (d) for (const [id, f] of d) {
			if (maxEntries !== void 0 && visited >= maxEntries) {
				capped = true;
				break;
			}
			visited++;
			if (!this.removed.has(id)) out.set(id, f);
		}
		return {
			map: out,
			capped,
			visited
		};
	}
	/** Async twin of livePostingsBounded (stage 6): only the base read moves
	*  off the event loop; delta merge and budget accounting are identical. */
	async livePostingsBoundedAsync(term, maxEntries) {
		const out = /* @__PURE__ */ new Map();
		let capped = false;
		const base = await this.readBaseBoundedAsync(term, maxEntries);
		if (base.capped) capped = true;
		for (const [id, f] of base.map) if (!this.removed.has(id)) out.set(id, f);
		let visited = base.map.size;
		const d = this.delta.get(term);
		if (d) for (const [id, f] of d) {
			if (maxEntries !== void 0 && visited >= maxEntries) {
				capped = true;
				break;
			}
			visited++;
			if (!this.removed.has(id)) out.set(id, f);
		}
		return {
			map: out,
			capped,
			visited
		};
	}
	/** Estimated document frequency without decoding the list: the on-disk
	*  dictionary carries df, the memory base and delta know their size. */
	estimatedDf(term) {
		let n = this.memBase ? this.memBase.get(term)?.size ?? 0 : this.postings.get(term)?.df ?? 0;
		n += this.delta.get(term)?.size ?? 0;
		return n;
	}
	idf(df) {
		return Math.log(1 + this.N / (df || 1));
	}
	/** Candidate intersection + TF-IDF scoring over already-decoded term maps —
	*  the shared in-memory tail of searchBounded/searchBoundedAsync. */
	scoreTermMaps(qtokens, termMaps, op, limit, visits, truncated) {
		let candidates;
		if (op === "OR") {
			candidates = /* @__PURE__ */ new Set();
			for (const m of termMaps.values()) for (const id of m.keys()) candidates.add(id);
		} else {
			const lists = [...termMaps.values()];
			if (lists.some((m) => m.size === 0)) return {
				hits: [],
				visits,
				truncated
			};
			lists.sort((a, b) => a.size - b.size);
			candidates = new Set(lists[0].keys());
			for (let i = 1; i < lists.length && candidates.size > 0; i++) for (const id of candidates) if (!lists[i].has(id)) candidates.delete(id);
		}
		const top = new TopK(limit);
		for (const id of candidates) {
			const len = this.docLen.get(id) ?? 1;
			let score = 0;
			for (const t of qtokens) {
				const f = termMaps.get(t).get(id) ?? 0;
				if (f) score += f / len * this.idf(termMaps.get(t).size);
			}
			if (score > 0) {
				const key = this.keys[id];
				if (key !== void 0) top.offer({
					key,
					score
				});
			}
		}
		return {
			hits: top.sorted(),
			visits,
			truncated
		};
	}
	/** Query tokenization + selective-first term ordering (shared by the sync
	*  and async search paths). */
	queryTerms(query) {
		return [...new Set(this.queryTokenizer(query))];
	}
	/** Raise TextIndexBuildingError while the base is known-unavailable: a
	*  deferred open-time build has not committed yet (basePending is set at
	*  arm time) or finally failed. Serving the delta alone would silently
	*  return partial results. A staged/worker build with a LIVE old base
	*  underneath (generation builds, createTextIndex) keeps serving normally
	*  — only a build that started from a baseless index sets basePending. */
	ensureBaseAvailable() {
		if (this.basePending) throw new TextIndexBuildingError(this.indexName);
	}
	search(query, opts = {}) {
		return this.searchBounded(query, opts).hits;
	}
	searchBounded(query, opts = {}) {
		this.ensureBaseAvailable();
		const qtokens = this.queryTerms(query);
		if (qtokens.length === 0) return {
			hits: [],
			visits: 0,
			truncated: false
		};
		const op = opts.op ?? "AND";
		const limit = opts.limit ?? 50;
		const terms = qtokens.map((t) => ({
			t,
			df: this.estimatedDf(t)
		})).toSorted((a, b) => a.df - b.df);
		let remaining = opts.maxVisits ?? Number.POSITIVE_INFINITY;
		let visits = 0;
		let truncated = false;
		const termMaps = /* @__PURE__ */ new Map();
		for (const { t } of terms) {
			const cap = remaining === Number.POSITIVE_INFINITY ? void 0 : Math.max(0, remaining);
			const live = this.livePostingsBounded(t, cap);
			termMaps.set(t, live.map);
			visits += live.visited;
			remaining -= live.visited;
			if (live.capped) truncated = true;
		}
		return this.scoreTermMaps(qtokens, termMaps, op, limit, visits, truncated);
	}
	/** Async twin of searchBounded (stage 6): identical results and budget
	*  semantics; only the postings reads move off the event loop, so a cold
	*  disk-mode query no longer stalls every other request on readSync. */
	async searchBoundedAsync(query, opts = {}) {
		this.ensureBaseAvailable();
		const qtokens = this.queryTerms(query);
		if (qtokens.length === 0) return {
			hits: [],
			visits: 0,
			truncated: false
		};
		const op = opts.op ?? "AND";
		const limit = opts.limit ?? 50;
		const terms = qtokens.map((t) => ({
			t,
			df: this.estimatedDf(t)
		})).toSorted((a, b) => a.df - b.df);
		let remaining = opts.maxVisits ?? Number.POSITIVE_INFINITY;
		let visits = 0;
		let truncated = false;
		const termMaps = /* @__PURE__ */ new Map();
		for (const { t } of terms) {
			const cap = remaining === Number.POSITIVE_INFINITY ? void 0 : Math.max(0, remaining);
			const live = await this.livePostingsBoundedAsync(t, cap);
			termMaps.set(t, live.map);
			visits += live.visited;
			remaining -= live.visited;
			if (live.capped) truncated = true;
		}
		return this.scoreTermMaps(qtokens, termMaps, op, limit, visits, truncated);
	}
	/** Async convenience: the async counterpart of search(). */
	async searchAsync(query, opts = {}) {
		return (await this.searchBoundedAsync(query, opts)).hits;
	}
	/** Stage-5 generation build: a synchronous deep-enough snapshot of the live
	*  state for image serialization. The maps/arrays are copied so later
	*  mutations of the live index never reach the serialized image. Must run
	*  while no build is in flight (a committed build's state is what a
	*  generation serializes). */
	exportImageState() {
		return exportImageState(this);
	}
	/** Sliced variant of exportImageState (stage 6): identical content, copied
	*  in slices with event-loop yields so a large index's image copy never
	*  stalls the loop for the whole pass. Consistency across slices is
	*  preserved by ORDER: the doc table (keys) is copied LAST — a write that
	*  lands mid-copy appends its docID to keys BEFORE touching delta/docLens
	*  (see addPrepared), so every docID referenced by the earlier-copied
	*  delta/removed exists in the keys array (a superset is fine; holes are
	*  impossible before the copy point). The generation load's WAL-delta
	*  replay reconciles any mid-copy write exactly as it reconciles any
	*  post-seal write. */
	async exportImageStateAsync(opts = {}) {
		return exportImageStateAsync(this, opts);
	}
	/** Stage-5 generation load: attach a persisted base + write-buffer state,
	*  making the index exactly equal to the one the generation sealed —
	*  dictionary, doc table, tombstones and delta included. Any previous state
	*  is replaced; a memory-base instance switches to disk-base on the
	*  generation's postings file (read-only opens attach the same way — the
	*  file is only ever read). */
	attachImage(args) {
		attachImage(this, args);
	}
	/** Sliced variant of attachImage (the open-time main-thread path):
	*  identical resulting state, but every O(terms/docs) map construction is
	*  built from the raw parsed images in slices with event-loop yields, so
	*  attaching a large generation's base never stalls the loop for the whole
	*  pass. */
	async attachImageAsync(args, opts = {}) {
		await attachImageAsync(this, args, opts);
	}
	/** Stage-5 generation build: after the atomic publish rename, repoint the
	*  live base handle from the build's tmp directory to the published
	*  generation directory (same file, final name). On Windows an open handle
	*  would have blocked the directory rename, so the caller closes before the
	*  rename and reopens here; POSIX just updates the path (the fd stays valid
	*  across the rename). A reopen failure leaves the base unreadable, which
	*  readBaseBounded's null-handle guard turns into TextIndexBuildingError. */
	repointPostings(newPath) {
		return repointPostings(this, newPath);
	}
	/** Close the underlying postings file. */
	close() {
		if (this.pf) {
			this.pf.close();
			this.pf = null;
		}
	}
};
/** Yield `{ term, entries }` with entries sorted by docID ascending: the agg
*  maps' insertion order already IS ascending docID (docIDs increase
*  monotonically during a build), so the Map itself is yielded — never a
*  per-term spread, which was an OOM vector on million-entry lists. */
function* aggToSorted(agg) {
	for (const [term, m] of agg) yield {
		term,
		entries: m
	};
}
const CODECS = {
	buffer: {
		encode: (v) => {
			if (!Buffer.isBuffer(v)) throw new TypeError("value must be a Buffer (use valueCodec: \"string\" or \"json\")");
			return v;
		},
		decode: (b) => Buffer.from(b)
	},
	string: {
		encode: (v) => Buffer.from(String(v), "utf8"),
		decode: (b) => b.toString("utf8")
	},
	json: {
		encode: (v) => Buffer.from(JSON.stringify(v), "utf8"),
		decode: (b) => JSON.parse(b.toString("utf8"))
	}
};
function toBuf(key) {
	return Buffer.isBuffer(key) ? key : Buffer.from(String(key), "utf8");
}
function toKStr$1(key) {
	return typeof key === "string" ? Buffer.from(key, "utf8").toString("binary") : key.toString("binary");
}
function fromKStr$1(k) {
	return Buffer.from(k, "binary").toString("utf8");
}
function canonRange(opts) {
	const out = { ...opts };
	if (out.gte !== void 0) out.gte = toKStr$1(out.gte);
	if (out.gt !== void 0) out.gt = toKStr$1(out.gt);
	if (out.lte !== void 0) out.lte = toKStr$1(out.lte);
	if (out.lt !== void 0) out.lt = toKStr$1(out.lt);
	return out;
}
function normDt(dt) {
	if (!dt) return null;
	const out = {};
	for (const [k, v] of Object.entries(dt)) {
		const ms = typeof v === "number" ? v : Date.parse(v);
		if (Number.isFinite(ms)) out[k] = ms;
	}
	return Object.keys(out).length > 0 ? out : null;
}
async function fileSize(file) {
	try {
		return (await fs$1.stat(file)).size;
	} catch (error) {
		if (error.code === "ENOENT") return 0;
		throw error;
	}
}
let sidecarTmpSeq = 0;
/** Write a small metadata file atomically (unique tmp + rename + strict
*  directory fsync), so a crash cannot leave a torn definition file that
*  would force openers into error/rebuild — and a successful return means
*  the rename is crash-durable (the stage-9 strict fsyncDir mode; a platform
*  without directory fsync degrades via fsyncDir itself). A strict fsync
*  failure propagates even though the renamed bytes may already be visible:
*  persist = crash-durable by definition, so the caller treats the mutation
*  as failed and keeps its previous in-memory state (the same ambiguity rule
*  as a WAL commit-point failure). */
async function writeFileAtomic(file, data, opts = {}) {
	const tmp = `${file}.tmp-${process.pid}-${++sidecarTmpSeq}`;
	try {
		const h = await fs$1.open(tmp, "w");
		try {
			await h.writeFile(data, "utf8");
			await h.sync();
		} finally {
			await h.close().catch(() => {});
		}
		await fs$1.rename(tmp, file);
	} finally {
		await fs$1.rm(tmp, { force: true }).catch(() => {});
	}
	await fsyncDir(path.dirname(file), {
		strict: true,
		stats: opts.stats
	});
}
async function resolveValueMode(mode, dir, maxMemoryBytes) {
	if (mode !== "auto") return mode;
	if (maxMemoryBytes === null) return "memory";
	return await fileSize(path.join(dir, "db.snapshot")) + await fileSize(path.join(dir, "db.wal")) > maxMemoryBytes ? "disk" : "memory";
}
// ../../packages/minidb/src/text-registry.ts
/** Map a persisted tokenizer name to the TextIndex tokenizer pair. 'default'
*  (or a legacy definition without the field) returns empty options, keeping
*  the built-in tokenizer path untouched. The query side only diverges for
*  'ngram' (a length >= 3 query emits only its 3-grams); both sides share the
*  same normalization, so candidates stay a superset of the true matches. The
*  ngram pair travels as functions but is marked `builtinTokenizer`, so the
*  index does NOT count as custom-tokenized (stage-6 worker eligibility). */
function textIndexTokenizers(name) {
	if (name === void 0 || name === "default") return {};
	if (name === "ngram") return {
		tokenizer: createNgramTokenizer(),
		queryTokenizer: createNgramTokenizer({ forQuery: true }),
		builtinTokenizer: "ngram"
	};
	throw new RangeError(`unknown text index tokenizer: ${String(name)}`);
}
var TextRegistry = class {
	deps;
	text = /* @__PURE__ */ new Map();
	textDefs = [];
	/** Names staged for drop by dropTextIndex (plan 10's "mark staged-drop,
	*  persist, then remove from live"). A compaction's postings rebuild
	*  (rebuildTextPostings) skips them: without the mark, a build starting in
	*  the drop's persist window could commit AFTER the drop's close+rm —
	*  re-creating the postings file as an orphan and leaking the reopened
	*  handle. */
	textDrops = /* @__PURE__ */ new Set();
	textDefChain = createSerializer();
	constructor(deps) {
		this.deps = deps;
	}
	textIndexPath() {
		return path.join(this.deps.dir(), TEXT_INDEXES_FILE);
	}
	/** On-disk postings file path for a text index (root location — the legacy
	*  pre-generation home; the name sanitization lives in generation.ts). */
	textPostingsPath(name) {
		return path.join(this.deps.dir(), rootPostingsFile(name));
	}
	/** The canonical definition shape a text index's manifest hash is computed
	*  from (both sides use it, so a legacy definition without `tokenizer`
	*  hashes identically to an explicit 'default'). */
	static canonicalTextDef(d) {
		return {
			name: d.name,
			fields: d.fields,
			tokenizer: d.tokenizer ?? "default"
		};
	}
	/** LEGACY postings maintenance (indexGenerations: false): rebuild every
	*  dirty text index's on-disk postings from the live Store. With
	*  generations enabled this whole job is superseded by the generation
	*  build (the staged text builds + clean re-publish), so it only runs on
	*  the legacy onCompacted path. Drops the in-memory delta + tombstones and
	*  reclaims orphaned postings records — postings are pure derived state,
	*  so this is only for space/latency, never for correctness. Indexes with
	*  an empty write buffer are skipped: a fresh base must not be redone. */
	async rebuildTextPostings() {
		for (const [name, ti] of this.text) {
			if (this.textDrops.has(name)) continue;
			if (ti.needsRebuild()) await ti.build(this.deps.textRecords());
		}
	}
	async loadTextIndexDefinitions() {
		try {
			const raw = await fs$1.readFile(this.textIndexPath(), "utf8");
			this.textDefs = JSON.parse(raw);
			for (const d of this.textDefs) this.text.set(d.name, new TextIndex({
				name: d.name,
				fields: d.fields,
				...textIndexTokenizers(d.tokenizer),
				postingsPath: this.deps.readOnly() ? void 0 : this.textPostingsPath(d.name)
			}));
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	async createTextIndex(name, { fields, tokenizer } = {}) {
		this.deps.ensureOpen();
		this.deps.ensureWritable();
		if (this.deps.codecName() !== "json") throw new Error("text indexes require valueCodec: \"json\"");
		await this.textDefChain(async () => {
			if (this.text.has(name)) throw new Error(`text index "${name}" already exists`);
			const ti = new TextIndex({
				name,
				fields,
				...textIndexTokenizers(tokenizer),
				postingsPath: this.textPostingsPath(name)
			});
			const def = {
				name,
				fields: fields ?? null,
				tokenizer
			};
			this.text.set(name, ti);
			try {
				if (await this.deps.boundedTextBuild(name, ti, def, null) === null) await ti.build(this.deps.textRecords());
				await this.deps.persistTextIndexDefinitions([...this.textDefs, def]);
			} catch (error) {
				this.text.delete(name);
				ti.close();
				await fs$1.rm(this.textPostingsPath(name), { force: true }).catch(() => {});
				throw error;
			}
			this.textDefs.push(def);
		});
	}
	async dropTextIndex(name) {
		this.deps.ensureOpen();
		this.deps.ensureWritable();
		return this.textDefChain(async () => {
			const ti = this.text.get(name);
			if (ti?.building) throw new Error(`text index "${name}" is still building`);
			this.textDrops.add(name);
			try {
				const nextDefs = this.textDefs.filter((d) => d.name !== name);
				await this.deps.persistTextIndexDefinitions(nextDefs);
				const ok = this.text.delete(name);
				if (ti) {
					ti.close();
					await fs$1.rm(this.textPostingsPath(name), { force: true }).catch(() => {});
				}
				this.textDefs = nextDefs;
				return ok;
			} finally {
				this.textDrops.delete(name);
			}
		});
	}
	search(name, q, opts = {}) {
		return this.searchBounded(name, q, opts).hits;
	}
	/**
	* `search` with work accounting: `opts.maxVisits` bounds how many posting
	* entries the index visits (see TextIndex.searchBounded); the result
	* reports the visits and whether the budget truncated the candidate set
	* (hits are then a subset of the full matches, never false hits).
	*/
	searchBounded(name, q, opts = {}) {
		this.deps.ensureOpen();
		const ti = this.text.get(name);
		if (!ti) throw new Error(`no such text index: ${name}`);
		const res = ti.searchBounded(q, opts);
		return {
			hits: res.hits.map(({ key, score }) => ({
				key: fromKStr$1(key),
				value: this.deps.decode(this.deps.store().get(key)),
				score
			})).filter((r) => r.value !== void 0),
			visits: res.visits,
			truncated: res.truncated
		};
	}
	/** Async twin of searchBounded (stage 6, additive): identical hits and
	*  budget accounting; the postings reads and the disk-mode value reads run
	*  off the event loop. The server's search path prefers this variant. */
	async searchBoundedAsync(name, q, opts = {}) {
		this.deps.ensureOpen();
		const ti = this.text.get(name);
		if (!ti) throw new Error(`no such text index: ${name}`);
		const res = await ti.searchBoundedAsync(q, opts);
		const hits = [];
		for (const { key, score } of res.hits) {
			const buf = await this.deps.readValueAsync(key);
			if (buf === void 0) continue;
			hits.push({
				key: fromKStr$1(key),
				value: this.deps.decode(buf),
				score
			});
		}
		return {
			hits,
			visits: res.visits,
			truncated: res.truncated
		};
	}
	/** Async convenience: the async counterpart of search(). */
	async searchAsync(name, q, opts = {}) {
		return (await this.searchBoundedAsync(name, q, opts)).hits;
	}
};
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
/** Sliced variant (stage 6): identical result, with event-loop yields every
*  `yieldEvery` docs so a million-doc table never parses in one synchronous
*  run. */
async function readBaseDocsImageAsync(r, yieldEvery = 65536) {
	const count = r.u64();
	const keys = [];
	const docLens = /* @__PURE__ */ new Map();
	for (let i = 0; i < count; i++) {
		const present = r.u8();
		if (present === 1) {
			keys.push(r.key());
			const len = r.u32();
			if (len !== 0) docLens.set(i, len);
		} else if (present === 0) {
			keys.push(void 0);
			r.u32();
		} else throw new Error(`base docs image: unknown presence tag ${present}`);
		if (i % yieldEvery === yieldEvery - 1) await new Promise((res) => setImmediate(res));
	}
	if (!r.done) throw new Error("base docs image: trailing bytes");
	return {
		keys,
		docLens
	};
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
// ../../packages/minidb/src/worker/text-build.ts
var WorkerTextBuildError = class extends Error {
	code = "WORKER_TEXT_BUILD_FAILED";
	aborted;
	constructor(message, aborted = false) {
		super(message);
		this.name = aborted ? "AbortError" : "WorkerTextBuildError";
		this.aborted = aborted;
	}
};
const DEFAULT_ABORT_POLL_MS = 100;
const DEFAULT_MAX_OLD_SPACE_MB = 1024;
async function verifyFileCrcAsync(filePath, expected) {
	const fh = await import("node:fs/promises").then((m) => m.open(filePath, "r"));
	try {
		const st = await fh.stat();
		if (st.size !== expected.bytes) throw new Error(`worker artifact ${filePath}: size ${st.size} != manifest ${expected.bytes}`);
		let crc = 0;
		const buf = Buffer.allocUnsafe(1 << 20);
		let pos = 0;
		while (pos < st.size) {
			const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, st.size - pos), pos);
			if (bytesRead === 0) throw new Error(`worker artifact ${filePath}: shrank during verification`);
			crc = crc32(buf.subarray(0, bytesRead), crc);
			pos += bytesRead;
		}
		if (crc >>> 0 !== expected.crc32) throw new Error(`worker artifact ${filePath}: crc mismatch`);
	} finally {
		await fh.close().catch(() => {});
	}
}
function siblingWorkerEntry() {
	const url = new URL("./text-build-worker.ts", import.meta.url);
	try {
		return fs.statSync(url).isFile() ? {
			kind: "source",
			url
		} : null;
	} catch {
		return null;
	}
}
function workerRuntimeEntry() {
	const state = getTextBuildWorkerRuntimeState();
	return state.configured ? state.entry : siblingWorkerEntry();
}
function textBuildWorkerAvailable() {
	return workerRuntimeEntry() !== null;
}
function spawnWorker(spec, opts, entry) {
	const resourceLimits = { maxOldGenerationSizeMb: opts.workerMaxOldSpaceMb ?? DEFAULT_MAX_OLD_SPACE_MB };
	if (entry.kind === "packaged") return new Worker(entry.path, {
		workerData: spec,
		execArgv: [],
		...WORKER_LIMITS_OPTION(resourceLimits)
	});
	return new Worker(entry.url, {
		workerData: spec,
		execArgv: ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"],
		...WORKER_LIMITS_OPTION(resourceLimits)
	});
}
function WORKER_LIMITS_OPTION(limits) {
	return typeof globalThis.Bun === "undefined" ? { resourceLimits: limits } : {};
}
function startWorkerTextBuild(spec, opts = {}) {
	if (opts.inline) return startInline(spec, opts, opts.inlineReason ?? "disabled");
	const entry = workerRuntimeEntry();
	if (entry === null && opts.workerFactory === void 0) return startInline(spec, opts, "runtime-unavailable");
	let activeWorker;
	try {
		activeWorker = opts.workerFactory?.(spec) ?? spawnWorker(spec, opts, entry);
	} catch {
		return startInline(spec, opts, "constructor-failure");
	}
	let worker = activeWorker;
	let inline = false;
	let fallbackReason = null;
	let inlineHandle = null;
	let cancelRequested = false;
	let completed = false;
	let abortPoll = null;
	let onOwnerAbort = null;
	let terminateTimer = null;
	let terminatePromise = null;
	let exitCode = null;
	let resolveExit;
	const exitPromise = new Promise((resolve) => {
		resolveExit = resolve;
	});
	const events = [];
	let eventWaiter = null;
	const pushEvent = (event) => {
		if (eventWaiter !== null) {
			const resolve = eventWaiter;
			eventWaiter = null;
			resolve(event);
		} else events.push(event);
	};
	const nextEvent = () => {
		const event = events.shift();
		if (event !== void 0) return Promise.resolve(event);
		return new Promise((resolve) => {
			eventWaiter = resolve;
		});
	};
	const onMessage = (message) => {
		pushEvent({
			type: "message",
			message
		});
	};
	const onError = (error) => {
		pushEvent({
			type: "error",
			error
		});
	};
	const onExit = (code) => {
		exitCode = code;
		worker = null;
		resolveExit(code);
		pushEvent({
			type: "exit",
			code
		});
	};
	activeWorker.on("message", onMessage);
	activeWorker.on("error", onError);
	activeWorker.on("exit", onExit);
	const stopWorker = async () => {
		if (exitCode !== null) return exitCode;
		if (terminatePromise === null) try {
			terminatePromise = activeWorker.terminate();
		} catch (error) {
			terminatePromise = Promise.reject(error);
		}
		let terminateError;
		try {
			await terminatePromise;
		} catch (error) {
			terminateError = error;
		}
		const confirmedExitCode = await exitPromise;
		if (terminateError !== void 0) throw terminateError instanceof Error ? terminateError : new Error("text build worker termination failed", { cause: terminateError });
		return confirmedExitCode;
	};
	const cleanup = () => {
		if (abortPoll !== null) clearInterval(abortPoll);
		abortPoll = null;
		if (opts.signal && onOwnerAbort) opts.signal.removeEventListener("abort", onOwnerAbort);
		if (terminateTimer !== null) clearTimeout(terminateTimer);
		terminateTimer = null;
		activeWorker.off("message", onMessage);
		activeWorker.off("error", onError);
		activeWorker.off("exit", onExit);
	};
	const abortError = () => new WorkerTextBuildError("text build worker was cancelled", true);
	const startFallback = async (reason) => {
		await stopWorker();
		if (cancelRequested) throw abortError();
		inline = true;
		fallbackReason = reason;
		opts.onFallback?.(reason);
		inlineHandle = startInline(spec, {
			...opts,
			onFallback: void 0
		}, null);
		if (cancelRequested) await inlineHandle.cancel();
		return inlineHandle.promise;
	};
	const run = async () => {
		let ready = false;
		while (true) {
			const event = await nextEvent();
			if (event.type === "message") {
				const message = event.message;
				if (message.type === "ready") {
					if (message.version !== 1) return startFallback("protocol-mismatch");
					ready = true;
					continue;
				}
				if (!ready) continue;
				if (message.type === "progress") {
					opts.onProgress?.({
						docs: message.docs ?? 0,
						terms: message.terms ?? 0,
						segments: message.segments ?? 0
					});
					continue;
				}
				if (message.type === "done") {
					await stopWorker();
					if (cancelRequested) throw abortError();
					if (!message.result) throw new WorkerTextBuildError("text build worker returned no result", false);
					return message.result;
				}
				if (message.type === "failed") {
					await stopWorker();
					throw new WorkerTextBuildError(message.error ?? "text build failed in the worker", message.aborted ?? cancelRequested);
				}
				continue;
			}
			if (event.type === "error") {
				await stopWorker();
				if (!ready && !cancelRequested) return startFallback("bootstrap-failure");
				throw new WorkerTextBuildError(`text build worker errored: ${event.error.message}`, cancelRequested);
			}
			if (!ready && !cancelRequested) return startFallback("bootstrap-failure");
			throw new WorkerTextBuildError(`text build worker exited early (code ${event.code})`, cancelRequested);
		}
	};
	const promise = run().finally(() => {
		completed = true;
		cleanup();
	});
	promise.catch(() => {});
	const requestCancel = () => {
		if (cancelRequested || completed) return;
		cancelRequested = true;
		if (inlineHandle !== null) {
			inlineHandle.cancel();
			return;
		}
		try {
			activeWorker.postMessage({ type: "cancel" }, []);
		} catch {}
		terminateTimer = setTimeout(() => {
			stopWorker().catch(() => {});
		}, 2e3);
		terminateTimer.unref?.();
	};
	if (opts.signal) {
		onOwnerAbort = requestCancel;
		if (opts.signal.aborted) requestCancel();
		else opts.signal.addEventListener("abort", onOwnerAbort, { once: true });
	}
	if (opts.shouldAbort) {
		abortPoll = setInterval(() => {
			if (opts.shouldAbort()) requestCancel();
		}, opts.abortPollMs ?? DEFAULT_ABORT_POLL_MS);
		abortPoll.unref?.();
	}
	return {
		promise,
		cancel: async () => {
			requestCancel();
			await promise.catch(() => {});
			if (worker !== null) await stopWorker();
		},
		get worker() {
			return worker;
		},
		get inline() {
			return inline;
		},
		get fallbackReason() {
			return fallbackReason;
		}
	};
}
function startInline(spec, opts, reason) {
	if (reason !== null) opts.onFallback?.(reason);
	const controller = new AbortController();
	let poll = null;
	let onOwnerAbort = null;
	if (opts.signal) {
		onOwnerAbort = () => {
			controller.abort();
		};
		if (opts.signal.aborted) controller.abort();
		else opts.signal.addEventListener("abort", onOwnerAbort, { once: true });
	}
	if (opts.shouldAbort) {
		poll = setInterval(() => {
			if (opts.shouldAbort()) controller.abort();
		}, opts.abortPollMs ?? DEFAULT_ABORT_POLL_MS);
		poll.unref?.();
	}
	const promise = buildTextArtifacts({
		...spec,
		signal: controller.signal,
		onProgress: opts.onProgress
	}).finally(() => {
		if (poll !== null) clearInterval(poll);
		if (opts.signal && onOwnerAbort) opts.signal.removeEventListener("abort", onOwnerAbort);
	});
	return {
		promise,
		cancel: async () => {
			controller.abort();
			await promise.catch(() => {});
		},
		worker: null,
		inline: true,
		fallbackReason: reason
	};
}
// ../../packages/minidb/src/generation-loader.ts
/** Store-image parse/filter records per event-loop slice on the open path
*  (the bulk load's own slicing lives in Store.bulkLoadRefsAsync). */
const STORE_IMAGE_RECORDS_PER_SLICE = 8192;
var GenerationLoader = class {
	deps;
	setGenerationInfo;
	constructor(deps, setGenerationInfo) {
		this.deps = deps;
		this.setGenerationInfo = setGenerationInfo;
	}
	/** Read the store image / index images of one published generation and
	*  replay the WAL past its checkpoint. Throws GenerationCorruptError for
	*  every validation/consistency failure (the caller falls back); genuine
	*  system errors propagate. On success the instance is fully recovered —
	*  store, every derived index, recoveryInfo, value reader. */
	async loadOneGeneration(id, mode) {
		const genDir = generationDir(this.deps.dir(), id);
		const manifest = await readManifest(this.deps.dir(), id);
		if (manifest.valueCodec !== this.deps.codecName()) throw new GenerationCorruptError(`codec mismatch (${manifest.valueCodec} != ${this.deps.codecName()})`);
		if (manifest.valueMode !== this.deps.valueMode()) throw new GenerationCorruptError(`value mode mismatch (${manifest.valueMode} != ${this.deps.valueMode()})`);
		const cp = manifest.checkpoint;
		const walSt = await fs$1.stat(this.deps.walPath()).catch((error) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (!walSt || walSt.dev !== cp.walDev || walSt.ino !== cp.walIno || walSt.size < cp.walOffset) throw new GenerationCorruptError("WAL anchor mismatch (rotated or truncated since the build)");
		if (this.deps.valueMode() === "disk" && cp.snapshotIno !== 0) {
			if (!cp.snapshotLinked) throw new GenerationCorruptError("snapshot not hard-linked; disk refs unservable");
			const snapSt = await fs$1.stat(path.join(this.deps.dir(), SNAPSHOT_FILE)).catch((error) => {
				if (error.code === "ENOENT") return null;
				throw error;
			});
			if (!snapSt || snapSt.dev !== cp.snapshotDev || snapSt.ino !== cp.snapshotIno) throw new GenerationCorruptError("snapshot anchor mismatch (rotated since the build)");
		}
		if (this.deps.valueMode() === "disk") {
			const reader = new ValueReader(this.deps.dir());
			let ids;
			try {
				ids = reader.open();
			} catch (error) {
				reader.close();
				throw error;
			}
			const walOk = ids.wal !== null && ids.wal.dev === cp.walDev && ids.wal.ino === cp.walIno;
			const snapOk = cp.snapshotIno === 0 ? true : ids.snapshot !== null && ids.snapshot.dev === cp.snapshotDev && ids.snapshot.ino === cp.snapshotIno;
			if (!walOk || !snapOk) {
				reader.close();
				throw new GenerationCorruptError("value reader attach raced a rotation");
			}
			this.deps.setValueReader(reader);
		}
		const tStore = performance.now();
		const storeInfo = manifest.files[STORE_IMAGE_FILE];
		if (!storeInfo) throw new GenerationCorruptError("store image missing from manifest");
		const storePayload = await readGenerationFileCheckedAsync(path.join(genDir, STORE_IMAGE_FILE), "MDGS", 4, storeInfo);
		const now = Date.now();
		const droppedExpired = [];
		const records = [];
		let imageCount = 0;
		let parsed = 0;
		for (const rec of readStoreImage(storePayload)) {
			imageCount++;
			if (rec.expireAt && rec.expireAt <= now) {
				droppedExpired.push(rec.kstr);
				continue;
			}
			if (this.deps.valueMode() === "memory" && rec.ref.kind !== "memory") throw new GenerationCorruptError("store image carries disk refs for a memory-mode open");
			records.push(rec);
			if (++parsed % STORE_IMAGE_RECORDS_PER_SLICE === 0) await yieldToLoop();
		}
		await this.deps.store().bulkLoadRefsAsync(records);
		if (manifest.counts && typeof manifest.counts.records === "number" && manifest.counts.records !== imageCount) throw new GenerationCorruptError(`store image record count mismatch (${imageCount} != ${manifest.counts.records})`);
		this.deps.lifecycle.time("storeImageLoadMs", performance.now() - tStore);
		const tNonText = performance.now();
		await this.loadDtImage(genDir, manifest);
		await this.loadSecondaryImages(genDir, manifest);
		await this.loadCompoundImages(genDir, manifest);
		this.deps.lifecycle.time("nonTextImageLoadMs", performance.now() - tNonText);
		await this.loadTextImages(genDir, manifest);
		for (const k of droppedExpired) {
			this.deps.dt.del(k);
			this.deps.indexes.remove(k);
			this.deps.compound.remove(k);
			for (const ti of this.deps.textRegistry.text.values()) ti.remove(k);
		}
		this.deps.lifecycle.transition("wal-catch-up");
		const replay = await this.replayWalDelta(cp.walOffset, mode);
		const walAfter = await fs$1.stat(this.deps.walPath()).catch((error) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (!walAfter || walAfter.dev !== cp.walDev || walAfter.ino !== cp.walIno) throw new GenerationCorruptError("WAL rotated during generation load");
		this.deps.setRecoveryInfo({
			snapshotFrames: records.length,
			walFrames: replay.walFrames,
			snapshotBytes: storeInfo.bytes,
			walBytes: walSt.size,
			truncatedWal: replay.truncatedWal,
			corruptRanges: replay.corruptRanges,
			snapshotCorruptRanges: [],
			lostBytes: replay.corruptRanges.reduce((a, [s, e]) => a + (e - s), 0),
			walScanEnd: replay.walScanEnd,
			...replay.walTail ? { walScanTail: replay.walTail } : {},
			walDev: cp.walDev,
			walIno: cp.walIno,
			snapshotDev: cp.snapshotDev,
			snapshotIno: cp.snapshotIno,
			corruptBatches: replay.corruptBatches,
			generationRetries: 0,
			indexGeneration: {
				id,
				walCheckpoint: cp.walOffset,
				records: records.length
			},
			walDeltaAppliedOps: replay.appliedOps
		});
		this.setGenerationInfo({
			id,
			createdAt: manifest.createdAt,
			walCheckpoint: cp.walOffset,
			records: records.length
		});
		this.deps.seedAccessFromStore();
	}
	/** Undo any partial state a failed generation-load candidate left behind,
	*  so the next candidate (or the legacy full recovery) starts clean: the
	*  store must be empty (recovery replays into it), the value reader
	*  detached, and any postings handles the candidate attached closed (the
	*  next path re-attaches or rebuilds as needed). */
	resetAfterFailedGenerationLoad() {
		for (const k of this.deps.store().map.keys()) this.deps.store().del(k);
		this.deps.getValueReader()?.close();
		this.deps.setValueReader(void 0);
		for (const ti of this.deps.textRegistry.text.values()) ti.close();
	}
	/** The generation-load entry point from open(): try CURRENT's generation
	*  first, then the previous ones (their WAL anchor survives whenever no
	*  compaction intervened). Corruption-class failures try the next
	*  candidate; genuine system errors propagate. Returns false when no
	*  candidate loaded (the caller runs the legacy full recovery). */
	async tryLoadGeneration(mode) {
		const t0 = performance.now();
		const lifecycle = this.deps.lifecycle;
		try {
			const candidates = [];
			try {
				const current = await readCurrent(this.deps.dir());
				if (current) candidates.push(current);
				for (const g of await listGenerations(this.deps.dir())) if (!g.tmp && g.id !== current && candidates.length < 3) candidates.push(g.id);
			} catch (error) {
				this.deps.stats.generationLoadFallbacks++;
				this.deps.stats.lastGenerationFallback = `list: ${error.message}`;
				return false;
			}
			for (const id of candidates) try {
				lifecycle.transition("generation-load");
				await this.loadOneGeneration(id, mode);
				this.deps.stats.generationLoads++;
				this.deps.stats.generationLoadDurationMs += performance.now() - t0;
				return true;
			} catch (error) {
				if (!(error instanceof GenerationCorruptError) && error.code !== "ENOENT") throw error;
				this.deps.stats.generationLoadFallbacks++;
				this.deps.stats.lastGenerationFallback = `${id}: ${error.message}`;
				this.resetAfterFailedGenerationLoad();
			}
			return false;
		} finally {
			lifecycle.time("generationCandidateLoadMs", performance.now() - t0);
		}
	}
	/** Load the dt image; rebuild the (cheap, metadata-only) dt index from the
	*  loaded store when the image is absent/corrupt. */
	async loadDtImage(genDir, manifest) {
		const info = manifest.files[DT_INDEX_FILE];
		if (info) try {
			const payload = await readGenerationFileCheckedAsync(path.join(genDir, DT_INDEX_FILE), "MDGD", 1, info);
			this.deps.dt.loadImage(readDtIndexImage(payload));
			return;
		} catch (error) {
			if (!(error instanceof GenerationCorruptError)) throw error;
		}
		this.deps.stats.generationIndexRebuilds++;
		const store = this.deps.store();
		this.deps.dt.rebuild((function* () {
			for (const rec of store.rawRecords()) yield {
				key: rec.kstr,
				dt: rec.dt
			};
		})());
	}
	/** Load secondary-index images for definitions whose hash still matches;
	*  rebuild exactly the affected indexes otherwise (plan: only the affected
	*  index is rebuilt, never the whole registry). The payload verify, the
	*  parse, and each image's map construction are event-loop sliced. */
	async loadSecondaryImages(genDir, manifest) {
		const live = this.deps.indexes.list();
		if (live.length === 0) return;
		let images = null;
		const info = manifest.files[SECONDARY_INDEX_FILE];
		if (info) try {
			const payload = await readGenerationFileCheckedAsync(path.join(genDir, SECONDARY_INDEX_FILE), "MDSI", 1, info);
			images = new Map((await readSecondaryIndexImageAsync(payload)).map((i) => [i.name, i]));
		} catch (error) {
			if (!(error instanceof GenerationCorruptError)) throw error;
		}
		for (const def of live) {
			const image = images?.get(def.name);
			if (image && manifest.indexDefs.secondary[def.name] === indexDefHash(def)) try {
				await this.deps.indexes.loadImageAsync(image);
				continue;
			} catch {}
			this.deps.stats.generationIndexRebuilds++;
			this.rebuildOneSecondaryIndex(def);
		}
	}
	rebuildOneSecondaryIndex(def) {
		const fresh = new IndexManager();
		fresh.create(def.name, def);
		for (const { key, value } of this.deps.liveRecordsRaw()) if (this.deps.indexable(value)) fresh.add(toKStr$1(key), value);
		this.deps.indexes.indexes.set(def.name, fresh.indexes.get(def.name));
	}
	/** Load compound-index images (same per-index discipline — and the same
	*  event-loop slicing — as secondary). */
	async loadCompoundImages(genDir, manifest) {
		const live = this.deps.compound.list();
		if (live.length === 0) return;
		let images = null;
		const info = manifest.files[COMPOUND_INDEX_FILE];
		if (info) try {
			const payload = await readGenerationFileCheckedAsync(path.join(genDir, COMPOUND_INDEX_FILE), "MDCI", 1, info);
			images = new Map((await readCompoundIndexImageAsync(payload)).map((i) => [i.name, i]));
		} catch (error) {
			if (!(error instanceof GenerationCorruptError)) throw error;
		}
		for (const def of live) {
			const image = images?.get(def.name);
			if (image && manifest.indexDefs.compound[def.name] === indexDefHash(def)) try {
				await this.deps.compound.loadImageAsync(image);
				continue;
			} catch {}
			this.deps.stats.generationIndexRebuilds++;
			this.rebuildOneCompoundIndex(def);
		}
	}
	rebuildOneCompoundIndex(def) {
		const fresh = new CompoundIndexManager();
		fresh.create(def.name, {
			groupBy: def.groupBy,
			orderBy: def.orderBy,
			orderType: def.orderType
		});
		for (const { key, value, dt } of this.deps.liveRecords()) fresh.add(toKStr$1(key), value, dt);
		this.deps.compound.indexes.set(def.name, fresh.indexes.get(def.name));
	}
	/** Load text-index images (dictionary + docs + postings attachment) for
	*  definitions whose hash still matches; rebuild exactly the affected
	*  indexes otherwise — a rebuild is the full corpus tokenization for that
	*  one index, the cost stage 5 exists to avoid on the happy path. */
	async loadTextImages(genDir, manifest) {
		const registry = this.deps.textRegistry;
		for (const def of registry.textDefs) {
			const ti = registry.text.get(def.name);
			if (!ti) continue;
			const dictInfo = manifest.files[textDictionaryFile(def.name)];
			const docsInfo = manifest.files[textDocsFile(def.name)];
			const postingsInfo = manifest.files[textPostingsFile(def.name)];
			let attached = false;
			if (dictInfo && docsInfo && postingsInfo && manifest.indexDefs.text[def.name] === indexDefHash(TextRegistry.canonicalTextDef(def))) try {
				const tImage = performance.now();
				const dictPayload = await readGenerationFileCheckedAsync(path.join(genDir, textDictionaryFile(def.name)), "MDTD", 1, dictInfo);
				const docsPayload = await readGenerationFileCheckedAsync(path.join(genDir, textDocsFile(def.name)), "MDTC", 1, docsInfo);
				const postingsPath = path.join(genDir, textPostingsFile(def.name));
				const tCrc = performance.now();
				await verifyFileIntegrityAsync(postingsPath, postingsInfo);
				this.deps.lifecycle.time("postingsIntegrityCheckMs", performance.now() - tCrc);
				const dictEntries = await readTextDictionaryImageAsync(dictPayload);
				const docs = await readTextDocsImageAsync(docsPayload);
				await ti.attachImageAsync({
					postingsPath,
					dictEntries,
					docs
				});
				ti.postingsFileInfo = {
					bytes: postingsInfo.bytes,
					crc32: postingsInfo.crc32
				};
				this.deps.lifecycle.time("textImageLoadMs", performance.now() - tImage);
				this.deps.lifecycle.noteTextIndexSource(def.name, "image");
				attached = true;
			} catch (error) {
				if (!(error instanceof GenerationCorruptError) && error.code !== "ENOENT") throw error;
			}
			if (!attached) {
				this.deps.stats.generationIndexRebuilds++;
				const tRebuild = performance.now();
				let hosted = null;
				try {
					hosted = await this.deps.boundedTextBuild(def.name, ti, def, manifest.checkpoint);
				} catch (error) {
					if (error instanceof MaintenanceCancelledError || error instanceof WorkerTextBuildError && error.aborted) throw error;
				}
				const rebuildPostingsPath = path.join(genDir, `${textPostingsFile(def.name)}.rebuild`);
				if (hosted === null) await ti.build(this.deps.textRecords(), { postingsPath: rebuildPostingsPath });
				this.deps.lifecycle.time("textRebuildMs", performance.now() - tRebuild);
				this.deps.lifecycle.noteTextIndexSource(def.name, hosted ?? "staged");
			}
		}
	}
	/** Replay WAL frames at/after `startOffset` onto the loaded store (and
	*  every derived index), with the legacy recovery's torn-tail handling:
	*  a corrupt tail is truncated by the writer, left alone read-only. */
	async replayWalDelta(startOffset, mode) {
		const fd = fs.openSync(this.deps.walPath(), "r");
		try {
			const st = fs.fstatSync(fd);
			const tScan = performance.now();
			const r = await scanFrameRefsFdAsync(fd, {
				onCorrupt: mode,
				startOffset
			});
			this.deps.lifecycle.time("walScanMs", performance.now() - tScan);
			const tApply = performance.now();
			let corruptBatches = 0;
			let appliedOps = 0;
			const slice = walApplySlicer();
			for (const f of r.frames) for (const op of frameToOps(f, "wal", fd, this.deps.valueMode(), () => corruptBatches++)) {
				this.deps.applyRecoveredOp(op);
				appliedOps++;
				if (slice()) await yieldToLoop();
			}
			this.deps.lifecycle.time("walApplyMs", performance.now() - tApply);
			const walTail = readWalTailFd(fd, r.eofOffset);
			let truncatedWal = false;
			const last = r.corruptRanges.at(-1);
			if (last && last[1] === st.size && !this.deps.readOnly()) {
				await fs$1.truncate(this.deps.walPath(), last[0]);
				truncatedWal = true;
				await this.deps.wal().refreshSize();
			}
			return {
				walFrames: r.frames.length,
				walScanEnd: r.eofOffset,
				walTail,
				corruptRanges: r.corruptRanges,
				truncatedWal,
				corruptBatches,
				appliedOps
			};
		} finally {
			fs.closeSync(fd);
		}
	}
};
/** Internal control-flow exception: the generation build noticed a rotation,
*  a WAL rollback, a closing instance, or a queue overflow and discarded
*  itself. Aborts are expected under churn (never counted as errors). */
var GenerationBuildAborted = class extends Error {
	constructor(message) {
		super(message);
		this.name = "GenerationBuildAborted";
	}
};
var GenerationBuilder = class {
	deps;
	/** Abort handle for the in-flight generation build's worker (stage 6):
	*  close() and the maintenance scheduler cancel through it. Non-private
	*  (package-internal by convention): MiniDb's close path reads it through
	*  a private view. */
	genBuildAbort = null;
	/** The in-flight generation build's mutation queue registration (stage 5):
	*  while non-null, applyOp (and expire()'s TTL rewrite) push every applied
	*  op here so the build's detached states converge on the exact checkpoint.
	*  `wal` pins the WAL identity the build measured — a compaction rotation
	*  replaces it and aborts the build (its disk refs would point into rotated
	*  files). `aborted` is set by the rollback path (restoreGroupKey), which
	*  mutates the store outside applyOp and therefore outside the queue.
	*  Non-private: the owner's write paths feed it through a shared reference. */
	genBuild = null;
	/** Single-flight guard for generation builds (open-time background builds
	*  dedupe onto it; a compaction-triggered build awaits an in-flight one —
	*  which the rotation just aborted — before starting fresh). close() drains
	*  it before releasing resources. Non-private (see genBuildAbort). */
	genBuildPromise = null;
	/** The generation this instance loaded at open or last published (null when
	*  running on the legacy recovery path). Stable status surface — see
	*  getIndexGeneration(). Non-private (see genBuildAbort). */
	generationInfo = null;
	loader;
	constructor(deps) {
		this.deps = deps;
		this.loader = new GenerationLoader(deps, (info) => {
			this.generationInfo = info;
		});
	}
	/** The generation-load entry point from open() (see
	*  GenerationLoader.tryLoadGeneration). */
	async tryLoadGeneration(mode) {
		return this.loader.tryLoadGeneration(mode);
	}
	/** Single-flight generation build entry point. 'open' — and the
	*  opportunistic 'wal-growth'/'close' kicks — dedupe onto an in-flight
	*  build; 'compact'/'manual' await the in-flight one (a rotation or their
	*  own trigger just made it abort) and then build fresh. The build itself
	*  runs as a maintenance-scheduler task (stage 6): mutual exclusion with
	*  compaction, disk preflight, and shutdown cancellation. */
	async buildGeneration(trigger) {
		if (this.deps.readOnly() || !this.deps.indexGenerationsEnabled()) return;
		if (this.deps.state() !== "open") return;
		if (this.genBuildPromise) {
			if (trigger === "open" || trigger === "wal-growth" || trigger === "close") return this.genBuildPromise;
			if (this.deps.maintenanceTaskCtx() !== null && this.deps.maintenance().hasQueued("generation-build")) return;
			await this.genBuildPromise.catch(() => {});
		}
		const run = this.deps.maintenance().submit("generation-build", (ctx) => this.runGenerationBuild(ctx));
		this.genBuildPromise = run;
		try {
			await run;
		} finally {
			if (this.genBuildPromise === run) this.genBuildPromise = null;
		}
	}
	/** The build itself: detached-state walk + mutation queue + seal + file
	*  writes + atomic publish, then retention cleanup. See the section header.
	*
	*  Stage 6: for BUILT-IN-tokenizer text indexes on a large-enough corpus
	*  the postings artifacts (tokenization, aggregation, segmented external
	*  merge, dictionary + base-docs images) are produced by a worker thread
	*  against the pinned checkpoint (worker/text-build-core.ts); the main
	*  thread verifies the worker's output (sanity + streaming crc) and swaps
	*  the live base in via commitRebase, and the stage-5 atomic publish stays
	*  the safety boundary — the worker only ever writes inside the tmp
	*  generation directory. Custom-tokenizer indexes and small corpora stay
	*  on the in-thread staged build; a deployment without the worker file —
	*  or a worker-slot drought that outlasts the bounded queue wait — hosts
	*  the SAME bounded core inline instead. */
	async runGenerationBuild(ctx) {
		const t0 = performance.now();
		const gens = generationsDir(this.deps.dir());
		const prevCurrent = await readCurrent(this.deps.dir());
		const existing = await listGenerations(this.deps.dir());
		const id = generationId(Math.max(prevCurrent ? existing.find((g) => g.id === prevCurrent)?.n ?? 0 : 0, existing[0]?.n ?? 0) + 1);
		const tmpName = `${id}.tmp-${process.pid}`;
		const tmpDir = path.join(gens, tmpName);
		const gb = {
			queue: [],
			bytes: 0,
			wal: this.deps.wal(),
			aborted: false
		};
		const dtB = new DtIndex();
		const secB = new IndexManager();
		for (const d of this.deps.indexes.list()) secB.create(d.name, d);
		const cmpB = new CompoundIndexManager();
		for (const d of this.deps.compound.list()) cmpB.create(d.name, {
			groupBy: d.groupBy,
			orderBy: d.orderBy,
			orderType: d.orderType
		});
		const imageRecords = /* @__PURE__ */ new Map();
		const textBuilds = /* @__PURE__ */ new Map();
		/** Dirty text indexes assigned to the stage-6 worker build (their live
		*  rebase capture starts at the seal; the base arrives from the worker). */
		const workerTargets = /* @__PURE__ */ new Map();
		/** Clean text indexes (empty write buffer): no staged rebuild — the
		*  current base is re-published wholesale (hard link + live-state
		*  serialization), the generation-era form of the old needsRebuild skip.
		*  A compaction over a static corpus therefore never re-tokenizes it. */
		const textClean = /* @__PURE__ */ new Map();
		const drainQueue = () => {
			if (gb.queue.length === 0) return;
			const ops = gb.queue.splice(0);
			gb.bytes = 0;
			for (const op of ops) if (op.type === 1) {
				imageRecords.set(op.pk, {
					ref: {
						kind: "memory",
						value: op.value
					},
					expireAt: op.expireAt,
					dt: op.dtNorm
				});
				dtB.set(op.pk, op.dtNorm);
				if (!op.storeOnly) {
					secB.remove(op.pk);
					if (this.deps.indexable(op.canonical)) secB.add(op.pk, op.canonical);
					cmpB.remove(op.pk);
					cmpB.add(op.pk, op.canonical, op.dtNorm);
				}
			} else {
				imageRecords.delete(op.pk);
				dtB.del(op.pk);
				secB.remove(op.pk);
				cmpB.remove(op.pk);
			}
		};
		const checkAlive = () => {
			if (gb.aborted) throw new GenerationBuildAborted("store rewound by a WAL rollback");
			if (this.deps.wal() !== gb.wal) throw new GenerationBuildAborted("compaction rotation replaced the WAL");
			if (this.deps.state() !== "open") throw new GenerationBuildAborted("instance is closing");
			if (gb.queue.length > 1e6 || gb.bytes > 536870912) throw new GenerationBuildAborted("write storm outran the build");
		};
		const aborter = new AbortController();
		this.genBuildAbort = aborter;
		const onCtxAbort = () => aborter.abort();
		ctx.signal.addEventListener("abort", onCtxAbort, { once: true });
		let workerHandle = null;
		let workerSlotRelease = null;
		/** Integrity records of the worker-produced artifacts, per index name
		*  (the manifest records THESE, the files already verified). */
		const workerResults = /* @__PURE__ */ new Map();
		const files = {};
		let sealedOffset = 0;
		try {
			await fs$1.mkdir(tmpDir, { recursive: true });
			const workerOk = this.deps.textBuildWorkerEnabled() && !this.deps.textWorkerDisabled();
			for (const [name, ti] of this.deps.textRegistry.text) try {
				if (!ti.needsRebuild()) {
					textClean.set(name, ti);
					continue;
				}
				if (workerOk && !ti.hasCustomTokenizer && this.deps.store().size >= 4096) {
					workerTargets.set(name, {
						ti,
						def: this.deps.textRegistry.textDefs.find((d) => d.name === name)
					});
					continue;
				}
				textBuilds.set(name, {
					ti,
					b: ti.beginBuild({ postingsPath: path.join(tmpDir, textPostingsFile(name)) })
				});
			} catch {}
			this.genBuild = gb;
			let docsSinceYield = 0;
			let tokensSinceYield = 0;
			const needValues = secB.indexes.size > 0 || cmpB.indexes.size > 0 || textBuilds.size > 0;
			for (const kstr of this.deps.store().rawKeys()) {
				const rec = this.deps.store().map.get(kstr);
				if (!rec) continue;
				imageRecords.set(kstr, {
					ref: rec.ref,
					expireAt: rec.expireAt,
					dt: rec.dt
				});
				dtB.set(kstr, rec.dt);
				if (needValues) {
					let buf;
					if (rec.ref.kind === "memory") buf = rec.ref.value;
					else {
						const reader = this.deps.getValueReader();
						if (!reader) throw new Error("ValueReader is not open");
						buf = reader.read(rec.ref.loc);
					}
					const doc = this.deps.decode(buf);
					if (this.deps.indexable(doc)) {
						secB.add(kstr, doc);
						for (const { b } of textBuilds.values()) tokensSinceYield += b.add(kstr, doc);
					}
					cmpB.add(kstr, doc, rec.dt);
				}
				if (++docsSinceYield >= 512 || tokensSinceYield >= 5e5) {
					docsSinceYield = 0;
					tokensSinceYield = 0;
					drainQueue();
					checkAlive();
					await yieldToLoop();
				}
			}
			drainQueue();
			checkAlive();
			this.genBuild = null;
			sealedOffset = gb.wal.appendOffset;
			if (workerTargets.size > 0) for (const [, { ti }] of workerTargets) ti.beginRebase();
			await gb.wal.flush();
			checkAlive();
			const textStates = /* @__PURE__ */ new Map();
			for (const [name, tb] of textBuilds) {
				await tb.b.commit();
				textStates.set(name, await tb.ti.exportImageStateAsync());
				checkAlive();
			}
			if (workerTargets.size > 0) {
				const snapPath = path.join(this.deps.dir(), SNAPSHOT_FILE);
				const walAnchor = fs.statSync(this.deps.walPath());
				let snapAnchor = null;
				try {
					snapAnchor = fs.statSync(snapPath);
				} catch (error) {
					if (error.code !== "ENOENT") throw error;
				}
				const workerAvailable = textBuildWorkerAvailable();
				let inlineReason;
				if (workerAvailable) {
					try {
						workerSlotRelease = await defaultWorkerSlots.acquireBounded(this.deps.textBuildSlotWaitMs(), aborter.signal);
					} catch (error) {
						if (error instanceof MaintenanceCancelledError) throw new GenerationBuildAborted("worker slot wait cancelled");
						throw error;
					}
					if (workerSlotRelease === null) inlineReason = "slot-pressure";
				} else inlineReason = "runtime-unavailable";
				const inline = workerSlotRelease === null;
				workerHandle = startWorkerTextBuild({
					snapshotPath: snapAnchor ? snapPath : null,
					walPath: this.deps.walPath(),
					walOffset: sealedOffset,
					walDev: walAnchor.dev,
					walIno: walAnchor.ino,
					snapshotDev: snapAnchor?.dev ?? 0,
					snapshotIno: snapAnchor?.ino ?? 0,
					indexes: [...workerTargets].map(([name, { def }]) => ({
						name,
						fields: def?.fields ?? null,
						tokenizer: def?.tokenizer === "ngram" ? "ngram" : "default",
						postingsPath: path.join(tmpDir, textPostingsFile(name)),
						dictionaryPath: path.join(tmpDir, textDictionaryFile(name)),
						baseDocsPath: path.join(tmpDir, `${textDocsFile(name)}.base`)
					})),
					memoryBudgetBytes: this.deps.textBuildMemoryBytes()
				}, {
					signal: aborter.signal,
					shouldAbort: () => gb.aborted || this.deps.wal() !== gb.wal || this.deps.state() !== "open",
					inline,
					inlineReason,
					onFallback: (reason) => {
						this.deps.stats.textWorkerFallbacks++;
						this.deps.stats.lastTextWorkerFallback = reason;
					}
				});
				workerHandle.promise.catch(() => {});
			}
			const cleanPostings = /* @__PURE__ */ new Map();
			for (const [name, ti] of textClean) {
				const src = ti.currentPostingsPath;
				const info = ti.postingsFileInfo;
				if (src && info) {
					cleanPostings.set(name, {
						src,
						info
					});
					textStates.set(name, await ti.exportImageStateAsync());
				}
			}
			const sortedImageKeys = [...imageRecords.keys()].toSorted();
			const storeRes = await writeStoreImage(path.join(tmpDir, STORE_IMAGE_FILE), (function* () {
				for (const kstr of sortedImageKeys) {
					const r = imageRecords.get(kstr);
					yield {
						kstr,
						ref: r.ref,
						expireAt: r.expireAt,
						dt: r.dt
					};
				}
			})());
			files[STORE_IMAGE_FILE] = {
				bytes: storeRes.bytes,
				crc32: storeRes.crc32
			};
			files[DT_INDEX_FILE] = await writeDtIndexImage(path.join(tmpDir, DT_INDEX_FILE), dtB.exportImage());
			const secImages = secB.exportImage();
			files[SECONDARY_INDEX_FILE] = await writeSecondaryIndexImage(path.join(tmpDir, SECONDARY_INDEX_FILE), secImages);
			const cmpExport = cmpB.exportImage();
			files[COMPOUND_INDEX_FILE] = await writeCompoundIndexImage(path.join(tmpDir, COMPOUND_INDEX_FILE), cmpExport.images);
			if (workerHandle) {
				let result;
				try {
					result = await workerHandle.promise;
				} catch (error) {
					if (error instanceof WorkerTextBuildError && error.aborted) throw new GenerationBuildAborted(`worker build cancelled: ${error.message}`);
					if (!workerHandle.inline) this.deps.stats.textWorkerErrors++;
					throw error;
				}
				checkAlive();
				if (result.scannedLiveKeys > imageRecords.size) throw new Error(`worker build scanned ${result.scannedLiveKeys} live keys > checkpoint image ${imageRecords.size} (pinning protocol violation)`);
				for (const r of result.indexes) {
					const target = workerTargets.get(r.name);
					if (!target) continue;
					const postingsPath = path.join(tmpDir, textPostingsFile(r.name));
					const dictionaryPath = path.join(tmpDir, textDictionaryFile(r.name));
					const baseDocsPath = path.join(tmpDir, `${textDocsFile(r.name)}.base`);
					await verifyFileCrcAsync(postingsPath, r.postingsInfo);
					const dictEntries = (await readTextDictionaryImageAsync(await readGenerationFileCheckedAsync(dictionaryPath, "MDTD", 1, r.dictionaryInfo))).map((e) => [e.term, {
						off: e.off,
						len: e.len,
						df: e.df
					}]);
					const baseDocs = await readBaseDocsImageAsync(await readGenerationFileCheckedAsync(baseDocsPath, BASE_DOCS_MAGIC, 1, r.baseDocsInfo));
					const containers = await TextIndex.prepareRebaseContainers(dictEntries, baseDocs.keys, baseDocs.docLens);
					target.ti.commitRebase({
						postingsPath,
						containers,
						liveCount: r.liveCount,
						postingsFileInfo: r.postingsInfo
					});
					textStates.set(r.name, await target.ti.exportImageStateAsync());
					workerResults.set(r.name, r);
					checkAlive();
				}
				if (!workerHandle.inline) this.deps.stats.textWorkerBuilds++;
			}
			for (const [name, state] of textStates) {
				const workerResult = workerResults.get(name);
				if (workerResult) files[textDictionaryFile(name)] = workerResult.dictionaryInfo;
				else files[textDictionaryFile(name)] = await writeTextDictionaryImage(path.join(tmpDir, textDictionaryFile(name)), (function* () {
					for (const [term, e] of state.dict) yield {
						term,
						off: e.off,
						len: e.len,
						df: e.df
					};
				})());
				const docsImage = {
					keys: state.keys,
					docLens: (() => {
						const out = [];
						for (let i = 0; i < state.keys.length; i++) out.push(state.docLens.get(i));
						return out;
					})(),
					liveCount: state.liveCount,
					removed: [...state.removed],
					delta: [...state.delta].map(([term, m]) => ({
						term,
						docs: [...m].map(([docID, freq]) => ({
							docID,
							freq
						}))
					}))
				};
				files[textDocsFile(name)] = await writeTextDocsImage(path.join(tmpDir, textDocsFile(name)), docsImage);
				const clean = cleanPostings.get(name);
				if (clean) {
					const dst = path.join(tmpDir, textPostingsFile(name));
					try {
						await fs$1.link(clean.src, dst);
					} catch {
						await fs$1.copyFile(clean.src, dst);
					}
					files[textPostingsFile(name)] = clean.info;
				} else if (workerResult) files[textPostingsFile(name)] = workerResult.postingsInfo;
				else {
					const postInfo = textBuilds.get(name)?.ti.postingsFileInfo;
					if (!postInfo) throw new GenerationBuildAborted(`text index "${name}" produced no postings file info`);
					files[textPostingsFile(name)] = postInfo;
				}
			}
			const snapSrc = path.join(this.deps.dir(), SNAPSHOT_FILE);
			let snapSt = null;
			let snapshotLinked = false;
			try {
				snapSt = await fs$1.stat(snapSrc);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			if (snapSt) try {
				await fs$1.link(snapSrc, path.join(tmpDir, GEN_SNAPSHOT_FILE));
				snapshotLinked = true;
			} catch {
				await fs$1.copyFile(snapSrc, path.join(tmpDir, GEN_SNAPSHOT_FILE));
				const h = await fs$1.open(path.join(tmpDir, GEN_SNAPSHOT_FILE), "r");
				try {
					await h.sync().catch((error) => {
						if (error.code !== "EPERM" && error.code !== "ENOTSUP" && error.code !== "EINVAL") throw error;
					});
				} finally {
					await h.close().catch(() => {});
				}
			}
			const walSt = await fs$1.stat(this.deps.walPath());
			const manifest = {
				format: 1,
				id,
				createdAt: Date.now(),
				valueCodec: this.deps.codecName(),
				valueMode: this.deps.valueMode(),
				checkpoint: {
					walOffset: sealedOffset,
					walDev: walSt.dev,
					walIno: walSt.ino,
					walSize: sealedOffset,
					snapshotBytes: snapSt?.size ?? 0,
					snapshotDev: snapSt?.dev ?? 0,
					snapshotIno: snapSt?.ino ?? 0,
					snapshotLinked
				},
				indexDefs: {
					secondary: Object.fromEntries(secImages.map((i) => [i.name, indexDefHash({
						name: i.name,
						field: i.field,
						type: i.type,
						unique: i.unique,
						sparse: i.sparse
					})])),
					compound: Object.fromEntries(cmpExport.images.map((i) => [i.name, indexDefHash({
						name: i.name,
						groupBy: i.groupBy,
						orderBy: i.orderBy,
						orderType: i.orderType
					})])),
					text: Object.fromEntries([...textStates.keys()].map((name) => {
						const def = this.deps.textRegistry.textDefs.find((d) => d.name === name);
						return [name, def ? indexDefHash(TextRegistry.canonicalTextDef(def)) : ""];
					}))
				},
				files,
				counts: {
					records: imageRecords.size,
					dtColumns: dtB.columns().length,
					secondaryIndexes: secImages.length,
					compoundIndexes: cmpExport.images.length,
					textIndexes: textStates.size
				}
			};
			checkAlive();
			await writeManifest(tmpDir, manifest);
			await fsyncDir(tmpDir, {
				strict: true,
				stats: this.deps.stats
			});
			ctx.markPublishing();
			if (process.platform === "win32") {
				for (const [, tb] of textBuilds) {
					tb.ti.basePending = true;
					tb.ti.close();
				}
				for (const [, { ti }] of workerTargets) {
					ti.basePending = true;
					ti.close();
				}
			}
			await publishGeneration(this.deps.dir(), tmpName, id, { stats: this.deps.stats });
			for (const [name, tb] of textBuilds) if (tb.ti.repointPostings(path.join(generationDir(this.deps.dir(), id), textPostingsFile(name)))) {
				tb.ti.basePending = false;
				tb.ti.clearCache();
			}
			for (const [name, { ti }] of workerTargets) if (ti.repointPostings(path.join(generationDir(this.deps.dir(), id), textPostingsFile(name)))) {
				ti.basePending = false;
				ti.clearCache();
			}
			for (const [name, ti] of textClean) {
				if (!cleanPostings.has(name)) continue;
				if (ti.repointPostings(path.join(generationDir(this.deps.dir(), id), textPostingsFile(name)))) {
					ti.basePending = false;
					ti.clearCache();
				}
			}
			this.generationInfo = {
				id,
				createdAt: manifest.createdAt,
				walCheckpoint: sealedOffset,
				records: imageRecords.size
			};
			this.deps.stats.generationBuilds++;
			this.deps.stats.generationBuildDurationMs += performance.now() - t0;
			this.deps.noteBuildSuccess?.();
			const keep = new Set(prevCurrent ? [id, prevCurrent] : [id]);
			cleanupGenerations(this.deps.dir(), keep).catch(() => {});
			for (const name of textStates.keys()) await fs$1.rm(this.deps.textRegistry.textPostingsPath(name), { force: true }).catch(() => {});
			for (const name of workerResults.keys()) await fs$1.rm(path.join(generationDir(this.deps.dir(), id), `${textDocsFile(name)}.base`), { force: true }).catch(() => {});
		} catch (error) {
			if (this.genBuild === gb) this.genBuild = null;
			for (const [, tb] of textBuilds) tb.b.abort();
			for (const [, { ti }] of workerTargets) ti.abortRebase();
			if (workerHandle) await workerHandle.cancel();
			if (error instanceof GenerationBuildAborted) {
				this.deps.stats.generationBuildAborts++;
				this.deps.noteBuildFailure?.();
				return;
			}
			this.deps.stats.generationBuildErrors++;
			this.deps.noteBuildFailure?.(error);
			throw error;
		} finally {
			if (this.genBuild === gb) this.genBuild = null;
			workerSlotRelease?.();
			ctx.signal.removeEventListener("abort", onCtxAbort);
			if (this.genBuildAbort === aborter) this.genBuildAbort = null;
		}
	}
	/** Explicit maintenance (stage 5): build + publish a fresh index generation
	*  now. Writer only. The load path is automatic; this exists for operators
	*  who want to force a checkpoint after a large burst of writes instead of
	*  waiting for the next compaction. */
	async rebuildGeneration() {
		this.deps.ensureOpen();
		this.deps.ensureWritable();
		if (!this.deps.indexGenerationsEnabled()) throw new Error("index generations are disabled (OpenOptions.indexGenerations: false)");
		await this.buildGeneration("manual");
	}
	/** Stable generation status: the generation this instance loaded at open or
	*  last published (null when running on the legacy recovery path). */
	getIndexGeneration() {
		return this.generationInfo ? { ...this.generationInfo } : null;
	}
};
// ../../packages/minidb/src/index-admin.ts
var IndexAdmin = class {
	deps;
	constructor(deps) {
		this.deps = deps;
	}
	/** One Store walk feeds every staged builder (the open-time full rebuild).
	*  dt comes from record metadata (never decoded); the value is decoded at
	*  most once per record and only when a value-derived index (secondary /
	*  compound / text) actually exists — an index-less open performs a
	*  metadata-only walk. Text indexes whose base build is DEFERRED (the
	*  bounded background build, see MiniDb.deferOpenTextBuilds) are skipped
	*  via `skipTextIndex`: they get neither a staged builder nor feeding. */
	async rebuildAllIndexes(opts = {}) {
		const dtB = this.deps.dt.beginRebuild();
		const secB = this.deps.indexes.indexes.size > 0 ? this.deps.indexes.beginRebuild() : null;
		const cmpB = this.deps.compound.indexes.size > 0 ? this.deps.compound.beginRebuild() : null;
		const textBs = [];
		for (const [name, ti] of this.deps.textRegistry.text) {
			if (opts.skipTextIndex?.(name)) continue;
			textBs.push({ b: ti.beginBuild() });
		}
		const needValues = secB !== null || cmpB !== null || textBs.length > 0;
		const t0 = performance.now();
		let docsSinceYield = 0;
		try {
			for (const rec of this.deps.store().rawRecords()) {
				if (++docsSinceYield >= 512) {
					docsSinceYield = 0;
					await yieldToLoop();
				}
				dtB.add(rec.kstr, rec.dt);
				if (!needValues) continue;
				const value = this.deps.decode(rec.readValue());
				this.deps.stats.indexRebuildDecoded++;
				secB?.add(rec.kstr, value);
				cmpB?.add(rec.kstr, value, rec.dt);
				if (this.deps.indexable(value)) for (const { b } of textBs) b.add(rec.kstr, value);
			}
		} catch (error) {
			for (const { b } of textBs) b.abort();
			throw error;
		}
		this.deps.stats.indexRebuildDurationMs += performance.now() - t0;
		const t1 = performance.now();
		try {
			for (const { b } of textBs) await b.commit();
		} catch (error) {
			for (const { b } of textBs) b.abort();
			throw error;
		}
		this.deps.stats.textRebuildDurationMs += performance.now() - t1;
		secB?.commit();
		cmpB?.commit();
		dtB.commit();
	}
	async loadIndexDefinitions(indexPath) {
		try {
			const raw = await fs$1.readFile(indexPath, "utf8");
			for (const d of JSON.parse(raw)) this.deps.indexes.create(d.name, d);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	async loadCompoundIndexDefinitions(compoundIndexPath) {
		try {
			const raw = await fs$1.readFile(compoundIndexPath, "utf8");
			for (const d of JSON.parse(raw)) this.deps.compound.create(d.name, {
				groupBy: d.groupBy,
				orderBy: d.orderBy,
				orderType: d.orderType
			});
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	async createIndex(name, opts) {
		this.deps.ensureOpen();
		this.deps.ensureWritable();
		if (this.deps.codecName() !== "json") throw new Error("secondary indexes require valueCodec: \"json\"");
		await this.deps.secondaryDefChain(async () => {
			this.deps.indexes.stage(name, opts);
			try {
				this.deps.indexes.rebuildStaged(name, this.deps.liveRecordsRaw());
				this.deps.indexes.assertUniqueValid(name);
				await this.deps.persistIndexDefinitions([...this.deps.indexes.list(), this.deps.indexes.stagedInfo(name)]);
			} catch (error) {
				this.deps.indexes.discardStaged(name);
				throw error;
			}
			this.deps.indexes.publish(name);
		});
	}
	async dropIndex(name) {
		this.deps.ensureOpen();
		this.deps.ensureWritable();
		return this.deps.secondaryDefChain(async () => {
			await this.deps.persistIndexDefinitions(this.deps.indexes.list().filter((i) => i.name !== name));
			return this.deps.indexes.drop(name);
		});
	}
	listIndexes() {
		return this.deps.indexes.list();
	}
	findEq(name, value) {
		this.deps.ensureOpen();
		return this.deps.indexes.findEq(name, value).map((pk) => ({
			key: fromKStr$1(pk),
			value: this.deps.decode(this.deps.store().get(pk))
		})).filter((r) => r.value !== void 0);
	}
	findRange(name, opts) {
		this.deps.ensureOpen();
		return this.deps.indexes.findRange(name, opts).map(({ pk, value }) => ({
			key: fromKStr$1(pk),
			value: this.deps.decode(this.deps.store().get(pk)),
			field: value
		})).filter((r) => r.value !== void 0);
	}
	async createCompoundIndex(name, def) {
		this.deps.ensureOpen();
		this.deps.ensureWritable();
		if (this.deps.codecName() !== "json") throw new Error("compound indexes require valueCodec: \"json\"");
		await this.deps.compoundDefChain(async () => {
			this.deps.compound.stage(name, def);
			try {
				this.deps.compound.rebuildStaged(name, this.deps.liveRecords());
				await this.deps.persistCompoundIndexDefinitions([...this.deps.compound.list(), this.deps.compound.stagedInfo(name)]);
			} catch (error) {
				this.deps.compound.discardStaged(name);
				throw error;
			}
			this.deps.compound.publish(name);
		});
	}
	async dropCompoundIndex(name) {
		this.deps.ensureOpen();
		this.deps.ensureWritable();
		return this.deps.compoundDefChain(async () => {
			await this.deps.persistCompoundIndexDefinitions(this.deps.compound.list().filter((i) => i.name !== name));
			return this.deps.compound.drop(name);
		});
	}
	listCompoundIndexes() {
		return this.deps.compound.list();
	}
	/**
	* Ordered range within a group, e.g. "sessions in workspace X ordered by
	* updatedAt". O(log N + limit) — no full sort.
	*/
	compoundRange(name, groupValue, opts = {}) {
		this.deps.ensureOpen();
		return this.deps.compound.range(name, groupValue, opts).map(({ key, orderValue }) => ({
			key: fromKStr$1(key),
			value: this.deps.decode(this.deps.store().get(key)),
			orderValue
		})).filter((r) => r.value !== void 0);
	}
};
// ../../packages/minidb/src/lifecycle-status.ts
/** The mutable tracker behind MiniDb.lifecycleStatus(); driven by the
*  lifecycle facets through the LifecycleHost / GenerationLoaderDeps views
*  (same shared-by-reference discipline as the stats object). */
var LifecycleTracker = class {
	current = "no-generation";
	transitions = ["no-generation"];
	completedAt = null;
	pending = /* @__PURE__ */ new Set();
	textSources = /* @__PURE__ */ new Map();
	phases = {
		openMs: 0,
		generationCandidateLoadMs: 0,
		storeImageLoadMs: 0,
		nonTextImageLoadMs: 0,
		textImageLoadMs: 0,
		postingsIntegrityCheckMs: 0,
		walScanMs: 0,
		walApplyMs: 0,
		fullRecoveryMs: 0,
		textRebuildMs: 0
	};
	get state() {
		return this.current;
	}
	transition(next) {
		if (next === this.current) return;
		this.current = next;
		this.transitions.push(next);
	}
	/** Add `ms` to one phase (phases accumulate across candidates/passes). */
	time(phase, ms) {
		this.phases[phase] += ms;
	}
	noteTextIndexSource(name, source) {
		this.textSources.set(name, source);
	}
	/** A text index's base build was deferred to the background task: pending
	*  from here until the build commits (finishOpen maps this to 'degraded'). */
	markTextIndexPending(name) {
		this.pending.add(name);
		this.textSources.set(name, "deferred");
	}
	/** The deferred build for one index committed (source = its hosting mode);
	*  the last pending clear flips a completed open back to 'ready'. A finally
	*  failed build stays pending — the index keeps raising
	*  TextIndexBuildingError, which IS the degraded state. */
	clearTextIndexPending(name, source) {
		this.pending.delete(name);
		this.textSources.set(name, source);
		if (this.pending.size === 0 && this.completedAt !== null && this.current === "degraded") this.transition("ready");
	}
	/** open() is about to return: servable ('ready') unless a deferred text
	*  build is still pending ('degraded'). */
	finishOpen() {
		this.completedAt = Date.now();
		this.transition(this.pending.size > 0 ? "degraded" : "ready");
	}
	snapshot() {
		return {
			state: this.current,
			path: [...this.transitions],
			openedAt: this.completedAt,
			phases: { ...this.phases },
			textIndexes: Object.fromEntries(this.textSources),
			pendingTextIndexes: [...this.pending]
		};
	}
};
// ../../packages/minidb/src/lockfile.ts
var LockError = class extends Error {
	code = "ELOCKED";
	constructor(message) {
		super(message);
		this.name = "LockError";
	}
};
function pidAlive(pid) {
	if (!pid || typeof pid !== "number") return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}
const HELD = /* @__PURE__ */ new Set();
let sidecarSeq = 0;
const nextSidecarSeq = () => ++sidecarSeq;
let exitHooked = false;
const TAKEOVER_SETTLE_BASE_MS = 60;
const TAKEOVER_SETTLE_MAX_MS = 2e3;
function hookExit() {
	if (exitHooked) return;
	exitHooked = true;
	process.on("beforeExit", () => {
		for (const lock of HELD) lock.releaseSync();
	});
}
var LockFile = class {
	path;
	held = false;
	/** Token of the current acquire attempt: minted fresh per attempt,
	*  carried by every file this instance publishes (lock/bid/watch), and the
	*  sole ownership criterion (`mine`). Null before the first acquire(). */
	token = null;
	/** The held instance's ownership token (undefined unless currently held).
	*  Lets a host supervising this database from another thread learn WHO
	*  holds the lock file without parsing it — worker threads share the main
	*  process pid, so the pid in the lock line cannot distinguish them. */
	get heldToken() {
		return this.held && this.token !== null ? this.token : void 0;
	}
	/** Serializes acquire/renew/release (the shared promise-chain pattern of
	*  serialize.ts): each op's whole read-check-write completes before the next
	*  one starts, so a renew already in flight finishes before a release
	*  unlinks. */
	serialized = createSerializer();
	constructor(path) {
		this.path = path;
	}
	/** File body for every file this instance publishes (lock, bid, watch). */
	payload() {
		return JSON.stringify({
			pid: process.pid,
			ts: Date.now(),
			token: this.token
		});
	}
	/** Try to acquire the lock exactly once. Returns true when this call created
	*  the lock file, either directly or by winning a stale-lock takeover. Returns
	*  false whenever the lock was already held at attempt time — by a live owner
	*  or by a competing takeover. After observing a held lock this call never
	*  re-races: callers that want to wait retry acquire() at a higher level
	*  (see the cluster lock pool). */
	async acquire() {
		return this.serialized(() => this.acquireOnce());
	}
	async acquireOnce() {
		if (this.held) return true;
		this.token = `${process.pid}:${randomUUID()}`;
		const watch = `${this.path}.watch-${process.pid}-${nextSidecarSeq()}`;
		await fs$1.writeFile(watch, this.payload());
		try {
			await this.reapDeadWatches();
			if (await this.tryCreate()) return true;
			const seen = await this.inspect();
			if (seen === null || seen.alive) return false;
			const bid = `${this.path}.bid-${process.pid}-${nextSidecarSeq()}`;
			const attemptStart = Date.now();
			try {
				await fs$1.writeFile(bid, this.payload());
				for (let attempt = 0;; attempt++) {
					const gate = await this.inspect();
					if (gate === null || gate.alive || gate.mine) {
						await fs$1.unlink(bid).catch(() => {});
						return false;
					}
					try {
						await fs$1.rename(bid, this.path);
						break;
					} catch (error) {
						const code = error.code;
						if (!(code === "EPERM" && process.platform === "win32" && attempt < 50)) {
							await fs$1.unlink(bid).catch(() => {});
							if (code === "EEXIST" || code === "EPERM") return false;
							throw error;
						}
						await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 30)));
					}
				}
			} catch (error) {
				await fs$1.unlink(bid).catch(() => {});
				throw error;
			}
			const elapsedMs = Date.now() - attemptStart;
			let settleMs = Math.min(TAKEOVER_SETTLE_MAX_MS, Math.max(TAKEOVER_SETTLE_BASE_MS, elapsedMs * 4));
			for (;;) {
				await new Promise((resolve) => setTimeout(resolve, settleMs));
				const cur = await this.inspect();
				if (cur === null || !cur.mine) return false;
				if (await this.hasLiveForeignWatch(path.basename(watch))) {
					settleMs = Math.min(TAKEOVER_SETTLE_MAX_MS, settleMs * 2);
					continue;
				}
				const verify = await this.inspect();
				if (verify === null || !verify.mine) return false;
				break;
			}
			this.markHeld();
			return true;
		} finally {
			await fs$1.unlink(watch).catch(() => {});
		}
	}
	/** Delete watch registrations whose owner pid is no longer alive. */
	async reapDeadWatches() {
		const dir = path.dirname(this.path);
		const prefix = `${path.basename(this.path)}.watch-`;
		for (const f of await fs$1.readdir(dir).catch(() => [])) {
			if (!f.startsWith(prefix)) continue;
			const pid = Number(f.slice(prefix.length).split("-")[0]);
			if (Number.isInteger(pid) && pid !== process.pid && !pidAlive(pid)) await fs$1.unlink(path.join(dir, f)).catch(() => {});
		}
	}
	/** True when any OTHER owner's liveness watch exists (reaping dead ones on
	*  sight). "Foreign" is by token, not pid: a same-process competitor's
	*  registration counts, so the settle loop waits for the competitor's whole
	*  attempt to finish instead of claiming on stale evidence. A legacy
	*  tokenless watch line cannot be told apart from our own when its pid is
	*  ours, so it keeps the old pid-based exclusion. `ownWatch` (basename) is
	*  this instance's own registration — never foreign. A registration that
	*  cannot be read is conservatively live: skipping it could let us claim
	*  on incomplete evidence and re-open the double-win this check closes. */
	async hasLiveForeignWatch(ownWatch) {
		const dir = path.dirname(this.path);
		const prefix = `${path.basename(this.path)}.watch-`;
		for (const f of await fs$1.readdir(dir).catch(() => [])) {
			if (!f.startsWith(prefix) || f === ownWatch) continue;
			const pid = Number(f.slice(prefix.length).split("-")[0]);
			if (!Number.isInteger(pid)) continue;
			let token;
			try {
				token = JSON.parse(await fs$1.readFile(path.join(dir, f), "utf8")).token;
			} catch {
				return true;
			}
			if (token !== void 0 ? token === this.token : pid === process.pid) continue;
			if (pidAlive(pid)) return true;
			await fs$1.unlink(path.join(dir, f)).catch(() => {});
		}
		return false;
	}
	/** Atomic create-if-absent publish: tmp write + hard link (EEXIST-safe). */
	async tryCreate() {
		const tmp = `${this.path}.tmp-${process.pid}-${nextSidecarSeq()}`;
		try {
			await fs$1.writeFile(tmp, this.payload());
			await fs$1.link(tmp, this.path);
			this.markHeld();
			return true;
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			return false;
		} finally {
			await fs$1.unlink(tmp).catch(() => {});
		}
	}
	/** Read the lock file and decide its state. null = the file vanished.
	*  `mine` is decided by the owner token, `alive` still by pid liveness: a
	*  legacy tokenless line is never mine and follows the stale rules. */
	async inspect() {
		let raw;
		let st;
		try {
			[raw, st] = await Promise.all([fs$1.readFile(this.path, "utf8"), fs$1.stat(this.path)]);
		} catch (error) {
			if (error.code === "ENOENT") return null;
			throw error;
		}
		let pid;
		let token;
		try {
			const parsed = JSON.parse(raw);
			pid = parsed.pid;
			token = parsed.token;
		} catch {
			pid = void 0;
		}
		return {
			ino: st.ino,
			alive: pidAlive(pid),
			mine: this.token !== null && token === this.token
		};
	}
	inspectSync() {
		let raw;
		let st;
		try {
			raw = fs.readFileSync(this.path, "utf8");
			st = fs.statSync(this.path);
		} catch (error) {
			if (error.code === "ENOENT") return null;
			throw error;
		}
		let pid;
		let token;
		try {
			const parsed = JSON.parse(raw);
			pid = parsed.pid;
			token = parsed.token;
		} catch {
			pid = void 0;
		}
		return {
			ino: st.ino,
			alive: pidAlive(pid),
			mine: this.token !== null && token === this.token
		};
	}
	/** Refresh the lock timestamp (proves liveness to processes inspecting the
	*  lock file). No-op when the lock is not held. Serialized with
	*  acquire/release: `held` is re-checked inside the chain, and a release
	*  queued behind this renew unlinks only after the write landed.
	*
	*  When the on-disk line is already this instance's own (exactly the same
	*  bytes length), the refresh is an OVERWRITE IN PLACE of the same range.
	*  Replacing the lock by rename (write-tmp-then-rename) is not usable there
	*  on Windows: `tryCreate` publishes the lock through `fs.link`, and Bun
	*  keeps the linked file's handle until GC, which makes every rename over
	*  that path fail with EPERM for up to seconds right after acquire — longer
	*  than any sane retry budget. An in-place overwrite (a) never truncates, so
	*  a crash mid-renew cannot leave a stale-looking lock file behind, and
	*  (b) rewrites only the timestamp digits: payload length and every other
	*  byte (pid, token, keys) stay identical, so a concurrent reader always
	*  parses either the old or the new line with the same owner identity.
	*  Anything else on disk (a vanished lock, a foreign line of another length)
	*  still takes the rename path, which replaces the file wholesale. */
	async renew() {
		return this.serialized(async () => {
			if (!this.held) return;
			const payload = this.payload();
			const stat = await fs$1.stat(this.path).catch(() => null);
			if (stat !== null && stat.size === Buffer.byteLength(payload, "utf8")) {
				const handle = await fs$1.open(this.path, "r+");
				try {
					await handle.write(payload, 0, "utf8");
				} finally {
					await handle.close();
				}
				return;
			}
			const tmp = `${this.path}.tmp-${process.pid}-${nextSidecarSeq()}`;
			await fs$1.writeFile(tmp, payload);
			await renameReplace(tmp, this.path, { retries: 20 });
		});
	}
	markHeld() {
		this.held = true;
		HELD.add(this);
		hookExit();
	}
	async release() {
		return this.serialized(async () => {
			if (!this.held) return;
			if ((await this.inspect())?.mine) await fs$1.unlink(this.path).catch(() => {});
			this.held = false;
			HELD.delete(this);
		});
	}
	/** Best-effort sync release for the exit hook. */
	releaseSync() {
		if (!this.held) return;
		try {
			if (this.inspectSync()?.mine) fs.unlinkSync(this.path);
		} catch {}
		this.held = false;
		HELD.delete(this);
	}
};
// ../../packages/minidb/src/options.ts
const FSYNC_POLICIES = /* @__PURE__ */ new Set([
	"always",
	"everysec",
	"no"
]);
const MAX_MEMORY_POLICIES = /* @__PURE__ */ new Set(["reject", "evict-lru"]);
const RECOVERY_MODES = /* @__PURE__ */ new Set(["resync", "strict"]);
/**
* Aggregation memory budget for a full-text build when the caller omits
* `textBuildMemoryBytes`. The `MiniDb` class field references the same
* constant, so the documented default (`types.ts`) cannot drift from the
* effective one again: a build that exceeds the budget flushes sorted
* segments and the final build becomes an external merge.
*/
const DEFAULT_TEXT_BUILD_MEMORY_BYTES = 134217728;
function positiveFinite(label, value, fallback) {
	if (value === void 0) {
		if (!Number.isFinite(fallback)) throw new RangeError(`${label} must be a positive finite number`);
		return fallback;
	}
	if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be a positive finite number`);
	return value;
}
function nonNegativeFinite(label, value, fallback) {
	if (value === void 0) {
		if (!Number.isFinite(fallback)) throw new RangeError(`${label} must be a finite number >= 0`);
		return fallback;
	}
	if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be a finite number >= 0`);
	return value;
}
function oneOf(label, value, allowed, fallback) {
	if (value === void 0) return fallback;
	if (!allowed.has(value)) {
		const list = [...allowed].map((entry) => JSON.stringify(entry)).join(", ");
		throw new RangeError(`unknown ${label}: ${JSON.stringify(value)} (expected one of ${list})`);
	}
	return value;
}
/**
* Validate every `MiniDb.open()` option at the open boundary.
*
* Each option's allowed values live here rather than at its first use, so a
* new enum gains a whitelist entry (or a RangeError at open time) instead of
* silently degrading: an unrecognized `valueCodec` used to leave `codec`
* undefined until the first write, an unrecognized `maxMemoryPolicy` fell back
* to `reject` behaviour, and an unrecognized `recovery` fell back to `resync`.
*/
function parseMiniDbOptions(opts) {
	if (!opts || !opts.dir) throw new TypeError("MiniDb.open: opts.dir is required");
	const codecName = opts.valueCodec === void 0 ? "buffer" : Object.prototype.hasOwnProperty.call(CODECS, opts.valueCodec) ? opts.valueCodec : (() => {
		const list = Object.keys(CODECS).map((entry) => JSON.stringify(entry)).join(", ");
		throw new RangeError(`unknown valueCodec: ${JSON.stringify(String(opts.valueCodec))} (expected one of ${list})`);
	})();
	const requestedMode = opts.valueMode ?? "memory";
	if (requestedMode !== "memory" && requestedMode !== "disk" && requestedMode !== "auto") throw new RangeError(`unknown valueMode: ${String(requestedMode)}`);
	const resolvedMode = requestedMode;
	const maxMemoryBytes = opts.maxMemoryBytes ?? null;
	if (maxMemoryBytes !== null && (!Number.isFinite(maxMemoryBytes) || maxMemoryBytes <= 0)) throw new RangeError("maxMemoryBytes must be a positive finite number");
	return {
		dir: opts.dir,
		readOnly: opts.readOnly === true,
		fsyncPolicy: oneOf("fsyncPolicy", opts.fsyncPolicy, FSYNC_POLICIES, "everysec"),
		syncIntervalMs: nonNegativeFinite("syncIntervalMs", opts.syncIntervalMs, 1e3),
		codecName,
		valueMode: resolvedMode,
		compactThresholdBytes: nonNegativeFinite("compactThresholdBytes", opts.compactThresholdBytes, 67108864),
		autoCompact: opts.autoCompact ?? true,
		maxMemoryBytes,
		maxMemoryPolicy: oneOf("maxMemoryPolicy", opts.maxMemoryPolicy, MAX_MEMORY_POLICIES, "reject"),
		indexGenerationsEnabled: opts.indexGenerations ?? true,
		textBuildWorkerEnabled: opts.textBuildWorker ?? true,
		deferTextBuildsEnabled: opts.deferOpenTextBuilds ?? true,
		textBuildMemoryBytes: positiveFinite("textBuildMemoryBytes", opts.textBuildMemoryBytes, DEFAULT_TEXT_BUILD_MEMORY_BYTES),
		maintenanceIoConcurrency: positiveFinite("maintenanceIoConcurrency", opts.maintenanceIoConcurrency, 4),
		recovery: oneOf("recovery", opts.recovery, RECOVERY_MODES, "resync"),
		activeExpireIntervalMs: nonNegativeFinite("activeExpireIntervalMs", opts.activeExpireIntervalMs, 1e3)
	};
}
/**
* Validate a TTL expressed in milliseconds. Rejects non-finite values (shared
* with the write path) and negatives, which used to mean "already expired" and
* silently dropped the value on the next read.
*/
function parseTtlMs(ttlMs) {
	if (ttlMs === void 0) return void 0;
	if (!Number.isFinite(ttlMs)) throw new RangeError("ttl must be a finite number of milliseconds");
	if (ttlMs < 0) throw new RangeError("ttl must be a non-negative number of milliseconds");
	return ttlMs;
}
// ../../packages/minidb/src/store.ts
const toKStr = (key) => typeof key === "string" ? key : Buffer.from(key).toString("binary");
const fromKStr = (kstr) => Buffer.from(kstr, "binary");
const DISK_REF_BYTES = 64;
var MinHeap = class {
	a = [];
	get size() {
		return this.a.length;
	}
	clear() {
		this.a = [];
	}
	peek() {
		return this.a[0];
	}
	push(item) {
		const a = this.a;
		a.push(item);
		let i = a.length - 1;
		while (i > 0) {
			const p = i - 1 >> 1;
			if (a[p].t <= a[i].t) break;
			[a[p], a[i]] = [a[i], a[p]];
			i = p;
		}
	}
	pop() {
		const a = this.a;
		const top = a[0];
		const last = a.pop();
		if (a.length > 0 && last !== void 0) {
			a[0] = last;
			let i = 0;
			while (true) {
				let s = i;
				const l = 2 * i + 1;
				const r = l + 1;
				if (l < a.length && a[l].t < a[s].t) s = l;
				if (r < a.length && a[r].t < a[s].t) s = r;
				if (s === i) break;
				[a[s], a[i]] = [a[i], a[s]];
				i = s;
			}
		}
		return top;
	}
};
var Store = class {
	map = /* @__PURE__ */ new Map();
	order = new SkipList({ compareKey: cmpString });
	heap = new MinHeap();
	seq = 0;
	/** Approximate bytes held by live + expired-not-yet-reaped records. In
	*  valueMode:'disk' this counts keys/metadata/refs, not the value bulk. */
	bytes = 0;
	/** Number of records with an expiry set. Enables an O(1) size fast path when
	*  TTL is not in use. */
	expiring = 0;
	maxPerTick;
	expireTimeBudgetMs;
	/** Sticky flag: set when the last tick reaped ≥ maxPerTick (i.e. there is an
	*  expiry backlog), making the next ticks aggressive until the storm drains
	*  — like Redis's aggressive expire cycle. */
	expireAggressive = false;
	/** In-flight async bulk load (bulkLoadRefsAsync only — the sync bulk load
	*  yields nothing, so no timer can fire mid-load there). Active expiry is
	*  paused for the load's duration: a mid-load reap would delete the key
	*  from the map (and from the about-to-be-replaced OLD ordered index, a
	*  no-op) while the load still rebuilds `order` from its accumulated
	*  entries — resurrecting the reaped key in the ordered index, where a
	*  later re-set would duplicate it in ordered scans. Whatever elapsed
	*  during the load is reaped by the first tick after it, which is exactly
	*  the sync bulkLoadRefs behavior. */
	bulkLoading = false;
	timer = null;
	onExpire;
	readValue;
	constructor(opts = {}) {
		this.maxPerTick = opts.activeExpireMaxPerTick ?? 100;
		this.expireTimeBudgetMs = opts.activeExpireTimeBudgetMs ?? 2;
		this.onExpire = opts.onExpire;
		this.readValue = opts.readValue;
		const interval = opts.activeExpireIntervalMs ?? 100;
		this.timer = interval > 0 ? setInterval(() => this.activeExpire(), interval) : null;
		this.timer?.unref?.();
	}
	get size() {
		if (this.expiring === 0) return this.map.size;
		let n = 0;
		const now = Date.now();
		for (const [, r] of this.map) if (!r.expireAt || r.expireAt > now) n++;
		return n;
	}
	metaBytes(dt) {
		return dt ? Buffer.byteLength(JSON.stringify({ dt }), "utf8") : 0;
	}
	refBytes(ref) {
		return ref.kind === "memory" ? ref.value.length : DISK_REF_BYTES;
	}
	cloneRef(ref) {
		return ref.kind === "memory" ? {
			kind: "memory",
			value: Buffer.from(ref.value)
		} : {
			kind: "disk",
			loc: { ...ref.loc }
		};
	}
	materialize(ref) {
		if (ref.kind === "memory") return ref.value;
		if (!this.readValue) throw new Error("Store cannot read disk-backed value without a ValueReader");
		return this.readValue(ref.loc);
	}
	/** Approximate bytes used by one record, matching the bytes tracked on set(). */
	recordBytes(k) {
		const r = this.map.get(k);
		return r ? Buffer.byteLength(k, "binary") + this.refBytes(r.ref) + this.metaBytes(r.dt) : 0;
	}
	/** Approximate bytes a SET would store for this key/value/dt. Pass
	*  countValue:false for valueMode:'disk', where only key/metadata/ref bytes
	*  stay in RAM and the value bulk lives in the snapshot/WAL. */
	estimateSetBytes(key, value, dt, opts = {}) {
		const k = toKStr(key);
		const countValue = opts.countValue ?? true;
		return Buffer.byteLength(k, "binary") + (countValue ? value.length : DISK_REF_BYTES) + this.metaBytes(dt);
	}
	remove(k) {
		const r = this.map.get(k);
		const ok = this.map.delete(k);
		if (ok) {
			if (r) {
				this.bytes -= Buffer.byteLength(k, "binary") + this.refBytes(r.ref) + this.metaBytes(r.dt);
				if (r.expireAt) this.expiring--;
			}
			this.order.delete(k, k);
		}
		return ok;
	}
	/** Remove a key that has expired and notify the owner so derived indexes
	*  stay in sync. */
	expireKey(k, rec) {
		if (this.remove(k)) this.onExpire?.(k, rec);
	}
	set(key, value, expireAt = 0, dt = null) {
		this.setRef(key, {
			kind: "memory",
			value: Buffer.from(value)
		}, expireAt, dt);
	}
	setRef(key, ref, expireAt = 0, dt = null) {
		const k = toKStr(key);
		const prev = this.map.get(k);
		if (prev) {
			if (prev.expireAt) this.expiring--;
			this.bytes -= this.recordBytes(k);
		}
		const seq = ++this.seq;
		const stored = this.cloneRef(ref);
		this.map.set(k, {
			ref: stored,
			expireAt: expireAt || 0,
			seq,
			dt
		});
		this.bytes += Buffer.byteLength(k, "binary") + this.refBytes(stored) + this.metaBytes(dt);
		if (!prev) this.order.insert(k, k);
		if (expireAt) {
			this.expiring++;
			this.heap.push({
				t: expireAt,
				k,
				seq
			});
			if (this.heap.size > this.map.size * 2 + 64) this.rebuildHeap();
		}
	}
	rebuildHeap() {
		this.heap.clear();
		for (const [k, r] of this.map) if (r.expireAt) this.heap.push({
			t: r.expireAt,
			k,
			seq: r.seq
		});
	}
	get(key) {
		const k = toKStr(key);
		const r = this.map.get(k);
		if (!r) return void 0;
		if (r.expireAt && r.expireAt <= Date.now()) {
			this.expireKey(k, r);
			return;
		}
		return this.materialize(r.ref);
	}
	/** Read the full raw record. Like get(), an expired record is lazily reaped
	*  here (notifying the owner so derived indexes stay in sync) rather than
	*  being left behind as a ghost that read paths such as scan/query/dtRange
	*  would otherwise skip-but-not-clean. The returned record is raw: its ref may
	*  point at disk rather than holding a Buffer. */
	getRecord(key) {
		const k = toKStr(key);
		const r = this.map.get(k);
		if (!r) return void 0;
		if (r.expireAt && r.expireAt <= Date.now()) {
			this.expireKey(k, r);
			return;
		}
		return r;
	}
	del(key) {
		return this.remove(toKStr(key));
	}
	/** Metadata-only existence check: no value materialization (no buffer copy in
	*  memory mode, no positioned disk read for disk-backed records). Applies the
	*  same lazy-expiration semantics as get(). */
	has(key) {
		const k = toKStr(key);
		const r = this.map.get(k);
		if (!r) return false;
		if (r.expireAt && r.expireAt <= Date.now()) {
			this.expireKey(k, r);
			return false;
		}
		return true;
	}
	*entries() {
		const now = Date.now();
		for (const [k, r] of this.map) {
			if (r.expireAt && r.expireAt <= now) continue;
			yield {
				key: fromKStr(k),
				value: this.materialize(r.ref),
				expireAt: r.expireAt,
				dt: r.dt
			};
		}
	}
	/** Walk live records without materializing values: yields the canonical key,
	*  dt metadata, and a lazy value reader. Expired records are skipped (not
	*  reaped) exactly as in entries(). Internal to the package — derived-index
	*  rebuilds use it to share a single walk and a single decode per record. */
	*rawRecords() {
		const now = Date.now();
		for (const [k, r] of this.map) {
			if (r.expireAt && r.expireAt <= now) continue;
			yield {
				kstr: k,
				dt: r.dt,
				readValue: () => this.materialize(r.ref)
			};
		}
	}
	/** Walk live records with their RAW value ref (never materialized): the
	*  stage-6 snapshot writer reads disk-backed values through its own async
	*  path (grouped, bounded-concurrency) instead of one synchronous
	*  positioned read per record. Expired records are skipped exactly as in
	*  entries(). Internal to the package. */
	*rawRefRecords() {
		const now = Date.now();
		for (const [k, r] of this.map) {
			if (r.expireAt && r.expireAt <= now) continue;
			yield {
				kstr: k,
				ref: r.ref,
				expireAt: r.expireAt,
				dt: r.dt
			};
		}
	}
	/** Ordered scan over keys. */
	*scan(opts = {}) {
		for (const n of this.order.range(opts)) {
			const r = this.getRecord(n.key);
			if (!r) continue;
			yield {
				key: fromKStr(n.key),
				value: this.materialize(r.ref),
				expireAt: r.expireAt,
				dt: r.dt
			};
		}
	}
	/** Prefix scan over keys. */
	*prefix(p, limit = Infinity) {
		const pk = toKStr(p);
		yield* this.scan({
			gte: pk,
			lt: pk + "￿",
			count: limit
		});
	}
	/** Ordered scan yielding canonical keys only, without materializing values
	*  (no buffer copies in memory mode, no positioned reads in disk mode).
	*  Expired records are lazily reaped, exactly as in scan(). */
	*rawKeys(opts = {}) {
		for (const n of this.order.range(opts)) {
			if (!this.getRecord(n.key)) continue;
			yield n.key;
		}
	}
	/** Rewrite disk-backed value locations after compaction rotates the
	*  snapshot/WAL files. Memory refs are left untouched. */
	remapLocs(remap) {
		for (const [k, r] of this.map) {
			if (r.ref.kind !== "disk") continue;
			const next = remap(k, r.ref.loc, r);
			if (next) r.ref = {
				kind: "disk",
				loc: { ...next }
			};
		}
	}
	/** Stage-5 generation load: populate the store wholesale from a recovered
	*  generation store image. `records` must be expiry-filtered by the caller
	*  (expired-past records dropped) and sorted by canonical key ascending (the
	*  image's write order), so the ordered index is bulk-built in O(N) instead
	*  of per-record inserts.
	*
	*  OWNERSHIP: the records' refs are adopted as-is (no defensive clone) —
	*  the image parser produced fresh buffers for exactly this purpose.
	*  `metaBytes` is the precomputed dt accounting value (0 = none), so the
	*  load never re-stringifies per record. */
	bulkLoadRefs(records) {
		const orderEntries = [];
		for (const { kstr, ref, expireAt, dt, metaBytes } of records) {
			const seq = ++this.seq;
			this.map.set(kstr, {
				ref,
				expireAt: expireAt || 0,
				seq,
				dt
			});
			this.bytes += Buffer.byteLength(kstr, "binary") + this.refBytes(ref) + (metaBytes ?? 0);
			if (expireAt) {
				this.expiring++;
				this.heap.push({
					t: expireAt,
					k: kstr,
					seq
				});
			}
			orderEntries.push({
				key: kstr,
				val: kstr
			});
		}
		this.order = SkipList.bulkLoad(orderEntries, { compareKey: cmpString });
	}
	/** Sliced variant of bulkLoadRefs (the open-time main-thread path):
	*  identical resulting state, but the per-record map insertions yield to
	*  the event loop every `sliceEvery` records, so a large store image never
	*  loads in one synchronous run. The final ordered-index bulk build is a
	*  single O(N) pass over the sorted entries and is likewise sliced via
	*  SkipList.bulkLoadAsync. Safe to yield mid-load: the store is not
	*  published until open() returns, and active expiry is paused for the
	*  load's duration (see `bulkLoading`) so a mid-load reap cannot diverge
	*  the map from the not-yet-rebuilt ordered index. */
	async bulkLoadRefsAsync(records, opts = {}) {
		const sliceEvery = opts.sliceEvery ?? 8192;
		const orderEntries = [];
		this.bulkLoading = true;
		try {
			let n = 0;
			for (const { kstr, ref, expireAt, dt, metaBytes } of records) {
				const seq = ++this.seq;
				this.map.set(kstr, {
					ref,
					expireAt: expireAt || 0,
					seq,
					dt
				});
				this.bytes += Buffer.byteLength(kstr, "binary") + this.refBytes(ref) + (metaBytes ?? 0);
				if (expireAt) {
					this.expiring++;
					this.heap.push({
						t: expireAt,
						k: kstr,
						seq
					});
				}
				orderEntries.push({
					key: kstr,
					val: kstr
				});
				if (++n % sliceEvery === 0) await new Promise((r) => setImmediate(r));
			}
			this.order = await SkipList.bulkLoadAsync(orderEntries, { compareKey: cmpString }, { sliceEvery });
		} finally {
			this.bulkLoading = false;
		}
	}
	activeExpire() {
		if (this.bulkLoading) return;
		const now = Date.now();
		const deadline = now + (this.expireAggressive ? Math.max(this.expireTimeBudgetMs, 10) : this.expireTimeBudgetMs);
		let n = 0;
		let reaped = 0;
		while (this.heap.size > 0 && this.heap.peek().t <= now) {
			if (n >= this.maxPerTick && (n & 15) === 0 && Date.now() >= deadline) break;
			const e = this.heap.pop();
			const r = this.map.get(e.k);
			if (r && r.seq === e.seq && r.expireAt && r.expireAt <= now) {
				this.expireKey(e.k, r);
				reaped++;
			}
			n++;
		}
		this.expireAggressive = reaped >= this.maxPerTick;
	}
	/** Synchronously reap every expired record. Returns the number removed. */
	reapExpired() {
		const now = Date.now();
		let n = 0;
		for (const [k, r] of this.map) if (r.expireAt && r.expireAt <= now) {
			this.expireKey(k, r);
			n++;
		}
		return n;
	}
	/** Reap already-expired records via the TTL min-heap: O(due + stale heap
	*  entries) instead of the O(store) full scan of reapExpired(), so callers
	*  on the write hot path do not pay a full-store sweep per call. Falls back
	*  to the full scan only when the heap provably diverged from the map (live
	*  TTL records remain but the heap is empty — an invariant no code path may
	*  produce), resyncing instead of leaking expired bytes. */
	reapExpiredDue() {
		const now = Date.now();
		let n = 0;
		while (this.heap.size > 0 && this.heap.peek().t <= now) {
			const e = this.heap.pop();
			const r = this.map.get(e.k);
			if (r && r.seq === e.seq && r.expireAt && r.expireAt <= now) {
				this.expireKey(e.k, r);
				n++;
			}
		}
		if (this.expiring > 0 && this.heap.size === 0) return n + this.reapExpired();
		return n;
	}
	/** Stop the active-expiration timer. */
	close() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
};
// ../../packages/minidb/src/wipe.ts
async function acquireWithWait(lock, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let delay = 10;
	for (;;) {
		if (await lock.acquire()) return true;
		if (Date.now() + delay > deadline) return false;
		const wait = delay + Math.floor(Math.random() * delay);
		await new Promise((resolve) => {
			setTimeout(resolve, wait);
		});
		delay = Math.min(delay * 2, 250);
	}
}
async function wipeStoreDir(opts) {
	const lockFiles = opts.lockFiles ?? ["db.lock"];
	const timeoutMs = opts.lockAcquireTimeoutMs ?? 0;
	const locks = lockFiles.map((file) => new LockFile(path.join(opts.dir, file)));
	const releaseAll = () => Promise.all(locks.map((lock) => lock.release().catch(() => {})));
	const results = await Promise.allSettled(locks.map((lock) => acquireWithWait(lock, timeoutMs)));
	const failed = results.find((r) => r.status === "rejected");
	if (failed !== void 0 || results.some((r) => r.status === "fulfilled" && !r.value)) {
		await releaseAll();
		if (failed !== void 0) throw failed.reason;
		return "locked";
	}
	try {
		const isolated = `${opts.dir}.wiping-${process.pid}-${randomUUID()}`;
		try {
			await withWindowsEpermRetry(() => fs$1.rename(opts.dir, isolated));
		} catch (error) {
			if (error.code === "ENOENT") return "wiped";
			throw error;
		}
		await fs$1.rm(isolated, {
			recursive: true,
			force: true
		});
	} finally {
		await releaseAll();
	}
	return "wiped";
}
// ../../packages/minidb/src/lifecycle.ts
/** The open() flow: configure, acquire, recover, and kick background
*  maintenance. On success the host instance is fully open; on failure every
*  acquired resource is released before the error rethrows. */
async function openMiniDb(db, opts, hooks) {
	const openT0 = performance.now();
	if (!opts || !opts.dir) throw new TypeError("MiniDb.open: opts.dir is required");
	db.dir = opts.dir;
	db.walPath = path.join(db.dir, WAL_FILE);
	db.indexPath = path.join(db.dir, SECONDARY_INDEXES_FILE);
	db.compoundIndexPath = path.join(db.dir, COMPOUND_INDEXES_FILE);
	const parsed = parseMiniDbOptions(opts);
	db.fsyncPolicy = parsed.fsyncPolicy;
	db.syncIntervalMs = parsed.syncIntervalMs;
	db.codecName = parsed.codecName;
	db.codec = CODECS[db.codecName];
	const valueMode = parsed.valueMode;
	db.compactThresholdBytes = parsed.compactThresholdBytes;
	db.autoCompact = parsed.autoCompact;
	db.maxMemoryBytes = parsed.maxMemoryBytes;
	db.maxMemoryPolicy = parsed.maxMemoryPolicy;
	db.indexGenerationsEnabled = parsed.indexGenerationsEnabled;
	db.textBuildWorkerEnabled = parsed.textBuildWorkerEnabled;
	db.deferTextBuildsEnabled = parsed.deferTextBuildsEnabled;
	db.textBuildMemoryBytes = parsed.textBuildMemoryBytes;
	db.maintenanceIoConcurrency = parsed.maintenanceIoConcurrency;
	if (db.textBuildMemoryBytes <= 0 || !Number.isFinite(db.textBuildMemoryBytes)) throw new RangeError("textBuildMemoryBytes must be a positive finite number");
	if (db.maxMemoryBytes !== null && (!Number.isFinite(db.maxMemoryBytes) || db.maxMemoryBytes <= 0)) throw new RangeError("maxMemoryBytes must be a positive finite number");
	db.readOnly = !!opts.readOnly;
	if (db.readOnly) await fs$1.readdir(db.dir);
	else await fs$1.mkdir(db.dir, { recursive: true });
	db.valueMode = await resolveValueMode(valueMode, db.dir, db.maxMemoryBytes);
	db.maintenance = new MaintenanceScheduler({
		dir: db.dir,
		estimateBytes: async (kind) => {
			const dataBytes = await fileSize(path.join(db.dir, SNAPSHOT_FILE)) + (db.wal?.size ?? 0);
			if (kind === "compact") return dataBytes;
			if (kind === "text-build") return dataBytes;
			let derived = 0;
			const gen = hooks.generationInfo();
			if (gen) try {
				const m = await readManifest(db.dir, gen.id);
				derived = Object.values(m.files).reduce((a, f) => a + f.bytes, 0);
			} catch {
				derived = 0;
			}
			return dataBytes + derived;
		}
	});
	if (!db.readOnly) {
		db.lock = new LockFile(path.join(db.dir, "db.lock"));
		if (!await db.lock.acquire()) {
			if (opts.onLockFail === "readonly") {
				db.readOnly = true;
				db.lock = null;
			} else throw new LockError(`database is locked by another process: ${db.dir}`);
		} else {
			const heldToken = db.lock.heldToken;
			if (heldToken !== void 0) try {
				opts.onLockAcquired?.({ token: heldToken });
			} catch {}
		}
	}
	if (!db.readOnly) {
		for (const tmp of STALE_TMP_FILES) await fs$1.rm(path.join(db.dir, tmp), { force: true });
		for (const f of await fs$1.readdir(db.dir)) {
			if (isStaleTmpFile(f)) {
				await fs$1.rm(path.join(db.dir, f), { force: true });
				continue;
			}
			if (STALE_POSTINGS_TMP_PATTERN.test(f)) await fs$1.rm(path.join(db.dir, f), { force: true });
		}
		await sweepGenerationTemps(db.dir);
	}
	db.store = new Store({
		activeExpireIntervalMs: parsed.activeExpireIntervalMs,
		onExpire: (k, rec) => hooks.onStoreExpire(k, rec),
		readValue: (loc) => {
			if (!db.valueReader) throw new Error("ValueReader is not open");
			return db.valueReader.read(loc);
		}
	});
	try {
		db.wal = new WAL(db.walPath, {
			fsyncPolicy: db.fsyncPolicy,
			syncIntervalMs: db.syncIntervalMs,
			stats: db.stats
		});
		if (!db.readOnly) await db.wal.open();
		await hooks.loadIndexDefinitions();
		await hooks.loadCompoundIndexDefinitions();
		await hooks.loadTextIndexDefinitions();
		let generationLoaded = false;
		if (db.indexGenerationsEnabled) generationLoaded = await hooks.tryLoadGeneration(parsed.recovery);
		if (!generationLoaded) {
			db.lifecycle.transition("full-rebuild");
			const recT0 = performance.now();
			const scanApply = {
				walScanMs: 0,
				walApplyMs: 0
			};
			db.recoveryInfo = await recover({
				dir: db.dir,
				store: db.store,
				mode: parsed.recovery,
				truncate: !db.readOnly,
				valueMode: db.valueMode,
				timings: scanApply,
				attachValueReader: db.valueMode === "disk" ? (anchors) => {
					const reader = new ValueReader(db.dir);
					let ids;
					try {
						ids = reader.open();
					} catch (error) {
						reader.close();
						throw error;
					}
					const sameInode = (a, i) => a === null ? i === null : i !== null && i.dev === a.dev && i.ino === a.ino;
					if (sameInode(anchors.snapshot, ids.snapshot) && sameInode(anchors.wal, ids.wal)) {
						db.valueReader = reader;
						return true;
					}
					reader.close();
					return false;
				} : void 0
			});
			db.stats.recoveryDurationMs += performance.now() - recT0;
			db.lifecycle.time("walScanMs", scanApply.walScanMs);
			db.lifecycle.time("walApplyMs", scanApply.walApplyMs);
			db.stats.recoveryBytes += db.recoveryInfo.snapshotBytes + db.recoveryInfo.walBytes;
			db.stats.recoveryFrames += db.recoveryInfo.snapshotFrames + db.recoveryInfo.walFrames;
			if (db.recoveryInfo.truncatedWal) await db.wal.refreshSize();
			hooks.seedAccessFromStore();
			await hooks.rebuildAllIndexes();
			db.lifecycle.time("fullRecoveryMs", performance.now() - recT0);
		}
		if (!db.readOnly && db.autoCompact && shouldCompact(db)) hooks.submitCompaction().catch(() => {});
		if (!db.readOnly && db.indexGenerationsEnabled) {
			const gen = db.recoveryInfo?.indexGeneration;
			const deltaOps = db.recoveryInfo?.walDeltaAppliedOps ?? 0;
			const deltaBytes = gen ? db.recoveryInfo.walScanEnd - gen.walCheckpoint : 0;
			const stale = gen !== void 0 && (deltaOps > 4096 || deltaBytes > 4194304);
			if (!generationLoaded && db.size > 0 || stale) hooks.buildGeneration("open").catch(() => {});
		}
		const lostBytes = db.recoveryInfo?.lostBytes ?? 0;
		if (lostBytes > 0) console.warn(`[minidb] ${db.dir}: recovery dropped ${lostBytes} unreadable byte(s) during replay`);
		db.lifecycle.time("openMs", performance.now() - openT0);
		db.lifecycle.finishOpen();
	} catch (error) {
		if (db.compacting && db._compactDone) await db._compactDone.catch(() => {});
		hooks.closeAllTextIndexes();
		if (db.wal) await db.wal.close().catch(() => {});
		db.valueReader?.close();
		db.store?.close();
		if (db.lock) {
			await db.lock.release().catch(() => {});
			db.lock = null;
		}
		if (db.readOnly && error && typeof error === "object") error.readOnlyOpen = true;
		throw error;
	}
}
/** close(): concurrent close() calls share the one in-flight cleanup pass;
*  after a failed pass a later call retries the remaining cleanup (the state
*  stays 'closing' until a pass completes without errors). */
async function closeMiniDb(db, hooks) {
	if (db.state === "closed") return;
	if (db.closePromise) return db.closePromise;
	const run = (async () => {
		if (hooks.generationStale()) await hooks.buildGeneration("close").catch(() => {});
		db.state = "closing";
		await closeResources(db, hooks);
	})();
	db.closePromise = run;
	try {
		await run;
		db.state = "closed";
	} finally {
		if (db.closePromise === run) db.closePromise = null;
	}
}
/** One cleanup pass over every held resource in dependency order (text
*  indexes → store → valueReader → WAL → lock). Each resource's close is
*  independently fallible and idempotent: an error is collected and the
*  rest still run — a failed WAL close must not skip the lock release —
*  then every collected error is rethrown as one AggregateError. The WAL
*  failure semantics themselves are unchanged (the error propagates); only
*  the lock release is no longer skipped because of it. */
async function closeResources(db, hooks) {
	hooks.genBuildAbort()?.abort();
	await db.maintenance.close();
	if (db.compacting) await db._compactDone?.catch(() => {});
	const genBuildPromise = hooks.genBuildPromise();
	if (genBuildPromise) await genBuildPromise.catch(() => {});
	while (!hooks.walRecoveryIdle()) await hooks.walRecoveryChain();
	const errors = [];
	try {
		hooks.closeAllTextIndexes();
	} catch (error) {
		errors.push(error);
	}
	if (db.roScratchDir !== null) try {
		await fs$1.rm(db.roScratchDir, {
			recursive: true,
			force: true
		});
		db.roScratchDir = null;
	} catch (error) {
		errors.push(error);
	}
	try {
		db.store.close();
	} catch (error) {
		errors.push(error);
	}
	try {
		db.valueReader?.close();
	} catch (error) {
		errors.push(error);
	}
	try {
		await db.wal.close();
	} catch (error) {
		errors.push(error);
	}
	while (!hooks.walRecoveryIdle()) await hooks.walRecoveryChain();
	try {
		if (db.lock) {
			await db.lock.release();
			db.lock = null;
		}
	} catch (error) {
		errors.push(error);
	}
	if (errors.length > 0) throw new AggregateError(errors, `MiniDb close: ${errors.map((e) => e instanceof Error ? e.message : String(e)).join("; ")}`);
}
/** Refresh the write lock's timestamp (see {@link LockFile.renew}). No-op
*  for a read-only instance. */
async function renewMiniDbLock(db) {
	await db.lock?.renew();
}
/** Open a database, and if opening fails due to corruption (not due to a live
*  lock), attempt the non-destructive repairs: drop the derived index-definition
*  sidecars and retry. A full destructive rebuild — deleting the directory and
*  opening a fresh empty database — is opt-in via `allowDestructiveRebuild` and
*  must only be enabled for a rebuildable cache: an opener whose directory may
*  hold irreplaceable data refuses to erase it and rethrows a clear error
*  instead. A live lock is always rethrown. `open` is the owner's factory
*  injection (MiniDb.open).
*
*  The destructive rebuild only ever runs for an open that could OWN the
*  directory: an error tagged `readOnlyOpen` (opts.readOnly, or a lock that
*  degraded via onLockFail:'readonly') is rethrown untouched — rebuilding
*  means deleting files, and a read-only bystander must never mutate a live
*  writer's directory (lock-review repro: the readonly fallback deleted the
*  writer's sidecar, and in the strict-recovery shape the whole directory).
*/
async function openOrRebuildMiniDb(opts, hooks, open) {
	try {
		return await open(opts);
	} catch (error) {
		if (error instanceof LockError || error.code === "ELOCKED") throw error;
		if (!(error instanceof SyntaxError || error.name === "CorruptFrameError")) throw error;
		if (error.readOnlyOpen) throw error;
		if (hooks.onRebuild) hooks.onRebuild(error);
		if (error instanceof SyntaxError) try {
			for (const f of SIDECAR_FILES) {
				await fs$1.rm(path.join(opts.dir, f), { force: true });
				await fs$1.rm(path.join(opts.dir, `${f}.tmp`), { force: true });
			}
			return await open(opts);
		} catch {}
		if (hooks.allowDestructiveRebuild !== true) throw new Error(`MiniDb.openOrRebuild: ${opts.dir} failed to open with an unrecoverable corruption error (${error instanceof Error ? error.message : String(error)}); refusing to erase it. Repair the directory manually, or pass allowDestructiveRebuild: true only if this database is a rebuildable cache.`, { cause: error });
		if (await wipeStoreDir({ dir: opts.dir }) === "locked") throw error;
		return open(opts);
	}
}
// ../../packages/minidb/src/memory-guard.ts
var MemoryGuard = class {
	deps;
	/** pk, insertion-ordered by last touch (Map/Set iteration order): front =
	*  LRU. Non-private (package-internal by convention): MiniDb forwards its
	*  delete-only access call sites here. */
	access = /* @__PURE__ */ new Set();
	constructor(deps) {
		this.deps = deps;
	}
	touchAccess(pk) {
		this.access.delete(pk);
		this.access.add(pk);
	}
	seedAccessFromStore() {
		this.access.clear();
		for (const [k] of this.deps.store().map) this.access.add(k);
	}
	projectedBytesForOps(ops) {
		const store = this.deps.store();
		const considered = /* @__PURE__ */ new Map();
		let projected = store.bytes;
		for (const op of ops) {
			const cur = considered.has(op.pk) ? considered.get(op.pk) : store.recordBytes(op.pk);
			projected -= cur;
			const next = op.type === 1 ? store.estimateSetBytes(op.key, op.value, op.dtNorm, { countValue: this.deps.valueMode() === "memory" }) : 0;
			projected += next;
			considered.set(op.pk, next);
		}
		return projected;
	}
	/** O(1) LRU victim: `access` is insertion-ordered by last touch, so the
	*  first entry that is a live, non-skipped key is the least-recently-used one. */
	pickEvictionVictim(skip) {
		const store = this.deps.store();
		for (const k of this.access) {
			if (skip.has(k) || !store.map.has(k)) continue;
			return k;
		}
		for (const [k] of store.map) if (!skip.has(k)) return k;
	}
	async ensureMemoryFor(ops) {
		const maxMemoryBytes = this.deps.maxMemoryBytes();
		if (maxMemoryBytes === null) return;
		const store = this.deps.store();
		store.reapExpiredDue();
		let projected = this.projectedBytesForOps(ops);
		if (projected <= maxMemoryBytes) return;
		if (this.deps.maxMemoryPolicy() === "evict-lru") {
			const skip = new Set(ops.map((o) => o.pk));
			while (projected > maxMemoryBytes) {
				const victim = this.pickEvictionVictim(skip);
				if (!victim) break;
				projected -= store.recordBytes(victim);
				await this.deps.evictKey(victim);
			}
		}
		if (projected > maxMemoryBytes) {
			this.deps.stats.maxMemoryRejections++;
			throw new Error(`maxMemory exceeded: projected ${projected} bytes > ${maxMemoryBytes} bytes`);
		}
	}
};
// ../../packages/minidb/src/query-engine.ts
/** Lazy one-shot candidate filter — keeps query pipelines streaming so a
*  bounded query stops after `skip + limit` matches instead of materializing
*  every candidate. */
function* filterKeys(keys, pred) {
	for (const k of keys) if (pred(k)) yield k;
}
var QueryEngine = class {
	deps;
	constructor(deps) {
		this.deps = deps;
	}
	indexPredicates(filter) {
		if (!filter || typeof filter !== "object") return [];
		const out = [];
		for (const [key, cond] of Object.entries(filter)) if (key === "$and" && Array.isArray(cond)) {
			for (const f of cond) if (f && typeof f === "object") {
				for (const [k, c] of Object.entries(f)) if (!k.startsWith("$")) out.push({
					field: k,
					cond: c
				});
			}
		} else if (!key.startsWith("$")) out.push({
			field: key,
			cond
		});
		return out;
	}
	candidateKeysForPredicate(field, cond) {
		const indexes = this.deps.indexes;
		if (this.deps.codecName() !== "json" || indexes.indexes.size === 0) return null;
		const fieldIndexes = indexes.list().filter((i) => i.field === field);
		if (fieldIndexes.length === 0) return null;
		const isOpObj = cond !== null && typeof cond === "object" && !(cond instanceof RegExp);
		const ops = isOpObj ? cond : null;
		const eqIndex = fieldIndexes.find((i) => i.type === "equality");
		if (eqIndex) {
			if (!isOpObj) {
				if (cond instanceof RegExp) return null;
				return new Set(indexes.findEq(eqIndex.name, cond));
			}
			if (ops && Object.keys(ops).length === 1 && "$eq" in ops) return new Set(indexes.findEq(eqIndex.name, ops["$eq"]));
			if (ops && Array.isArray(ops["$in"])) {
				const set = /* @__PURE__ */ new Set();
				for (const v of ops["$in"]) for (const pk of indexes.findEq(eqIndex.name, v)) set.add(pk);
				return set;
			}
		}
		const rangeIndex = fieldIndexes.find((i) => i.type === "range");
		if (rangeIndex && ops) {
			const opts = {};
			if (typeof ops["$gte"] === "number") opts.min = ops["$gte"];
			if (typeof ops["$gt"] === "number") {
				opts.min = ops["$gt"];
				opts.minExclusive = true;
			}
			if (typeof ops["$lte"] === "number") opts.max = ops["$lte"];
			if (typeof ops["$lt"] === "number") {
				opts.max = ops["$lt"];
				opts.maxExclusive = true;
			}
			if (opts.min !== void 0 || opts.max !== void 0) return new Set(indexes.findRange(rangeIndex.name, opts).map((r) => r.pk));
		}
		return null;
	}
	indexedCandidateKeys(filter) {
		let candidates = null;
		for (const p of this.indexPredicates(filter)) {
			const set = this.candidateKeysForPredicate(p.field, p.cond);
			if (!set) continue;
			if (candidates) {
				const next = /* @__PURE__ */ new Set();
				for (const k of candidates) if (set.has(k)) next.add(k);
				candidates = next;
			} else candidates = set;
		}
		if (!candidates) return null;
		this.deps.stats.queryIndexHits++;
		return [...candidates];
	}
	cheapEqChecks(filter) {
		const out = [];
		const indexes = this.deps.indexes;
		if (!filter || typeof filter !== "object" || indexes.indexes.size === 0) return out;
		for (const { field, cond } of this.indexPredicates(filter)) {
			const idx = indexes.list().find((i) => i.field === field && i.type === "equality");
			if (!idx) continue;
			if (cond !== null && typeof cond === "object" && !(cond instanceof RegExp)) {
				const ops = cond;
				if (Object.keys(ops).length === 1 && "$eq" in ops) out.push({
					name: idx.name,
					value: ops["$eq"]
				});
			} else {
				if (cond instanceof RegExp) continue;
				out.push({
					name: idx.name,
					value: cond
				});
			}
		}
		return out;
	}
	tryDtOrderedLimit(q) {
		if (q.text) return null;
		if (q.key !== void 0) return null;
		if (!q.dt) return null;
		const dtCols = Object.keys(q.dt);
		if (dtCols.length !== 1) return null;
		const col = dtCols[0];
		const cond = q.dt[col];
		if (cond.offset !== void 0 || cond.count !== void 0) return null;
		let reverse = false;
		if (q.sort) {
			const entries = Object.entries(q.sort);
			if (entries.length !== 1) return null;
			const [sortKey, dir] = entries[0];
			if (sortKey !== col) return null;
			reverse = dir < 0;
		}
		const limit = q.limit;
		const skip = q.skip ?? 0;
		const iterOpts = { reverse };
		if (cond.gte !== void 0) iterOpts.gte = cond.gte;
		if (cond.gt !== void 0) iterOpts.gt = cond.gt;
		if (cond.lte !== void 0) iterOpts.lte = cond.lte;
		if (cond.lt !== void 0) iterOpts.lt = cond.lt;
		const eqChecks = this.cheapEqChecks(q.filter);
		const stats = this.deps.stats;
		const out = [];
		let skipped = 0;
		for (const { key: kstr } of this.deps.dt.iterate(col, iterOpts)) {
			stats.queryCandidates++;
			let rejected = false;
			for (const c of eqChecks) if (!this.deps.indexes.hasEq(c.name, c.value, kstr)) {
				rejected = true;
				break;
			}
			if (rejected) continue;
			const buf = this.deps.store().get(kstr);
			if (buf === void 0) continue;
			const r = this.deps.store().map.get(kstr);
			stats.queryDecoded++;
			const value = this.deps.decode(buf);
			if (q.filter && !match(value, q.filter)) continue;
			if (skipped < skip) {
				skipped++;
				continue;
			}
			if (limit !== void 0 && out.length >= limit) break;
			out.push({
				key: kstr,
				value,
				dt: r?.dt ?? void 0
			});
		}
		return out.map((d) => ({
			key: fromKStr$1(d.key),
			value: q.project ? project(d.value, q.project) : d.value,
			dt: d.dt
		}));
	}
	query(q = {}) {
		this.deps.ensureOpen();
		const fast = this.tryDtOrderedLimit(q);
		if (fast !== null) return fast;
		let keys = null;
		if (typeof q.key === "string") keys = [toKStr$1(q.key)];
		else if (q.key && typeof q.key === "object") {
			if (q.key.prefix) {
				const p = toKStr$1(q.key.prefix);
				keys = this.deps.store().rawKeys({
					gte: p,
					lt: p + "￿"
				});
			} else {
				const opts = {};
				for (const b of [
					"gte",
					"gt",
					"lte",
					"lt"
				]) if (q.key[b] !== void 0) opts[b] = q.key[b];
				keys = this.deps.store().rawKeys(canonRange(opts));
			}
		}
		if (q.dt) for (const [col, cond] of Object.entries(q.dt)) {
			const set = new Set(this.deps.dt.range(col, cond).map((r) => r.key));
			keys = keys === null ? set : filterKeys(keys, (k) => set.has(k));
		}
		let textOrder = null;
		if (q.text) {
			const ti = this.deps.text.get(q.text.index);
			if (!ti) throw new Error(`no such text index: ${q.text.index}`);
			const hits = ti.search(q.text.q, {
				op: q.text.op,
				limit: q.text.limit ?? 1e6
			});
			textOrder = hits;
			const set = new Set(hits.map((h) => h.key));
			keys = keys === null ? hits.map((h) => h.key) : filterKeys(keys, (k) => set.has(k));
		}
		const indexed = this.indexedCandidateKeys(q.filter);
		if (indexed) {
			const set = new Set(indexed);
			keys = keys === null ? indexed : filterKeys(keys, (k) => set.has(k));
		}
		keys ??= this.deps.store().rawKeys({});
		const stats = this.deps.stats;
		const skip = q.skip ?? 0;
		const limit = q.limit === void 0 ? Infinity : q.limit;
		const early = !q.sort && !textOrder;
		const docs = [];
		let seen = 0;
		for (const k of keys) {
			stats.queryCandidates++;
			const buf = this.deps.store().get(k);
			if (buf === void 0) continue;
			const r = this.deps.store().map.get(k);
			stats.queryDecoded++;
			const value = this.deps.decode(buf);
			if (q.filter && !match(value, q.filter)) continue;
			if (early) {
				if (seen++ < skip) continue;
				if (docs.length >= limit) break;
				docs.push({
					key: k,
					value,
					dt: r?.dt ?? void 0
				});
			} else docs.push({
				key: k,
				value,
				dt: r?.dt ?? void 0
			});
		}
		if (textOrder && !q.sort) {
			stats.querySortedRows += docs.length;
			const rank = new Map(textOrder.map((h, i) => [h.key, i]));
			docs.sort((a, b) => (rank.get(a.key) ?? 1e9) - (rank.get(b.key) ?? 1e9));
		}
		if (q.sort) {
			stats.querySortedRows += docs.length;
			const entries = Object.entries(q.sort);
			docs.sort((a, b) => {
				for (const [p, dir] of entries) {
					const av = getPath(a.value, p);
					const bv = getPath(b.value, p);
					const c = av < bv ? -1 : av > bv ? 1 : 0;
					if (c !== 0) return dir < 0 ? -c : c;
				}
				return 0;
			});
		}
		const sliced = early ? docs : skip || limit !== Infinity ? docs.slice(skip, skip + limit) : docs;
		if (q.project) return sliced.map((d) => ({
			key: fromKStr$1(d.key),
			value: project(d.value, q.project),
			dt: d.dt
		}));
		return sliced.map((d) => ({
			...d,
			key: fromKStr$1(d.key)
		}));
	}
	/** Async twin of query() (stage 6, additive): identical results and
	*  ordering; the disk-mode value reads (and the text branch's postings
	*  reads) run off the event loop. The candidate-collection logic mirrors
	*  query() exactly — keep both in sync when the query planner changes. */
	async queryAsync(q = {}) {
		this.deps.ensureOpen();
		const fast = await this.tryDtOrderedLimitAsync(q);
		if (fast !== null) return fast;
		let keys = null;
		if (typeof q.key === "string") keys = [toKStr$1(q.key)];
		else if (q.key && typeof q.key === "object") {
			if (q.key.prefix) {
				const p = toKStr$1(q.key.prefix);
				keys = this.deps.store().rawKeys({
					gte: p,
					lt: p + "￿"
				});
			} else {
				const opts = {};
				for (const b of [
					"gte",
					"gt",
					"lte",
					"lt"
				]) if (q.key[b] !== void 0) opts[b] = q.key[b];
				keys = this.deps.store().rawKeys(canonRange(opts));
			}
		}
		if (q.dt) for (const [col, cond] of Object.entries(q.dt)) {
			const set = new Set(this.deps.dt.range(col, cond).map((r) => r.key));
			keys = keys === null ? set : filterKeys(keys, (k) => set.has(k));
		}
		let textOrder = null;
		if (q.text) {
			const ti = this.deps.text.get(q.text.index);
			if (!ti) throw new Error(`no such text index: ${q.text.index}`);
			const hits = await ti.searchAsync(q.text.q, {
				op: q.text.op,
				limit: q.text.limit ?? 1e6
			});
			textOrder = hits;
			const set = new Set(hits.map((h) => h.key));
			keys = keys === null ? hits.map((h) => h.key) : filterKeys(keys, (k) => set.has(k));
		}
		const indexed = this.indexedCandidateKeys(q.filter);
		if (indexed) {
			const set = new Set(indexed);
			keys = keys === null ? indexed : filterKeys(keys, (k) => set.has(k));
		}
		keys ??= this.deps.store().rawKeys({});
		const stats = this.deps.stats;
		const skip = q.skip ?? 0;
		const limit = q.limit === void 0 ? Infinity : q.limit;
		const early = !q.sort && !textOrder;
		const docs = [];
		let seen = 0;
		for (const k of keys) {
			stats.queryCandidates++;
			const buf = await this.deps.readValueAsync(k);
			if (buf === void 0) continue;
			const r = this.deps.store().map.get(k);
			stats.queryDecoded++;
			const value = this.deps.decode(buf);
			if (q.filter && !match(value, q.filter)) continue;
			if (early) {
				if (seen++ < skip) continue;
				if (docs.length >= limit) break;
				docs.push({
					key: k,
					value,
					dt: r?.dt ?? void 0
				});
			} else docs.push({
				key: k,
				value,
				dt: r?.dt ?? void 0
			});
		}
		if (textOrder && !q.sort) {
			stats.querySortedRows += docs.length;
			const rank = new Map(textOrder.map((h, i) => [h.key, i]));
			docs.sort((a, b) => (rank.get(a.key) ?? 1e9) - (rank.get(b.key) ?? 1e9));
		}
		if (q.sort) {
			stats.querySortedRows += docs.length;
			const entries = Object.entries(q.sort);
			docs.sort((a, b) => {
				for (const [p, dir] of entries) {
					const av = getPath(a.value, p);
					const bv = getPath(b.value, p);
					const c = av < bv ? -1 : av > bv ? 1 : 0;
					if (c !== 0) return dir < 0 ? -c : c;
				}
				return 0;
			});
		}
		const sliced = early ? docs : skip || limit !== Infinity ? docs.slice(skip, skip + limit) : docs;
		if (q.project) return sliced.map((d) => ({
			key: fromKStr$1(d.key),
			value: project(d.value, q.project),
			dt: d.dt
		}));
		return sliced.map((d) => ({
			...d,
			key: fromKStr$1(d.key)
		}));
	}
	/** Async twin of the dt-ordered fast path (see tryDtOrderedLimit): the
	*  same eligibility rules and output, with async value reads. */
	async tryDtOrderedLimitAsync(q) {
		if (q.text) return null;
		if (q.key !== void 0) return null;
		if (!q.dt) return null;
		const dtCols = Object.keys(q.dt);
		if (dtCols.length !== 1) return null;
		const col = dtCols[0];
		const cond = q.dt[col];
		if (cond.offset !== void 0 || cond.count !== void 0) return null;
		let reverse = false;
		if (q.sort) {
			const entries = Object.entries(q.sort);
			if (entries.length !== 1) return null;
			const [sortKey, dir] = entries[0];
			if (sortKey !== col) return null;
			reverse = dir < 0;
		}
		const limit = q.limit;
		const skip = q.skip ?? 0;
		const iterOpts = { reverse };
		if (cond.gte !== void 0) iterOpts.gte = cond.gte;
		if (cond.gt !== void 0) iterOpts.gt = cond.gt;
		if (cond.lte !== void 0) iterOpts.lte = cond.lte;
		if (cond.lt !== void 0) iterOpts.lt = cond.lt;
		const eqChecks = this.cheapEqChecks(q.filter);
		const stats = this.deps.stats;
		const out = [];
		let skipped = 0;
		for (const { key: kstr } of this.deps.dt.iterate(col, iterOpts)) {
			stats.queryCandidates++;
			let rejected = false;
			for (const c of eqChecks) if (!this.deps.indexes.hasEq(c.name, c.value, kstr)) {
				rejected = true;
				break;
			}
			if (rejected) continue;
			const buf = await this.deps.readValueAsync(kstr);
			if (buf === void 0) continue;
			const r = this.deps.store().map.get(kstr);
			stats.queryDecoded++;
			const value = this.deps.decode(buf);
			if (q.filter && !match(value, q.filter)) continue;
			if (skipped < skip) {
				skipped++;
				continue;
			}
			if (limit !== void 0 && out.length >= limit) break;
			out.push({
				key: kstr,
				value,
				dt: r?.dt ?? void 0
			});
		}
		return out.map((d) => ({
			key: fromKStr$1(d.key),
			value: q.project ? project(d.value, q.project) : d.value,
			dt: d.dt
		}));
	}
};
// ../../packages/minidb/src/read-path.ts
var ReadPath = class {
	deps;
	constructor(deps) {
		this.deps = deps;
	}
	*liveRecords() {
		for (const { key, value, dt } of this.deps.store().entries()) yield {
			key,
			value: this.deps.decode(value),
			dt
		};
	}
	*liveRecordsRaw() {
		for (const { key, value } of this.deps.store().entries()) yield {
			key,
			value: this.deps.decode(value)
		};
	}
	/** Live indexable records with canonical keys, for (re)building text indexes. */
	*textRecords() {
		for (const { key, value } of this.liveRecords()) if (this.deps.indexable(value)) yield {
			key: toKStr$1(key),
			value
		};
	}
	get(key) {
		this.deps.ensureOpen();
		const k = toKStr$1(key);
		const v = this.deps.store().get(k);
		if (v !== void 0) this.deps.memoryGuard.touchAccess(k);
		return this.deps.decode(v);
	}
	/** Async value resolution for a canonical key (stage 6): a memory ref is
	*  served inline; a disk ref is read through the async positioned reader
	*  instead of blocking the event loop on readSync. The lazy-expiry
	*  semantics match store.get exactly. */
	async readValueAsync(kstr) {
		const rec = this.deps.store().getRecord(kstr);
		if (!rec) return void 0;
		if (rec.ref.kind === "memory") return rec.ref.value;
		const valueReader = this.deps.getValueReader();
		if (!valueReader) throw new Error("ValueReader is not open");
		return valueReader.readAsync(rec.ref.loc);
	}
	/** Async twin of get() (stage 6, additive): identical result; only the
	*  disk-mode value read moves off the event loop. */
	async getAsync(key) {
		this.deps.ensureOpen();
		const k = toKStr$1(key);
		const buf = await this.readValueAsync(k);
		if (buf !== void 0) this.deps.memoryGuard.touchAccess(k);
		return this.deps.decode(buf);
	}
	getRecord(key) {
		this.deps.ensureOpen();
		const k = toKStr$1(key);
		const value = this.deps.store().get(k);
		if (value === void 0) return void 0;
		const r = this.deps.store().map.get(k);
		this.deps.memoryGuard.touchAccess(k);
		return {
			key: fromKStr$1(toKStr$1(key)),
			value: this.deps.decode(value),
			dt: r?.dt ?? void 0
		};
	}
	has(key) {
		this.deps.ensureOpen();
		return this.deps.store().has(toKStr$1(key));
	}
	mget(keys) {
		return keys.map((k) => this.get(k));
	}
	ttl(key) {
		this.deps.ensureOpen();
		const r = this.deps.store().map.get(toKStr$1(key));
		if (!r) return -2;
		if (!r.expireAt) return -1;
		const left = r.expireAt - Date.now();
		return left > 0 ? left : -2;
	}
	scan(opts = {}) {
		this.deps.ensureOpen();
		const count = opts.limit ?? Infinity;
		const out = [];
		for (const r of this.deps.store().scan({
			...canonRange(opts),
			count
		})) out.push({
			key: r.key.toString(),
			value: this.deps.decode(r.value),
			dt: r.dt ?? void 0
		});
		return out;
	}
	prefix(p, limit = Infinity) {
		this.deps.ensureOpen();
		const out = [];
		for (const r of this.deps.store().prefix(toKStr$1(p), limit)) out.push({
			key: r.key.toString(),
			value: this.deps.decode(r.value),
			dt: r.dt ?? void 0
		});
		return out;
	}
	dtColumns() {
		return this.deps.dt.columns();
	}
	dtRange(col, opts = {}) {
		this.deps.ensureOpen();
		const rows = this.deps.dt.range(col, {
			...opts,
			count: opts.limit ?? opts.count
		});
		const out = [];
		for (const { key, value: dtValue } of rows) {
			const value = this.deps.store().get(key);
			if (value === void 0) continue;
			const r = this.deps.store().map.get(key);
			out.push({
				key: fromKStr$1(key),
				value: this.deps.decode(value),
				dt: r?.dt ?? void 0,
				dtValue
			});
		}
		return out;
	}
};
// ../../packages/minidb/src/stats.ts
/** Create the MiniDb stats object (all counters zeroed). */
function createMiniDbStats() {
	return {
		compactions: 0,
		compactErrors: 0,
		walBytesWritten: 0,
		walFsyncs: 0,
		/** Failed writev-class attempts on the WAL write path. Each one poisons
		*  the WAL and triggers an in-place recovery (truncate + resume). */
		walWriteErrors: 0,
		/** Failed fsync attempts; a background everysec failure never rejects a
		*  write — it surfaces only here and in lastWalFsyncError. A write-path
		*  ('always') fsync failure rejects its batch and poisons the WAL. */
		walFsyncErrors: 0,
		/** Sticky copy of the most recent fsync failure (never cleared). */
		lastWalFsyncError: null,
		/** Bytes currently queued in the live WAL's in-memory append buffer. */
		walQueuedBytes: 0,
		/** High-water mark of walQueuedBytes. */
		walMaxQueuedBytes: 0,
		/** WAL group commits (one per flushed batch) and the frames they carried. */
		walGroupCommits: 0,
		walGroupCommitFrames: 0,
		snapshotBytesWritten: 0,
		evictions: 0,
		maxMemoryRejections: 0,
		queryIndexHits: 0,
		/** Bytes and frames recovery scanned at open (snapshot + WAL). */
		recoveryBytes: 0,
		recoveryFrames: 0,
		recoveryDurationMs: 0,
		/** Open-time derived-index rebuilds (secondary + dt + compound). */
		indexRebuildDurationMs: 0,
		/** Values decoded by the open-time shared rebuild walk (0 when no
		*  value-derived index exists: the walk is metadata-only then). */
		indexRebuildDecoded: 0,
		/** Text-index (re)builds: at open and after each compaction. */
		textRebuildDurationMs: 0,
		/** Whole successful compactions, hook included. */
		compactionDurationMs: 0,
		/** The non-blocking snapshot phase of compaction. */
		compactionSnapshotDurationMs: 0,
		/** The rotation critical section of compaction (writes park meanwhile). */
		compactionRotationDurationMs: 0,
		/** Text-postings rebuild after a compaction rotation. */
		compactionPostingsDurationMs: 0,
		/** Cumulative time write ops spent parked on a compaction rotation. */
		compactionRotationPauseMs: 0,
		/** Set once a rotation's directory fsync reported EINVAL/ENOTSUP: this
		*  platform cannot make renames durable via the directory, so rotation
		*  durability is knowingly degraded (warned once), never silently. */
		dirFsyncUnsupported: false,
		/** Candidate keys iterated / values decoded / rows fed to a sort in query(). */
		queryCandidates: 0,
		queryDecoded: 0,
		querySortedRows: 0,
		/** Successful generation builds (published under generations/ + CURRENT). */
		generationBuilds: 0,
		/** Builds that failed with a real error (I/O, corruption). */
		generationBuildErrors: 0,
		/** Builds discarded because the ground shifted under them (rotation, WAL
		*  rollback, queue overflow, close) — expected churn, not an error. */
		generationBuildAborts: 0,
		generationBuildDurationMs: 0,
		/** Opens served by a published generation (no full index rebuild). */
		generationLoads: 0,
		/** Opens that fell back to the legacy full recovery (no/invalid
		*  generation); the sticky reason is in lastGenerationFallback. */
		generationLoadFallbacks: 0,
		lastGenerationFallback: null,
		generationLoadDurationMs: 0,
		/** Individual index images rejected at generation load (definition hash
		*  mismatch, corrupt file) and rebuilt from the loaded store. */
		generationIndexRebuilds: 0,
		/** Successful bounded text builds actually hosted by a worker thread. */
		textWorkerBuilds: 0,
		/** Bounded text builds hosted inline because worker startup was unavailable. */
		textWorkerFallbacks: 0,
		/** Sticky reason for the most recent inline fallback. */
		lastTextWorkerFallback: null,
		/** Worker runs that failed after the ready handshake (crash/OOM/ENOSPC).
		*  Expected owner/shutdown cancellation is not an error. */
		textWorkerErrors: 0,
		/** Deferred open-time text base builds (no-generation fallback path):
		*  bases committed by the background maintenance task, and builds that
		*  finally failed after every retry (their indexes keep raising
		*  TextIndexBuildingError until a later build attaches a base). */
		textDeferredBuilds: 0,
		textDeferredBuildErrors: 0
	};
}
// ../../packages/minidb/src/wal-group.ts
var WalGroupTracker = class {
	deps;
	/** Pre-group rollback state of every in-flight flush group, keyed per WAL:
	*  a compaction rotation replaces the WAL and each side's batchIds are
	*  independent. Entries are dropped when their group fully settles. */
	pendingGroups = /* @__PURE__ */ new Map();
	/** The group groupFor returned most recently (see groupFor); invalidated
	*  when that group settles or rolls back. batchIds are monotonic per WAL,
	*  so a stale (wal, batchId) pair can never collide with a later group. */
	lastGroup = null;
	/** Serializes in-place WAL recoveries (poison → truncate → resume), the same
	*  promise-chain style as uniqueWriteLock. Never rejects (a failed recovery
	*  lands in writeDisabled instead). Non-private (package-internal by
	*  convention): MiniDb's close / catch-up / backup paths read it through
	*  private views. */
	walRecoveryChain = Promise.resolve();
	/** False while a kicked recovery may still be running. Write-op commit
	*  bodies check it BEFORE awaiting walRecoveryChain: with no recovery in
	*  flight the commit path takes zero extra awaits (hot path), while a write
	*  issued after a failure queues behind the recovery instead of hitting the
	*  still-poisoned WAL. Non-private (see walRecoveryChain). */
	walRecoveryIdle = true;
	/** The poison object the current recovery chain covers (dedupe key for
	*  kickWalRecovery; each poison event is a fresh object identity). */
	walRecoveryCovers = null;
	constructor(deps) {
		this.deps = deps;
	}
	/** Register one op of a flush group (one call per op awaiting a frame) and
	*  return the group; null when the frame never entered a group (batchId < 0:
	*  a sealed/closed/poisoned appendLoc — those use the per-op rollback).
	*  lastGroup caches the previous lookup: ops of one flush burst share the
	*  same (wal, batchId), so they hit two reference compares instead of two
	*  map lookups. */
	groupFor(wal, batchId) {
		if (batchId < 0) return null;
		const last = this.lastGroup;
		if (last && last.wal === wal && last.batchId === batchId) {
			last.group.pending++;
			return last.group;
		}
		let byId = this.pendingGroups.get(wal);
		if (!byId) {
			byId = /* @__PURE__ */ new Map();
			this.pendingGroups.set(wal, byId);
		}
		let g = byId.get(batchId);
		if (!g) {
			g = {
				pre: /* @__PURE__ */ new Map(),
				pending: 0,
				rolledBack: false
			};
			byId.set(batchId, g);
		}
		g.pending++;
		this.lastGroup = {
			wal,
			batchId,
			group: g
		};
		return g;
	}
	/** Record a key's pre-group record; the earliest capture per group wins. */
	groupNoteKey(group, pk, prev) {
		if (group && !group.pre.has(pk)) group.pre.set(pk, prev);
	}
	/** The op's frame landed: drop the group's pre-state once every op settled. */
	settleGroup(group, wal, batchId) {
		if (!group) return;
		if (--group.pending === 0 && !group.rolledBack) {
			const byId = this.pendingGroups.get(wal);
			byId?.delete(batchId);
			if (byId && byId.size === 0) this.pendingGroups.delete(wal);
			if (this.lastGroup?.group === group) this.lastGroup = null;
		}
	}
	/** Roll a failed group back as a whole: every touched key returns to its
	*  pre-group record. Uses the unguarded restoreGroupKey — flush-group
	*  ordering itself guarantees no legally-committed later op exists (a
	*  poison rejects every queued frame, and the rollbacks unwind newest
	*  group first because the WAL rejects queued frames in reverse enqueue
	*  order), so the per-op seq guard would only misfire here: an earlier
	*  group's pre-state must win even after a later group's rollback re-seqd
	*  the record. Idempotent per group. */
	rollbackGroup(group, wal, batchId) {
		if (!group || group.rolledBack) return;
		group.rolledBack = true;
		for (const [pk, prev] of group.pre) this.deps.restoreGroupKey(pk, prev);
		const byId = this.pendingGroups.get(wal);
		byId?.delete(batchId);
		if (byId && byId.size === 0) this.pendingGroups.delete(wal);
		if (this.lastGroup?.group === group) this.lastGroup = null;
	}
	/** Tag a failure past the commit point as ambiguous: the op's frame may
	*  have reached the OS — and its value was visible to in-process readers
	*  between applyOp and the group rollback — before the failure revoked it,
	*  so the caller must not assume the write had no effect. Errors thrown
	*  before the commit point (validation, unique violation, maxMemory,
	*  write-disabled) carry no flag: those definitely had no effect.
	*  WAL_SEALED is excluded too: retryOnWalSeal transparently retries it. */
	markAmbiguous(err) {
		if (err && typeof err === "object" && err.code !== "WAL_SEALED") err.ambiguous = true;
		return err;
	}
	/** Kick the in-place recovery for a poisoned WAL (single-flight; recoveries
	*  serialize on walRecoveryChain). Called from op catches after the group
	*  rollback — many ops can share one poison event, so a recovery already
	*  chained for THIS poison object is not chained again (a write storm's
	*  worth of catches costs one recovery, not one per op). No-op for
	*  anything that did not poison the WAL (e.g. a seal rejection during a
	*  compaction rotation). */
	kickWalRecovery(wal) {
		const poison = wal.poison;
		if (!poison || poison === this.walRecoveryCovers) return;
		this.walRecoveryCovers = poison;
		this.walRecoveryIdle = false;
		const chain = this.walRecoveryChain.then(() => this.deps.recoverWalInPlace(wal)).catch(() => {});
		this.walRecoveryChain = chain;
		chain.finally(() => {
			if (this.walRecoveryChain === chain) {
				this.walRecoveryIdle = true;
				this.walRecoveryCovers = null;
			}
		});
	}
	/** Write-op gate at the start of every commit body: throws synchronously
	*  while writes are disabled; returns the recovery chain to await while a
	*  recovery is in flight, null otherwise — so the hot path pays zero extra
	*  microtasks (`const g = this.walRecoveryGate(); if (g) await g;`).
	*  Correctness never depends on the gate alone: an op that races a poison
	*  past the check is still rejected by the WAL itself and rolls its group
	*  back. */
	walRecoveryGate() {
		if (this.deps.writeDisabled()) throw this.writeDisabledError();
		return this.walRecoveryIdle ? null : this.walRecoveryChain;
	}
	writeDisabledError() {
		const cause = this.deps.writeDisabled();
		return Object.assign(/* @__PURE__ */ new Error(`MiniDb writes are disabled: in-place WAL recovery failed: ${cause instanceof Error ? cause.message : String(cause)}`), {
			code: "WAL_WRITE_DISABLED",
			cause
		});
	}
};
// ../../packages/minidb/src/write-path.ts
var WritePath = class {
	deps;
	/** Scratch out-param for applyOp's pre-state capture. Live only within the
	*  synchronous apply section of a commit body (shared safely because
	*  nothing awaits while it is read); callers lift the reference into a
	*  local before any await. Avoids one small allocation per write op. */
	applyBox = { prev: void 0 };
	constructor(deps) {
		this.deps = deps;
	}
	/** Park a write op while a compaction rotation is in flight, accounting the
	*  wait so compactionRotationPauseMs reflects the writer-visible pause
	*  (as opposed to compactionRotationDurationMs, the rotation's wall time). */
	async awaitRotation() {
		const rl = this.deps.rotateLock();
		if (!rl) return;
		const t0 = performance.now();
		await rl;
		this.deps.stats.compactionRotationPauseMs += performance.now() - t0;
	}
	hasUniqueIndexes() {
		return this.deps.indexes.hasUnique();
	}
	/**
	* Run a write-op commit body, transparently retrying once when the commit
	* raced a compaction rotation: an op that passed the _rotateLock gate check
	* just before it was set can hit the freshly-sealed old WAL (code
	* 'WAL_SEALED') between the gate and its append, or — one step later in the
	* rotation — the already-closed but not-yet-replaced old WAL (the untyped
	* 'WAL is closed'; only retried while a rotation is actually in flight, so a
	* write after db.close() still fails). The op rolls its in-memory side
	* effects back on a failed append, so re-running the (idempotent) commit
	* body against the post-rotation WAL is safe.
	*/
	async retryOnWalSeal(commit) {
		try {
			await commit();
		} catch (error) {
			const code = error.code;
			const sealed = code === "WAL_SEALED";
			const closedMidRotation = this.deps.rotateLock() !== null && code === "WAL_CLOSED";
			if (!sealed && !closedMidRotation) throw error;
			await this.awaitRotation();
			await commit();
		}
	}
	async evictKey(pk) {
		if (!this.deps.store().recordBytes(pk)) return;
		const op = this.prepareDel(Buffer.from(pk, "binary"));
		const commit = async () => {
			const recoveryGate = this.deps.walGroups.walRecoveryGate();
			if (recoveryGate) await recoveryGate;
			const wal = this.deps.wal();
			const appended = wal.appendLoc(encodeFrame({
				type: 2,
				key: op.key
			}));
			const group = this.deps.walGroups.groupFor(wal, appended.batchId);
			const applied = this.applyBox;
			let prev;
			let seq;
			try {
				this.applyOp(op, applied);
				prev = applied.prev;
				seq = this.deps.store().map.get(op.pk)?.seq;
			} catch (error) {
				appended.done.catch(() => {});
				if (group) {
					wal.poisonPending(error);
					this.deps.walGroups.groupNoteKey(group, op.pk, applied.prev);
					this.deps.walGroups.rollbackGroup(group, wal, appended.batchId);
					this.deps.walGroups.kickWalRecovery(wal);
				} else this.restoreGroupKey(op.pk, applied.prev);
				throw this.deps.walGroups.markAmbiguous(error);
			}
			this.deps.walGroups.groupNoteKey(group, op.pk, prev);
			try {
				await appended.done;
				this.deps.stats.evictions++;
			} catch (error) {
				if (group) this.deps.walGroups.rollbackGroup(group, wal, appended.batchId);
				else this.restoreKey(op.pk, prev, seq);
				this.deps.walGroups.kickWalRecovery(wal);
				throw this.deps.walGroups.markAmbiguous(error);
			}
			this.deps.walGroups.settleGroup(group, wal, appended.batchId);
		};
		await this.retryOnWalSeal(commit);
	}
	checkKey(key) {
		if ((typeof key === "string" ? key.length : Buffer.from(key).length) > 128) throw new RangeError(`key too long (>128)`);
		if (typeof key === "string" && key.length === 0 || Buffer.isBuffer(key) && key.length === 0) throw new RangeError("key must be non-empty");
	}
	/** Swap a record this op just wrote over to its disk-backed WAL pointer.
	*  Must only run after the WAL frame's `done` resolved: appendLoc's offset
	*  is a prediction and the bytes are not in db.wal until the queued writev
	*  lands, so publishing the pointer earlier let synchronous disk readers
	*  (compaction's snapshot phase, get) read past the end of the file.
	*  Skipped when the WAL was rotated by a compaction meanwhile (the pointer
	*  would reference the old file's offsets) or when the record was
	*  overwritten/deleted since; the record then keeps its in-memory ref —
	*  correct, just held in RAM until the next snapshot. */
	publishWalRef(pk, wal, seq, loc, expireAt, dt) {
		if (this.deps.wal() !== wal || seq === void 0) return;
		const cur = this.deps.store().map.get(pk);
		if (!cur || cur.seq !== seq) return;
		this.deps.store().setRef(pk, {
			kind: "disk",
			loc
		}, expireAt, dt);
	}
	async set(key, value, { ttl, dt } = {}) {
		this.deps.ensureOpen();
		this.deps.ensureWritable();
		this.checkKey(key);
		if (!this.deps.writeOps.enter()) throw backupInProgressError();
		try {
			await this.awaitRotation();
			const run = async () => {
				const op = this.prepareSet(key, value, {
					ttl,
					dt
				});
				if (this.deps.indexes.size > 0 && this.deps.indexable(op.canonical)) this.deps.indexes.checkUnique(op.pk, op.canonical);
				await this.deps.memoryGuard.ensureMemoryFor([op]);
				await this.retryOnWalSeal(() => this.commitSetOp(op));
			};
			if (this.hasUniqueIndexes()) await this.deps.serializeUniqueWrites(run);
			else await run();
		} finally {
			this.deps.writeOps.leave();
		}
	}
	/** The set() commit body: append the frame and apply the prepared op,
	*  rolling back (per-op or group) when the WAL write fails. */
	async commitSetOp(op) {
		const recoveryGate = this.deps.walGroups.walRecoveryGate();
		if (recoveryGate) await recoveryGate;
		const frame = encodeFrame({
			type: 1,
			key: op.key,
			value: op.value,
			meta: op.meta,
			expireAt: op.expireAt
		});
		const wal = this.deps.wal();
		const appended = wal.appendLoc(frame);
		const group = this.deps.walGroups.groupFor(wal, appended.batchId);
		const applied = this.applyBox;
		let prev;
		let seq;
		try {
			this.applyOp(op, applied);
			prev = applied.prev;
			seq = this.deps.store().map.get(op.pk)?.seq;
		} catch (error) {
			appended.done.catch(() => {});
			if (group) {
				wal.poisonPending(error);
				this.deps.walGroups.groupNoteKey(group, op.pk, applied.prev);
				this.deps.walGroups.rollbackGroup(group, wal, appended.batchId);
				this.deps.walGroups.kickWalRecovery(wal);
			} else this.restoreGroupKey(op.pk, applied.prev);
			throw this.deps.walGroups.markAmbiguous(error);
		}
		this.deps.walGroups.groupNoteKey(group, op.pk, prev);
		try {
			await appended.done;
		} catch (error) {
			if (group) this.deps.walGroups.rollbackGroup(group, wal, appended.batchId);
			else this.restoreKey(op.pk, prev, seq);
			this.deps.walGroups.kickWalRecovery(wal);
			throw this.deps.walGroups.markAmbiguous(error);
		}
		this.deps.walGroups.settleGroup(group, wal, appended.batchId);
		if (this.deps.valueMode() === "disk") this.publishWalRef(op.pk, wal, seq, {
			file: "wal",
			off: appended.offset + 22 + op.key.length,
			len: op.value.length
		}, op.expireAt, op.dtNorm);
		this.deps.maybeAutoCompact();
	}
	async del(key) {
		this.deps.ensureOpen();
		this.deps.ensureWritable();
		if (!this.deps.writeOps.enter()) throw backupInProgressError();
		try {
			this.checkKey(key);
			await this.awaitRotation();
			if (!this.deps.store().has(toKStr$1(key))) return false;
			const op = this.prepareDel(key);
			await this.deps.memoryGuard.ensureMemoryFor([op]);
			const commit = async () => {
				const recoveryGate = this.deps.walGroups.walRecoveryGate();
				if (recoveryGate) await recoveryGate;
				const wal = this.deps.wal();
				const appended = wal.appendLoc(encodeFrame({
					type: 2,
					key: op.key
				}));
				const group = this.deps.walGroups.groupFor(wal, appended.batchId);
				const applied = this.applyBox;
				let prev;
				let seq;
				try {
					this.applyOp(op, applied);
					prev = applied.prev;
					seq = this.deps.store().map.get(op.pk)?.seq;
				} catch (error) {
					appended.done.catch(() => {});
					if (group) {
						wal.poisonPending(error);
						this.deps.walGroups.groupNoteKey(group, op.pk, applied.prev);
						this.deps.walGroups.rollbackGroup(group, wal, appended.batchId);
						this.deps.walGroups.kickWalRecovery(wal);
					} else this.restoreGroupKey(op.pk, applied.prev);
					throw this.deps.walGroups.markAmbiguous(error);
				}
				this.deps.walGroups.groupNoteKey(group, op.pk, prev);
				try {
					await appended.done;
				} catch (error) {
					if (group) this.deps.walGroups.rollbackGroup(group, wal, appended.batchId);
					else this.restoreKey(op.pk, prev, seq);
					this.deps.walGroups.kickWalRecovery(wal);
					throw this.deps.walGroups.markAmbiguous(error);
				}
				this.deps.walGroups.settleGroup(group, wal, appended.batchId);
				this.deps.maybeAutoCompact();
			};
			await this.retryOnWalSeal(commit);
			return true;
		} finally {
			this.deps.writeOps.leave();
		}
	}
	/** Atomically apply a batch of operations (all-or-nothing). */
	async batch(ops) {
		this.deps.ensureOpen();
		this.deps.ensureWritable();
		if (!this.deps.writeOps.enter()) throw backupInProgressError();
		try {
			await this.awaitRotation();
			if (!ops || ops.length === 0) return;
			const run = async () => {
				const prepared = ops.map((o) => this.prepareOp(o));
				if (this.deps.indexes.size > 0) this.deps.indexes.checkUniqueBatch(prepared.map((o) => ({
					pk: o.pk,
					op: o.type === 2 ? "del" : "set",
					doc: o.canonical
				})));
				await this.deps.memoryGuard.ensureMemoryFor(prepared);
				await this.retryOnWalSeal(() => this.commitBatchOps(prepared));
			};
			if (this.hasUniqueIndexes()) await this.deps.serializeUniqueWrites(run);
			else await run();
		} finally {
			this.deps.writeOps.leave();
		}
	}
	/** The batch() commit body: append one BATCH frame and apply every prepared
	*  op, rolling the whole batch back when the WAL write fails. */
	async commitBatchOps(prepared) {
		const recoveryGate = this.deps.walGroups.walRecoveryGate();
		if (recoveryGate) await recoveryGate;
		const body = encodeBatchOps(prepared.map((op) => ({
			type: op.type,
			key: op.key,
			value: op.value,
			meta: op.meta,
			expireAt: op.expireAt
		})));
		const frame = encodeFrame({
			type: 3,
			key: Buffer.alloc(0),
			value: body
		});
		const wal = this.deps.wal();
		const appended = wal.appendLoc(frame);
		const group = this.deps.walGroups.groupFor(wal, appended.batchId);
		const prevs = /* @__PURE__ */ new Map();
		const applied = this.applyBox;
		let cur = null;
		try {
			for (const op of prepared) {
				cur = op;
				this.applyOp(op, applied);
				if (!prevs.has(op.pk)) prevs.set(op.pk, applied.prev);
			}
		} catch (error) {
			if (cur && !prevs.has(cur.pk)) prevs.set(cur.pk, applied.prev);
			appended.done.catch(() => {});
			if (group) {
				wal.poisonPending(error);
				for (const [pk, p] of prevs) this.deps.walGroups.groupNoteKey(group, pk, p);
				this.deps.walGroups.rollbackGroup(group, wal, appended.batchId);
				this.deps.walGroups.kickWalRecovery(wal);
			} else for (const [pk, p] of prevs) this.restoreGroupKey(pk, p);
			throw this.deps.walGroups.markAmbiguous(error);
		}
		for (const [pk, p] of prevs) this.deps.walGroups.groupNoteKey(group, pk, p);
		const seqs = /* @__PURE__ */ new Map();
		for (const pk of prevs.keys()) seqs.set(pk, this.deps.store().map.get(pk)?.seq);
		const lastSet = /* @__PURE__ */ new Map();
		if (this.deps.valueMode() === "disk") {
			const bodyOff = appended.offset + 22;
			const opRefs = scanBatchOpRefs(body, 0);
			for (let i = 0; i < prepared.length; i++) {
				const op = prepared[i];
				const ref = opRefs[i];
				if (op.type === 1 && ref) lastSet.set(op.pk, {
					op,
					loc: {
						file: "wal",
						off: bodyOff + ref.valueOff,
						len: ref.valLen
					},
					seq: seqs.get(op.pk)
				});
			}
		}
		try {
			await appended.done;
		} catch (error) {
			if (group) this.deps.walGroups.rollbackGroup(group, wal, appended.batchId);
			else for (const [pk, prev] of prevs) this.restoreKey(pk, prev, seqs.get(pk));
			this.deps.walGroups.kickWalRecovery(wal);
			throw this.deps.walGroups.markAmbiguous(error);
		}
		this.deps.walGroups.settleGroup(group, wal, appended.batchId);
		for (const [pk, { op, loc, seq }] of lastSet) this.publishWalRef(pk, wal, seq, loc, op.expireAt, op.dtNorm);
		this.deps.maybeAutoCompact();
	}
	prepareOp(o) {
		if (o.op === "set") return this.prepareSet(o.key, o.value, {
			ttl: o.ttl,
			dt: o.dt
		});
		if (o.op === "del") return this.prepareDel(o.key);
		throw new TypeError(`unknown batch op: ${o.op}`);
	}
	prepareSet(key, value, { ttl, dt } = {}) {
		this.checkKey(key);
		const pk = toKStr$1(key);
		const dtNorm = normDt(dt);
		parseTtlMs(ttl);
		const expireAt = ttl ? Date.now() + Math.floor(ttl) : 0;
		const vbuf = this.deps.encode(value);
		const canonical = this.deps.codecName() === "json" ? this.deps.decode(vbuf) : value;
		let textTokens = null;
		if (this.deps.textRegistry.text.size > 0) {
			textTokens = /* @__PURE__ */ new Map();
			for (const ti of this.deps.textRegistry.text.values()) textTokens.set(ti, this.deps.indexable(canonical) ? ti.prepareAdd(canonical) : null);
		}
		const meta = dtNorm ? Buffer.from(JSON.stringify({ dt: dtNorm })) : null;
		return {
			type: 1,
			key: toBuf(key),
			value: vbuf,
			meta,
			expireAt,
			dtNorm,
			pk,
			canonical,
			textTokens
		};
	}
	prepareDel(key) {
		this.checkKey(key);
		return {
			type: 2,
			key: toBuf(key),
			value: null,
			meta: null,
			expireAt: 0,
			dtNorm: null,
			pk: toKStr$1(key),
			canonical: void 0,
			textTokens: null
		};
	}
	/** Apply a prepared op to the store + derived indexes, writing the key's
	*  pre-op logical record into `out.prev` so the caller can roll back (or
	*  poison + group-rollback) on failure. `out.prev` is assigned before any
	*  mutation, so it is valid even when the apply throws.
	*
	*  CONTRACT: applyOp must not throw. Stage 11 makes this structural: every
	*  fallible input validation lives in the prepare phase (key/ttl checks,
	*  encoding, the canonical decode, tokenization + custom-tokenizer output
	*  validation) and unique checks run before ensureMemoryFor, so the body
	*  below is pure assignment against pre-validated data. The ONE remaining
	*  fallible branch is a text index registered between prepare and apply
	*  (a createTextIndex racing this write — see the comment inline); the
	*  commit bodies' defensive try (stage 7) stays as the backstop for it and
	*  for catastrophic store I/O. */
	applyOp(op, out) {
		const oldBuf = this.deps.store().get(op.pk);
		out.prev = oldBuf !== void 0 ? this.deps.store().map.get(op.pk) : void 0;
		const oldDoc = oldBuf !== void 0 ? this.deps.decode(oldBuf) : void 0;
		if (op.type === 1) {
			this.deps.store().set(op.key, op.value, op.expireAt, op.dtNorm);
			this.deps.dt.set(op.pk, op.dtNorm);
			this.deps.compound.add(op.pk, op.canonical, op.dtNorm);
			if (this.deps.indexes.size > 0) {
				if (this.deps.indexable(oldDoc)) this.deps.indexes.remove(op.pk, oldDoc);
				if (this.deps.indexable(op.canonical)) this.deps.indexes.add(op.pk, op.canonical);
			}
			for (const ti of this.deps.textRegistry.text.values()) {
				const tokens = op.textTokens?.get(ti);
				if (tokens !== void 0) {
					if (tokens === null) ti.remove(op.pk);
					else ti.addPrepared(op.pk, tokens);
				} else if (this.deps.indexable(op.canonical)) ti.add(op.pk, op.canonical);
				else ti.remove(op.pk);
			}
		} else if (op.type === 2) {
			if (this.deps.store().del(op.key)) {
				this.deps.memoryGuard.access.delete(op.pk);
				this.deps.dt.del(op.pk);
				this.deps.compound.remove(op.pk);
				if (this.deps.indexes.size > 0 && this.deps.indexable(oldDoc)) this.deps.indexes.remove(op.pk, oldDoc);
				for (const ti of this.deps.textRegistry.text.values()) ti.remove(op.pk);
			}
		}
		const gb = this.deps.generationBuilder.genBuild;
		if (gb) {
			gb.queue.push({
				type: op.type,
				pk: op.pk,
				value: op.value,
				expireAt: op.expireAt,
				dtNorm: op.dtNorm,
				canonical: op.canonical
			});
			gb.bytes += (op.value ? op.value.length : 0) + 64;
		}
		if (op.type === 1) this.deps.memoryGuard.touchAccess(op.pk);
	}
	/** Roll a key back to its pre-op record across the store and every derived
	*  index. Used when a WAL write fails after applyOp already mutated state.
	*  `appliedSeq` is the store record's seq captured right after THIS attempt's
	*  own apply (undefined when the op left the key absent, i.e. a DEL). The
	*  restore is skipped when the key's current state no longer matches it —
	*  the same seq-identity guard publishWalRef uses — because a later same-key
	*  op committed (or an expiry reaped the key) meanwhile, and rolling back
	*  over it would wipe state that is already durable. This per-op path covers
	*  frames that never entered a flush group (batchId < 0: a seal/rotation
	*  race) and cross-group interleaves with retryOnWalSeal retries; grouped
	*  failures roll back via rollbackGroup instead. */
	restoreKey(pk, prev, appliedSeq) {
		const cur = this.deps.store().map.get(pk);
		if (appliedSeq === void 0 ? cur !== void 0 : cur?.seq !== appliedSeq) return;
		this.restoreGroupKey(pk, prev);
	}
	/** The unguarded restore core behind restoreKey and the flush-group
	*  rollback: put the key back to `prev` across the store and every derived
	*  index (TTL/access/dt/secondary/compound/text). */
	restoreGroupKey(pk, prev) {
		const gb = this.deps.generationBuilder.genBuild;
		if (gb) gb.aborted = true;
		if (this.deps.indexes.size > 0) this.deps.indexes.remove(pk, void 0);
		for (const ti of this.deps.textRegistry.text.values()) ti.remove(pk);
		this.deps.dt.del(pk);
		this.deps.compound.remove(pk);
		if (prev === void 0) {
			this.deps.store().del(pk);
			this.deps.memoryGuard.access.delete(pk);
			return;
		}
		this.deps.store().setRef(pk, prev.ref, prev.expireAt, prev.dt);
		this.deps.memoryGuard.touchAccess(pk);
		const doc = this.deps.decode(this.deps.store().get(pk));
		this.deps.dt.set(pk, prev.dt);
		this.deps.compound.add(pk, doc, prev.dt);
		if (this.deps.indexable(doc)) this.deps.indexes.add(pk, doc);
		for (const ti of this.deps.textRegistry.text.values()) if (this.deps.indexable(doc)) ti.add(pk, doc);
	}
	/** Apply one recovered WAL frame during catchUpFromWal: the same ops
	*  open-time recovery derives from it (frameToOps), plus the incremental
	*  derived-index maintenance applyOp performs on the write path — minus
	*  unique checks: the writer already validated, and intermediate frame
	*  states must apply literally (LWW). Cooperative: yields between primitive
	*  ops when the caller's slicer (walApplySlicer budgets) fires — a BATCH
	*  frame unrolls into thousands of ops, so per-op yielding is what bounds a
	*  catch-up slice on the host's event loop. */
	async applyRecoveredFrameAsync(f, fd, slice) {
		for (const op of frameToOps(f, "wal", fd, this.deps.valueMode())) {
			this.applyRecoveredOp(op);
			if (slice()) await yieldToLoop();
		}
	}
	applyRecoveredOp(op) {
		const pk = toKStr$1(op.key);
		const oldDoc = this.deps.indexes.size > 0 ? this.deps.decode(this.deps.store().get(pk)) : void 0;
		if (op.type === 2) {
			if (!this.deps.store().del(pk)) return;
			this.deps.memoryGuard.access.delete(pk);
			this.deps.dt.del(pk);
			this.deps.compound.remove(pk);
			if (this.deps.indexes.size > 0 && this.deps.indexable(oldDoc)) this.deps.indexes.remove(pk, oldDoc);
			for (const ti of this.deps.textRegistry.text.values()) ti.remove(pk);
			return;
		}
		this.deps.store().setRef(op.key, op.ref, op.expireAt, op.dt);
		const buf = this.deps.store().get(pk);
		if (buf === void 0) return;
		this.deps.dt.set(pk, op.dt);
		if (this.deps.indexes.size > 0 || this.deps.textRegistry.text.size > 0 || this.deps.compound.size > 0) {
			const doc = this.deps.decode(buf);
			this.deps.compound.add(pk, doc, op.dt);
			if (this.deps.indexes.size > 0) {
				if (this.deps.indexable(oldDoc)) this.deps.indexes.remove(pk, oldDoc);
				if (this.deps.indexable(doc)) this.deps.indexes.add(pk, doc);
			}
			for (const ti of this.deps.textRegistry.text.values()) if (this.deps.indexable(doc)) ti.add(pk, doc);
			else ti.remove(pk);
		}
		this.deps.memoryGuard.touchAccess(pk);
	}
	async expire(key, ttlMs) {
		this.deps.ensureOpen();
		this.deps.ensureWritable();
		if (!this.deps.writeOps.enter()) throw backupInProgressError();
		try {
			this.checkKey(key);
			await this.awaitRotation();
			const k = toKStr$1(key);
			const cur = this.deps.store().getRecord(k);
			if (cur === void 0) return false;
			parseTtlMs(ttlMs);
			const expireAt = Date.now() + Math.floor(ttlMs);
			const curValue = this.deps.store().get(k);
			if (curValue === void 0) return false;
			const meta = cur.dt ? Buffer.from(JSON.stringify({ dt: cur.dt })) : null;
			const keyBuf = toBuf(key);
			const frame = encodeFrame({
				type: 1,
				key: keyBuf,
				value: curValue,
				meta,
				expireAt
			});
			const commit = async () => {
				const recoveryGate = this.deps.walGroups.walRecoveryGate();
				if (recoveryGate) await recoveryGate;
				const wal = this.deps.wal();
				const appended = wal.appendLoc(frame);
				const group = this.deps.walGroups.groupFor(wal, appended.batchId);
				const prev = this.deps.store().map.get(k);
				let seq;
				try {
					this.deps.store().set(k, curValue, expireAt, cur.dt);
					const gb = this.deps.generationBuilder.genBuild;
					if (gb) {
						gb.queue.push({
							type: 1,
							pk: k,
							value: curValue,
							expireAt,
							dtNorm: cur.dt,
							canonical: void 0,
							storeOnly: true
						});
						gb.bytes += curValue.length + 64;
					}
					seq = this.deps.store().map.get(k)?.seq;
				} catch (error) {
					appended.done.catch(() => {});
					if (group) {
						wal.poisonPending(error);
						this.deps.walGroups.groupNoteKey(group, k, prev);
						this.deps.walGroups.rollbackGroup(group, wal, appended.batchId);
						this.deps.walGroups.kickWalRecovery(wal);
					} else this.restoreGroupKey(k, prev);
					throw this.deps.walGroups.markAmbiguous(error);
				}
				this.deps.walGroups.groupNoteKey(group, k, prev);
				try {
					await appended.done;
				} catch (error) {
					if (group) this.deps.walGroups.rollbackGroup(group, wal, appended.batchId);
					else this.restoreKey(k, prev, seq);
					this.deps.walGroups.kickWalRecovery(wal);
					throw this.deps.walGroups.markAmbiguous(error);
				}
				this.deps.walGroups.settleGroup(group, wal, appended.batchId);
				if (this.deps.valueMode() === "disk") this.publishWalRef(k, wal, seq, {
					file: "wal",
					off: appended.offset + 22 + keyBuf.length,
					len: curValue.length
				}, expireAt, cur.dt);
				this.deps.maybeAutoCompact();
			};
			await this.retryOnWalSeal(commit);
			return true;
		} finally {
			this.deps.writeOps.leave();
		}
	}
};
// ../../packages/minidb/src/mini-db.ts
var MiniDb = class MiniDb {
	dir;
	walPath;
	indexPath;
	compoundIndexPath;
	store;
	wal;
	valueReader;
	valueMode = "memory";
	indexes = new IndexManager();
	dt = new DtIndex();
	compound = new CompoundIndexManager();
	/** Text-index registry state lives in the TextRegistry facet (declared
	*  below, after stats); these views keep the generation / compaction /
	*  write paths' call sites unchanged. */
	get text() {
		return this.textRegistry.text;
	}
	get textDefs() {
		return this.textRegistry.textDefs;
	}
	get textDrops() {
		return this.textRegistry.textDrops;
	}
	codec;
	codecName = "buffer";
	fsyncPolicy = "everysec";
	syncIntervalMs = 1e3;
	/** Lifecycle state machine. 'closing' is a real state (not just a flag on
	*  the way down): a cleanup failure leaves the instance there so a later
	*  close() call can retry the remaining cleanup, and ensureOpen rejects
	*  'closing' and 'closed' alike. */
	state = "open";
	/** The in-flight close() cleanup pass, shared by concurrent close() calls. */
	closePromise = null;
	recoveryInfo = null;
	/** Continuation watermark for catchUpFromWal: the WAL inode + applied
	*  offset as advanced by the last successful catch-up (recoveryInfo's scan
	*  endpoint anchors the first call). `tail` fingerprint the bytes below the
	*  offset: identity alone cannot tell an append from an in-place rewrite of
	*  the scanned prefix (recoverWalInPlace truncates this same inode and new
	*  frames are written back below the stored offset). */
	walTail = null;
	/** Catch-up serializer: the sliced async apply yields to the event loop, so
	*  overlapping catch-ups would interleave op-by-op (the pre-async apply was
	*  atomic per call by virtue of being synchronous). Chaining restores that
	*  per-call atomicity; a caller queued behind another catch-up observes the
	*  advanced watermark and no-ops or falls back to a full reopen. */
	catchUpChain = Promise.resolve();
	readOnly = false;
	lock = null;
	compactThresholdBytes = 67108864;
	autoCompact = true;
	compacting = false;
	_compactDone = null;
	/** Set only during compaction's short rotation critical section; writers park
	*  on it (see the write-op gate). Null the rest of the time, so the snapshot
	*  phase of compaction is fully non-blocking. */
	_rotateLock = null;
	lastCompactError = null;
	maxMemoryBytes = null;
	maxMemoryPolicy = "reject";
	/** The LRU access set lives in the MemoryGuard facet (declared below, after
	*  stats); this view keeps the class's delete-only call sites unchanged. */
	get access() {
		return this.memoryGuard.access;
	}
	/** Serializes write ops while any unique index exists (check-then-apply must
	*  be atomic against other writers). Shared promise-chain pattern — see
	*  serialize.ts. */
	serializeUniqueWrites = createSerializer();
	/** Per-sidecar mutation chains (one promise-chain mutex per index-definition
	*  sidecar file, plan 10): a create/drop runs its whole staged → persist →
	*  publish sequence under its sidecar's chain, so concurrent mutations of
	*  the SAME definition file can never interleave (before this, two
	*  concurrent creates shared one fixed .tmp — one renamed the other's tmp
	*  away — and a persist failure diverged the live registry from disk).
	*  Different sidecar types do NOT block each other, and the data write path
	*  (set/batch/del) never touches these chains. The in-chain rebuild is a
	*  full Store walk: index changes are rare admin operations, so holding the
	*  chain across the walk is the accepted trade-off. */
	secondaryDefChain = createSerializer();
	compoundDefChain = createSerializer();
	/** The WAL group-commit + in-place recovery gating facet (wal-group.ts):
	*  owns pendingGroups/lastGroup and the recovery chain state
	*  (walRecoveryChain/walRecoveryIdle/walRecoveryCovers); these views keep
	*  the close / catch-up / backup call sites unchanged. */
	walGroups = new WalGroupTracker({
		restoreGroupKey: (pk, prev) => this.restoreGroupKey(pk, prev),
		writeDisabled: () => this.writeDisabled,
		recoverWalInPlace: (wal) => this.recoverWalInPlace(wal)
	});
	get walRecoveryChain() {
		return this.walGroups.walRecoveryChain;
	}
	get walRecoveryIdle() {
		return this.walGroups.walRecoveryIdle;
	}
	/** Write-op gate + in-flight counter (plan 12's OpTracker): set/del/batch/
	*  expire run inside enter/leave, and backup() pauses the gate — the drain
	*  completion is backup's linearization point (every write acknowledged
	*  before it is in the backup; writes submitted meanwhile reject with
	*  BACKUP_IN_PROGRESS). close() does NOT drain it: an op in flight at close
	*  keeps its stage-7/8 semantics (its frame rejects as the WAL closes and
	*  the op rolls back). */
	writeOps = new OpTracker();
	/** Serializes whole backup() runs: two backups to the same destination would
	*  otherwise swap each other's freshly-renamed result aside and delete it,
	*  and even to different destinations they would duplicate the compaction +
	*  copy work. The write-gate pause itself is reference-counted and safe to
	*  overlap (see op-tracker.ts). Same promise-chain pattern as
	*  serializeUniqueWrites. */
	serializeBackups = createSerializer();
	/** Persistent index generations enabled (OpenOptions.indexGenerations,
	*  default true). When false the instance behaves exactly as before stage
	*  5: full open-time rebuild + root postings rebuilds after compaction. */
	indexGenerationsEnabled = true;
	/** Stage 6: the unified maintenance scheduler (compaction + generation
	*  builds: one heavy task at a time, backpressure, preflight, cancellation,
	*  drain on close). Created in open() once the directory is known. */
	maintenance;
	/** Stage 6: workerized text generation build enabled (rollback switch). */
	textBuildWorkerEnabled = true;
	/** Sticky fallback: a worker that failed to produce ANY result once (spawn
	*  failure) disables the worker path for the rest of this instance — the
	*  next build uses the in-thread staged path. */
	textWorkerDisabled = false;
	/** Stage 6: worker aggregation memory budget. */
	textBuildMemoryBytes = DEFAULT_TEXT_BUILD_MEMORY_BYTES;
	/** TUI-safe worker-slot policy: how long a worker-eligible text build
	*  queues for a process-wide slot before the bounded inline core is
	*  allowed as the last resort (never the unbounded staged aggregation). */
	textBuildSlotWaitMs = TEXT_BUILD_SLOT_WAIT_MS;
	/** Stage 6: maintenance I/O concurrency (snapshot grouped reads). */
	maintenanceIoConcurrency = 8;
	/** Defer the open-time full text rebuild (no-generation fallback) to a background
	*  bounded build (OpenOptions.deferOpenTextBuilds, default true). */
	deferTextBuildsEnabled = true;
	/** A read-only deferred build's private scratch dir (outside the db dir);
	*  created on first use, dropped on close (lifecycle.ts closeResources). */
	roScratchDir = null;
	/** Runtime generation-build trigger (see maybeAutoGenerationBuild):
	*  throttles — minimum interval between kicks, and the longer backoff
	*  after a build failed/aborted (public test knobs, same pattern as the
	*  search service's). */
	genBuildKickMinIntervalMs = 6e4;
	genBuildKickFailureBackoffMs = 3e5;
	lastGenBuildKickAt = 0;
	lastGenBuildFailureAt = 0;
	lastGenBuildError = null;
	/** Abort handle / mutation queue / single-flight guard / status of the
	*  generation build all live in the GenerationBuilder facet (declared
	*  below); these views keep the open / write / close paths' call sites
	*  unchanged (the write path feeds the SHARED genBuild object by
	*  reference). */
	get genBuildAbort() {
		return this.generationBuilder.genBuildAbort;
	}
	get genBuild() {
		return this.generationBuilder.genBuild;
	}
	get genBuildPromise() {
		return this.generationBuilder.genBuildPromise;
	}
	get generationInfo() {
		return this.generationBuilder.generationInfo;
	}
	/** Set when in-place WAL recovery's truncate fails (persistent I/O error):
	*  from then on every write op throws a WAL_WRITE_DISABLED error
	*  immediately; reads and close() keep working. The value is the truncate
	*  error (the cause). DESIGNED CONSEQUENCE: the WAL stays poisoned, so
	*  close() skips its final flush and the un-acked tail is LEFT in db.wal —
	*  a later reopen replays it and the rejected writes resurface. That is
	*  exactly why every commit-point failure is marked `ambiguous: true`: in
	*  this state the caller cannot assume a rejected write had no effect. */
	writeDisabled = null;
	stats = createMiniDbStats();
	/** Per-open lifecycle telemetry (the open() state machine + per-phase
	*  wall-clock timings): driven by lifecycle.ts and the generation loader,
	*  read through lifecycleStatus(). */
	lifecycle = new LifecycleTracker();
	/** The text-index registry facet (text-registry.ts): owns the live TextIndex
	*  map, the persisted definition list, and the staged-drop marks (declared
	*  after stats because the injected deps reference it; everything else is
	*  read lazily through the getters). */
	textRegistry = new TextRegistry({
		dir: () => this.dir,
		readOnly: () => this.readOnly,
		codecName: () => this.codecName,
		store: () => this.store,
		ensureOpen: () => this.ensureOpen(),
		ensureWritable: () => this.ensureWritable(),
		decode: (b) => this.decode(b),
		readValueAsync: (kstr) => this.readValueAsync(kstr),
		textRecords: () => this.textRecords(),
		persistTextIndexDefinitions: (defs) => this.persistTextIndexDefinitions(defs),
		boundedTextBuild: (name, ti, def, checkpoint) => this.boundedTextBuild(name, ti, def, checkpoint)
	});
	/** The maxMemory guard facet: owns the LRU access set and the
	*  projected-bytes enforce pass (declared after stats because the injected
	*  deps reference it; store/config are read lazily through the getters). */
	memoryGuard = new MemoryGuard({
		store: () => this.store,
		valueMode: () => this.valueMode,
		maxMemoryBytes: () => this.maxMemoryBytes,
		maxMemoryPolicy: () => this.maxMemoryPolicy,
		stats: this.stats,
		evictKey: (pk) => this.evictKey(pk)
	});
	/** The backup flow's injected deps (backup.ts); the callbacks read the
	*  live fields at call time, so the facet never holds stale references. */
	backupDeps = {
		dir: () => this.dir,
		stats: this.stats,
		ensureOpen: () => this.ensureOpen(),
		compacting: () => this.compacting,
		compactDone: () => this._compactDone,
		readOnly: () => this.readOnly,
		compact: () => this.compact(),
		pauseWrites: () => this.writeOps.pause(),
		resumeWrites: () => this.writeOps.resume(),
		serializeBackups: (fn) => this.serializeBackups(fn),
		walRecoveryChain: () => this.walRecoveryChain,
		flushWal: () => this.wal.flush()
	};
	/** The unified query engine facet (query-engine.ts): read-only; the index
	*  managers and the text map are stable references, store/codecName are
	*  read lazily through the getters. */
	queryEngine = new QueryEngine({
		store: () => this.store,
		indexes: this.indexes,
		dt: this.dt,
		text: this.text,
		codecName: () => this.codecName,
		stats: this.stats,
		decode: (b) => this.decode(b),
		readValueAsync: (kstr) => this.readValueAsync(kstr),
		ensureOpen: () => this.ensureOpen()
	});
	/** The generation machinery facet (generation-builder.ts): the load/build
	*  paths and the genBuild state (declared after queryEngine; every dep is
	*  either a stable reference or a lazy getter/callback). */
	generationBuilder = new GenerationBuilder({
		dir: () => this.dir,
		walPath: () => this.walPath,
		codecName: () => this.codecName,
		valueMode: () => this.valueMode,
		readOnly: () => this.readOnly,
		state: () => this.state,
		indexGenerationsEnabled: () => this.indexGenerationsEnabled,
		store: () => this.store,
		wal: () => this.wal,
		getValueReader: () => this.valueReader,
		setValueReader: (reader) => {
			this.valueReader = reader;
		},
		setRecoveryInfo: (info) => {
			this.recoveryInfo = info;
		},
		maintenance: () => this.maintenance,
		maintenanceTaskCtx: () => this.maintenanceTaskCtx,
		textBuildWorkerEnabled: () => this.textBuildWorkerEnabled,
		textWorkerDisabled: () => this.textWorkerDisabled,
		disableTextWorker: () => {
			this.textWorkerDisabled = true;
		},
		textBuildMemoryBytes: () => this.textBuildMemoryBytes,
		textBuildSlotWaitMs: () => this.textBuildSlotWaitMs,
		dt: this.dt,
		indexes: this.indexes,
		compound: this.compound,
		textRegistry: this.textRegistry,
		stats: this.stats,
		lifecycle: this.lifecycle,
		decode: (b) => this.decode(b),
		indexable: (v) => this.indexable(v),
		liveRecords: () => this.liveRecords(),
		liveRecordsRaw: () => this._liveRecordsRaw(),
		textRecords: () => this.textRecords(),
		seedAccessFromStore: () => this.seedAccessFromStore(),
		applyRecoveredOp: (op) => this.applyRecoveredOp(op),
		ensureOpen: () => this.ensureOpen(),
		ensureWritable: () => this.ensureWritable(),
		boundedTextBuild: (name, ti, def, checkpoint) => this.boundedTextBuild(name, ti, def, checkpoint),
		noteBuildFailure: (err) => {
			this.lastGenBuildFailureAt = Date.now();
			if (err !== void 0) this.lastGenBuildError = err;
		},
		noteBuildSuccess: () => {
			this.lastGenBuildError = null;
		}
	});
	/** The write path facet (write-path.ts): set/del/batch/expire and their
	*  whole commit machinery (declared last — it wires the other facets as
	*  collaborators; the wal-group / memory-guard / generation-builder
	*  callbacks that point back here are lazy, so init order is safe). */
	writePath = new WritePath({
		store: () => this.store,
		wal: () => this.wal,
		valueMode: () => this.valueMode,
		codecName: () => this.codecName,
		rotateLock: () => this._rotateLock,
		dt: this.dt,
		indexes: this.indexes,
		compound: this.compound,
		textRegistry: this.textRegistry,
		walGroups: this.walGroups,
		memoryGuard: this.memoryGuard,
		generationBuilder: this.generationBuilder,
		writeOps: this.writeOps,
		serializeUniqueWrites: (fn) => this.serializeUniqueWrites(fn),
		stats: this.stats,
		encode: (v) => this.encode(v),
		decode: (b) => this.decode(b),
		indexable: (v) => this.indexable(v),
		ensureOpen: () => this.ensureOpen(),
		ensureWritable: () => this.ensureWritable(),
		maybeAutoCompact: () => this.maybeAutoCompact()
	});
	/** The secondary + compound index admin facet (index-admin.ts). The
	*  persist seams below stay on MiniDb (tests stub them on the instance);
	*  the facet drives them through the injected callbacks. */
	indexAdmin = new IndexAdmin({
		indexes: this.indexes,
		compound: this.compound,
		dt: this.dt,
		textRegistry: this.textRegistry,
		store: () => this.store,
		codecName: () => this.codecName,
		ensureOpen: () => this.ensureOpen(),
		ensureWritable: () => this.ensureWritable(),
		decode: (b) => this.decode(b),
		indexable: (v) => this.indexable(v),
		stats: this.stats,
		liveRecords: () => this.liveRecords(),
		liveRecordsRaw: () => this._liveRecordsRaw(),
		secondaryDefChain: (fn) => this.secondaryDefChain(fn),
		compoundDefChain: (fn) => this.compoundDefChain(fn),
		persistIndexDefinitions: (defs) => this.persistIndexDefinitions(defs),
		persistCompoundIndexDefinitions: (defs) => this.persistCompoundIndexDefinitions(defs)
	});
	/** The read path facet (read-path.ts): KV reads, scans, dt reads, and the
	*  live-record generators every (re)build feed goes through. */
	readPath = new ReadPath({
		store: () => this.store,
		getValueReader: () => this.valueReader,
		dt: this.dt,
		memoryGuard: this.memoryGuard,
		decode: (b) => this.decode(b),
		indexable: (v) => this.indexable(v),
		ensureOpen: () => this.ensureOpen()
	});
	/** The private methods the lifecycle functions (lifecycle.ts) call back
	*  into; the fields they touch are read/written through the LifecycleHost
	*  view directly (see the non-private markers above). */
	lifecycleHooks = {
		onStoreExpire: (k, rec) => this.onStoreExpire(k, rec),
		loadIndexDefinitions: () => this.loadIndexDefinitions(),
		loadCompoundIndexDefinitions: () => this.loadCompoundIndexDefinitions(),
		loadTextIndexDefinitions: () => this.loadTextIndexDefinitions(),
		tryLoadGeneration: (mode) => this.tryLoadGeneration(mode),
		rebuildAllIndexes: () => this.rebuildAllIndexes(),
		submitCompaction: () => this.submitCompaction(),
		buildGeneration: (trigger) => this.buildGeneration(trigger),
		seedAccessFromStore: () => this.seedAccessFromStore(),
		closeAllTextIndexes: () => {
			for (const ti of this.text.values()) ti.close();
		},
		generationInfo: () => this.generationInfo,
		generationStale: () => this.generationStale(),
		genBuildAbort: () => this.genBuildAbort,
		genBuildPromise: () => this.genBuildPromise,
		walRecoveryIdle: () => this.walRecoveryIdle,
		walRecoveryChain: () => this.walRecoveryChain
	};
	/** Hook called by compaction after the store snapshot + WAL are rotated, so
	*  derived on-disk state can be rewritten against the new live set.
	*  Structural part of the CompactionTarget interface; the compaction awaits
	*  it, so it may be sync or async.
	*
	*  Stage 5: with index generations enabled this is ONE publish transaction
	*  — the snapshot rotation and the derived-state checkpoint (store image,
	*  dt/secondary/compound images, text postings) land as a single new
	*  generation, and the live text indexes rebase onto it. The synchronous
	*  rebuildTextPostings() tail no longer runs. With generations disabled the
	*  legacy behavior is kept exactly. */
	onCompacted = async () => {
		const t0 = performance.now();
		if (!this.indexGenerationsEnabled) {
			await this.rebuildTextPostings();
			const ms = performance.now() - t0;
			this.stats.compactionPostingsDurationMs += ms;
			this.stats.textRebuildDurationMs += ms;
			return;
		}
		await this.buildGeneration("compact");
		this.stats.compactionPostingsDurationMs += performance.now() - t0;
	};
	/** The scheduler context of the in-flight maintenance task: compaction's
	*  rotation reports its publishing phase through it (stage 6). */
	maintenanceTaskCtx = null;
	/** CompactionTarget hook: the rotation critical section is the
	*  compaction's publishing phase — a shutdown must wait it out instead of
	*  cancelling mid-rotation (stage 6). The scheduler's markPublishing is
	*  one-way, so 'running' needs no handling. */
	onMaintenancePhase = (phase) => {
		if (phase === "publishing") this.maintenanceTaskCtx?.markPublishing();
	};
	/** Queue a compaction on the maintenance scheduler (stage 6): one heavy
	*  task per database at a time; a duplicate submission dedupes onto the
	*  in-flight/queued one. */
	submitCompaction() {
		return this.maintenance.submit("compact", async (ctx) => {
			this.maintenanceTaskCtx = ctx;
			try {
				await compact(this);
			} finally {
				this.maintenanceTaskCtx = null;
			}
		});
	}
	static async open(opts) {
		const db = new MiniDb();
		await openMiniDb(db, opts, db.lifecycleHooks);
		return db;
	}
	/**
	* Open a database, and if opening fails due to corruption (not due to a live
	* lock), attempt the non-destructive repairs (drop the derived sidecars and
	* retry). A full destructive rebuild — deleting the directory and reopening
	* empty — requires `allowDestructiveRebuild: true` and is only appropriate
	* for a rebuildable cache; without it a corrupt database is rethrown as a
	* clear error and its data is never erased. A live lock is rethrown.
	*
	* The destructive rebuild only ever runs for an open that could OWN the
	* directory: an error tagged `readOnlyOpen` (opts.readOnly, or a lock that
	* degraded via onLockFail:'readonly') is rethrown untouched — rebuilding
	* means deleting files, and a read-only bystander must never mutate a live
	* writer's directory (lock-review repro: the readonly fallback deleted the
	* writer's sidecar, and in the strict-recovery shape the whole directory).
	*/
	static async openOrRebuild(opts, hooks = {}) {
		return openOrRebuildMiniDb(opts, hooks, (o) => MiniDb.open(o));
	}
	encode(v) {
		return this.codec.encode(v);
	}
	decode(b) {
		return b === void 0 ? void 0 : this.codec.decode(b);
	}
	pk(key) {
		return toKStr$1(key);
	}
	indexable(v) {
		return v !== null && typeof v === "object";
	}
	*liveRecords() {
		yield* this.readPath.liveRecords();
	}
	/** Live indexable records with canonical keys, for (re)building text indexes. */
	*textRecords() {
		yield* this.readPath.textRecords();
	}
	/** On-disk postings file path for a text index (root location — the legacy
	*  pre-generation home; the name sanitization lives in generation.ts). */
	textPostingsPath(name) {
		return this.textRegistry.textPostingsPath(name);
	}
	/** LEGACY postings maintenance (indexGenerations: false): rebuild every
	*  dirty text index's on-disk postings from the live Store (see
	*  TextRegistry.rebuildTextPostings). */
	async rebuildTextPostings() {
		return this.textRegistry.rebuildTextPostings();
	}
	async rebuildAllIndexes() {
		const deferred = /* @__PURE__ */ new Set();
		if (this.deferTextBuildsEnabled) for (const [name, ti] of this.text) {
			if (ti.hasCustomTokenizer) continue;
			if (!this.textBuildWorkerEnabled || this.textWorkerDisabled) continue;
			if (this.store.size < 4096) continue;
			deferred.add(name);
		}
		const textRebuildMsBefore = this.stats.textRebuildDurationMs;
		await this.indexAdmin.rebuildAllIndexes({ skipTextIndex: (name) => deferred.has(name) });
		this.lifecycle.time("textRebuildMs", this.stats.textRebuildDurationMs - textRebuildMsBefore);
		for (const name of this.text.keys()) if (!deferred.has(name)) this.lifecycle.noteTextIndexSource(name, "staged");
		if (deferred.size > 0) this.deferOpenTextBuilds([...deferred]);
	}
	/** Arm the rebase queue on each deferred text index NOW and build its base
	*  in a background maintenance task with the bounded engine, pinned at the
	*  recovery checkpoint. The fallback full recovery feeds only the Store,
	*  so the write
	*  buffers are empty at this point and arming here (before open() returns —
	*  no write or catch-up can interleave) captures exactly the
	*  post-checkpoint ops. Until a build commits, searches on the index raise
	*  TextIndexBuildingError instead of silently serving partial results. A
	*  read-only opener builds into a private scratch dir OUTSIDE the live
	*  writer's db dir and adopts the disk base there (commitRebase's
	*  memBase→disk flip). */
	deferOpenTextBuilds(names) {
		const rec = this.recoveryInfo;
		if (rec === null) return;
		const armed = [];
		for (const name of names) {
			const ti = this.text.get(name);
			const def = this.textDefs.find((d) => d.name === name);
			if (ti === void 0 || def === void 0) continue;
			ti.basePending = true;
			ti.beginRebase();
			armed.push({
				name,
				ti,
				def
			});
			this.lifecycle.markTextIndexPending(name);
		}
		if (armed.length === 0) return;
		const pin = () => ({
			walOffset: rec.walScanEnd,
			walDev: rec.walDev,
			walIno: rec.walIno,
			snapshotDev: rec.snapshotDev,
			snapshotIno: rec.snapshotIno
		});
		const repin = (ti) => {
			ti.resetWriteBuffer();
			ti.abortRebase();
			const walAnchor = fs.statSync(this.walPath);
			let snapshotDev = 0;
			let snapshotIno = 0;
			try {
				const snapAnchor = fs.statSync(path.join(this.dir, SNAPSHOT_FILE));
				snapshotDev = snapAnchor.dev;
				snapshotIno = snapAnchor.ino;
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			const checkpoint = {
				walOffset: walAnchor.size,
				walDev: walAnchor.dev,
				walIno: walAnchor.ino,
				snapshotDev,
				snapshotIno
			};
			ti.beginRebase();
			return checkpoint;
		};
		const scratchDir = this.readOnly ? this.roScratchDir ??= path.join(this.dir, "..", `${path.basename(this.dir)}.ro-scratch`, `${process.pid}-${randomUUID().slice(0, 8)}`) : null;
		this.maintenance.submit("text-build", async (ctx) => {
			for (const { name, ti, def } of armed) {
				const output = scratchDir !== null ? {
					dir: scratchDir,
					postingsPath: path.join(scratchDir, rootPostingsFile(name))
				} : null;
				let checkpoint = pin();
				let committed = false;
				let hostedMode = null;
				const tBuild = performance.now();
				for (let attempt = 1; attempt <= 3 && !committed; attempt++) {
					if (attempt > 1) checkpoint = repin(ti);
					try {
						const hosted = await this.boundedTextBuild(name, ti, def, checkpoint, output, ctx.signal);
						if (hosted === null) break;
						committed = true;
						hostedMode = hosted;
					} catch {
						if (ctx.signal.aborted) return;
					}
				}
				this.lifecycle.time("textRebuildMs", performance.now() - tBuild);
				if (committed && hostedMode !== null) {
					this.stats.textDeferredBuilds++;
					this.lifecycle.clearTextIndexPending(name, hostedMode);
				} else {
					ti.abortRebase();
					ti.basePending = true;
					this.stats.textDeferredBuildErrors++;
				}
			}
		}).catch(() => {
			for (const { ti } of armed) if (ti.rebasing) {
				ti.abortRebase();
				ti.basePending = true;
				this.stats.textDeferredBuildErrors++;
			}
		});
	}
	/** Whether a text index's base is currently unavailable — a deferred
	*  open-time build is in flight or finally failed — so searches on it
	*  raise TextIndexBuildingError instead of serving partial results. */
	textIndexBuilding(name) {
		const ti = this.text.get(name);
		return ti !== void 0 && ti.basePending;
	}
	*_liveRecordsRaw() {
		yield* this.readPath.liveRecordsRaw();
	}
	async tryLoadGeneration(mode) {
		return this.generationBuilder.tryLoadGeneration(mode);
	}
	async buildGeneration(trigger) {
		return this.generationBuilder.buildGeneration(trigger);
	}
	/** Explicit maintenance (stage 5): build + publish a fresh index generation
	*  now. Writer only. The load path is automatic; this exists for operators
	*  who want to force a checkpoint after a large burst of writes instead of
	*  waiting for the next compaction. */
	async rebuildGeneration() {
		return this.generationBuilder.rebuildGeneration();
	}
	/** Build ONE text index's base with the bounded engine (byte-budget
	*  aggregation + segmented external merge — hosted in a worker thread when
	*  its entry file exists, the same core inline on the main thread
	*  otherwise) and swap it in through the rebase machinery. This is the
	*  memory-bounded alternative to `ti.build(...)`'s staged O(corpus)
	*  aggregation for the two full-corpus build entries: createTextIndex and
	*  the open-time generation-loader rebuild. Returns 'worker' | 'inline'
	*  when the build ran; null when the index is ineligible and the caller
	*  must use the staged path (tiny corpus, custom tokenizer, a memory-base
	*  index without an external `output`, or the explicit rollback switches).
	*  On throw the rebase is aborted and the live index is untouched — the
	*  caller decides whether a staged fallback is safe to attempt.
	*
	*  `output` redirects the build's artifacts to a caller-owned directory
	*  OUTSIDE the db dir and skips the rename into the db root — the shape a
	*  read-only opener needs: it must not write into the live writer's
	*  directory, so its base postings are built into a private scratch dir
	*  and adopted there (commitRebase flips memBase→disk, same as a
	*  generation attach). The postings file at `output.postingsPath` stays
	*  live after the commit and is owned by the caller from then on. */
	async boundedTextBuild(name, ti, def, checkpoint, output = null, signal) {
		if (!this.textBuildWorkerEnabled || this.textWorkerDisabled || this.state !== "open" || ti.memBase !== null && output === null || ti.hasCustomTokenizer || this.store.size < 4096) return null;
		let sealedOffset;
		let walDev;
		let walIno;
		let snapDev = 0;
		let snapIno = 0;
		const sizeAtCheckpoint = this.store.size;
		if (checkpoint === null && ti.memBase !== null) throw new Error("bounded text build on a memory-base index requires a pinned checkpoint");
		if (!ti.rebasing) ti.beginRebase();
		try {
			if (checkpoint === null) {
				sealedOffset = this.wal.appendOffset;
				await this.wal.flush();
				const walAnchor = fs.statSync(this.walPath);
				walDev = walAnchor.dev;
				walIno = walAnchor.ino;
				try {
					const snapAnchor = fs.statSync(path.join(this.dir, SNAPSHOT_FILE));
					snapDev = snapAnchor.dev;
					snapIno = snapAnchor.ino;
				} catch (error) {
					if (error.code !== "ENOENT") throw error;
				}
			} else {
				sealedOffset = checkpoint.walOffset;
				walDev = checkpoint.walDev;
				walIno = checkpoint.walIno;
				snapDev = checkpoint.snapshotDev;
				snapIno = checkpoint.snapshotIno;
			}
		} catch (error) {
			ti.abortRebase();
			throw error;
		}
		const tmpDir = output === null ? path.join(this.dir, `${rootPostingsFile(name)}.tmpbuild`) : null;
		let slotRelease = null;
		try {
			const artifactsDir = tmpDir ?? output.dir;
			if (tmpDir !== null) await fs$1.rm(tmpDir, {
				recursive: true,
				force: true
			});
			await fs$1.mkdir(artifactsDir, { recursive: true });
			const postingsPath = tmpDir !== null ? path.join(tmpDir, rootPostingsFile(name)) : output.postingsPath;
			const dictionaryPath = path.join(artifactsDir, textDictionaryFile(name));
			const baseDocsPath = path.join(artifactsDir, `${textDocsFile(name)}.base`);
			const workerAvailable = textBuildWorkerAvailable();
			let inlineReason;
			if (workerAvailable) {
				slotRelease = await defaultWorkerSlots.acquireBounded(this.textBuildSlotWaitMs, signal);
				if (slotRelease === null) inlineReason = "slot-pressure";
			} else inlineReason = "runtime-unavailable";
			const inline = slotRelease === null;
			const handle = startWorkerTextBuild({
				snapshotPath: snapIno !== 0 ? path.join(this.dir, SNAPSHOT_FILE) : null,
				walPath: this.walPath,
				walOffset: sealedOffset,
				walDev,
				walIno,
				snapshotDev: snapDev,
				snapshotIno: snapIno,
				indexes: [{
					name,
					fields: def.fields,
					tokenizer: def.tokenizer === "ngram" ? "ngram" : "default",
					postingsPath,
					dictionaryPath,
					baseDocsPath
				}],
				memoryBudgetBytes: this.textBuildMemoryBytes
			}, {
				shouldAbort: () => this.state !== "open" || signal?.aborted === true,
				inline,
				inlineReason,
				signal,
				onFallback: (reason) => {
					this.stats.textWorkerFallbacks++;
					this.stats.lastTextWorkerFallback = reason;
				}
			});
			let result;
			try {
				result = await handle.promise;
			} catch (error) {
				if (!handle.inline && !(error instanceof WorkerTextBuildError && error.aborted)) this.stats.textWorkerErrors++;
				throw error;
			}
			if (result.scannedLiveKeys > sizeAtCheckpoint) throw new Error(`text build scanned ${result.scannedLiveKeys} live keys > checkpoint store ${sizeAtCheckpoint} (pinning protocol violation)`);
			const r = result.indexes[0];
			if (!r) throw new Error("text build produced no index result");
			await verifyFileCrcAsync(postingsPath, r.postingsInfo);
			const dictEntries = (await readTextDictionaryImageAsync(await readGenerationFileCheckedAsync(dictionaryPath, "MDTD", 1, r.dictionaryInfo))).map((e) => [e.term, {
				off: e.off,
				len: e.len,
				df: e.df
			}]);
			const baseDocs = await readBaseDocsImageAsync(await readGenerationFileCheckedAsync(baseDocsPath, BASE_DOCS_MAGIC, 1, r.baseDocsInfo));
			const containers = await TextIndex.prepareRebaseContainers(dictEntries, baseDocs.keys, baseDocs.docLens);
			const finalPostingsPath = tmpDir !== null ? this.textPostingsPath(name) : postingsPath;
			if (tmpDir !== null) await fs$1.rename(postingsPath, finalPostingsPath);
			ti.commitRebase({
				postingsPath: finalPostingsPath,
				containers,
				liveCount: r.liveCount,
				postingsFileInfo: r.postingsInfo
			});
			if (!handle.inline) this.stats.textWorkerBuilds++;
			return handle.inline ? "inline" : "worker";
		} catch (error) {
			ti.abortRebase();
			throw error;
		} finally {
			slotRelease?.();
			if (tmpDir !== null) await fs$1.rm(tmpDir, {
				recursive: true,
				force: true
			}).catch(() => {});
			else {
				await fs$1.rm(path.join(output.dir, textDictionaryFile(name)), { force: true }).catch(() => {});
				await fs$1.rm(path.join(output.dir, `${textDocsFile(name)}.base`), { force: true }).catch(() => {});
			}
		}
	}
	/** Stable generation status: the generation this instance loaded at open or
	*  last published (null when running on the legacy recovery path). */
	getIndexGeneration() {
		return this.generationBuilder.getIndexGeneration();
	}
	async loadIndexDefinitions() {
		return this.indexAdmin.loadIndexDefinitions(this.indexPath);
	}
	/** Persist the given secondary-index definition list. The CONTENT is the
	*  caller's transaction decision (live list ± the mutation), never an
	*  implicit snapshot of the registry — a create persists live+staged BEFORE
	*  publishing, a drop persists live-minus BEFORE removing. */
	async persistIndexDefinitions(defs) {
		await writeFileAtomic(this.indexPath, JSON.stringify(defs), { stats: this.stats });
	}
	async loadTextIndexDefinitions() {
		return this.textRegistry.loadTextIndexDefinitions();
	}
	/** Persist the given text-index definition list (same transaction-content
	*  rule as persistIndexDefinitions). This is the registry's persistence
	*  SEAM (injected into TextRegistry): kept on MiniDb so tests can stub it
	*  on the instance. */
	async persistTextIndexDefinitions(defs) {
		await writeFileAtomic(path.join(this.dir, TEXT_INDEXES_FILE), JSON.stringify(defs), { stats: this.stats });
	}
	async loadCompoundIndexDefinitions() {
		return this.indexAdmin.loadCompoundIndexDefinitions(this.compoundIndexPath);
	}
	/** Persist the given compound-index definition list (same
	*  transaction-content rule as persistIndexDefinitions). */
	async persistCompoundIndexDefinitions(defs) {
		await writeFileAtomic(this.compoundIndexPath, JSON.stringify(defs), { stats: this.stats });
	}
	/** Drop every derived index entry for a key that just expired in the Store. */
	onStoreExpire(k, _rec) {
		this.access.delete(k);
		this.dt.del(k);
		this.compound.remove(k);
		if (this.indexes.size > 0) this.indexes.remove(k, void 0);
		for (const ti of this.text.values()) ti.remove(k);
	}
	maybeAutoCompact() {
		if (this.autoCompact && !this.compacting && shouldCompact(this)) this.submitCompaction().catch(() => {});
		this.maybeAutoGenerationBuild();
	}
	/** The staleness rule shared by the runtime wal-growth trigger and the
	*  close-time best-effort publish: no valid current generation while there
	*  is data worth checkpointing (a writer that started from an empty db and
	*  grew its WAL past the threshold without ever reaching the compaction
	*  threshold — the window the open-time kick cannot cover), or the WAL
	*  grew/rotated past the threshold since the current generation's
	*  checkpoint (a rotated-away anchor reads as a negative drift). */
	generationStale() {
		if (this.readOnly || !this.indexGenerationsEnabled || this.state !== "open") return false;
		const gen = this.generationInfo;
		const walOffset = this.wal.appendOffset;
		return gen === null ? this.store.size > 0 && walOffset >= 4194304 : walOffset - gen.walCheckpoint >= 4194304 || walOffset < gen.walCheckpoint;
	}
	/** Runtime generation-availability trigger, riding the per-write
	*  maintenance hook (maybeAutoCompact): kick a background generation build
	*  when the current generation is missing/stale. Throttled per instance,
	*  with a longer backoff after a failed/aborted build so a hopelessly
	*  churning writer is not re-kicked every interval; the scheduler's
	*  same-kind dedupe makes a redundant kick cheap. */
	maybeAutoGenerationBuild() {
		const now = Date.now();
		if (now - this.lastGenBuildKickAt < this.genBuildKickMinIntervalMs) return;
		if (now - this.lastGenBuildFailureAt < this.genBuildKickFailureBackoffMs) return;
		if (!this.generationStale()) return;
		this.lastGenBuildKickAt = now;
		this.buildGeneration("wal-growth").catch(() => {});
	}
	writeDisabledError() {
		return this.walGroups.writeDisabledError();
	}
	/** Recover a poisoned WAL back to a known-safe point: truncate db.wal to
	*  the failed batch's first predicted offset — exactly the un-acked bytes;
	*  every acknowledged write sits in earlier, successful batches — then
	*  re-sync the live WAL's size bookkeeping and clear the poison.
	*
	*  Mutual exclusion with a compaction rotation (which has its own recovery:
	*  swapping in a fresh WAL at the real EOF): the truncate targets the PATH,
	*  so it is correct whether or not the rotation's recovery swapped the WAL
	*  meanwhile, and the bookkeeping refresh hits the CURRENT WAL. Both sides
	*  only ever truncate to the same poison offset, so the composition never
	*  double-executes.
	*
	*  A truncate failure (the I/O error persists) parks the instance in
	*  writeDisabled: the poison is kept, so appends keep rejecting, reads keep
	*  working and close() skips its final flush. */
	async recoverWalInPlace(wal) {
		let poison = wal.poison;
		if (!poison) return;
		await wal.whenIdle();
		poison = wal.poison;
		if (!poison) return;
		try {
			await withWindowsEpermRetry(async () => {
				const st = await fs$1.stat(this.walPath);
				if (poison.failedAtOffset <= st.size) await fs$1.truncate(this.walPath, poison.failedAtOffset);
			});
		} catch (error) {
			this.writeDisabled = error;
			return;
		}
		await this.wal.refreshSize();
		wal.clearPoison();
	}
	touchAccess(pk) {
		this.memoryGuard.touchAccess(pk);
	}
	seedAccessFromStore() {
		this.memoryGuard.seedAccessFromStore();
	}
	async evictKey(pk) {
		return this.writePath.evictKey(pk);
	}
	get(key) {
		return this.readPath.get(key);
	}
	/** Async value resolution for a canonical key (see ReadPath.readValueAsync). */
	async readValueAsync(kstr) {
		return this.readPath.readValueAsync(kstr);
	}
	/** Async twin of get() (stage 6, additive): identical result; only the
	*  disk-mode value read moves off the event loop. */
	async getAsync(key) {
		return this.readPath.getAsync(key);
	}
	getRecord(key) {
		return this.readPath.getRecord(key);
	}
	async set(key, value, { ttl, dt } = {}) {
		return this.writePath.set(key, value, {
			ttl,
			dt
		});
	}
	async del(key) {
		return this.writePath.del(key);
	}
	/** Atomically apply a batch of operations (all-or-nothing). */
	async batch(ops) {
		return this.writePath.batch(ops);
	}
	/** The unguarded restore core behind restoreKey and the flush-group
	*  rollback: put the key back to `prev` across the store and every derived
	*  index (TTL/access/dt/secondary/compound/text). */
	restoreGroupKey(pk, prev) {
		this.writePath.restoreGroupKey(pk, prev);
	}
	/** Apply one recovered WAL frame during catchUpFromWal: the same ops
	*  open-time recovery derives from it (frameToOps), plus the incremental
	*  derived-index maintenance applyOp performs on the write path — minus
	*  unique checks: the writer already validated, and intermediate frame
	*  states must apply literally (LWW). */
	applyRecoveredFrameAsync(f, fd, slice) {
		return this.writePath.applyRecoveredFrameAsync(f, fd, slice);
	}
	applyRecoveredOp(op) {
		this.writePath.applyRecoveredOp(op);
	}
	has(key) {
		return this.readPath.has(key);
	}
	get size() {
		this.ensureOpen();
		return this.store.size;
	}
	async mset(entries) {
		if (entries.length === 0) return;
		await this.batch(entries.map(([key, value]) => ({
			op: "set",
			key,
			value
		})));
	}
	mget(keys) {
		return this.readPath.mget(keys);
	}
	async expire(key, ttlMs) {
		return this.writePath.expire(key, ttlMs);
	}
	ttl(key) {
		return this.readPath.ttl(key);
	}
	scan(opts = {}) {
		return this.readPath.scan(opts);
	}
	prefix(p, limit = Infinity) {
		return this.readPath.prefix(p, limit);
	}
	dtColumns() {
		return this.readPath.dtColumns();
	}
	dtRange(col, opts = {}) {
		return this.readPath.dtRange(col, opts);
	}
	async createIndex(name, opts) {
		return this.indexAdmin.createIndex(name, opts);
	}
	async dropIndex(name) {
		return this.indexAdmin.dropIndex(name);
	}
	listIndexes() {
		return this.indexAdmin.listIndexes();
	}
	findEq(name, value) {
		return this.indexAdmin.findEq(name, value);
	}
	findRange(name, opts) {
		return this.indexAdmin.findRange(name, opts);
	}
	async createCompoundIndex(name, def) {
		return this.indexAdmin.createCompoundIndex(name, def);
	}
	async dropCompoundIndex(name) {
		return this.indexAdmin.dropCompoundIndex(name);
	}
	listCompoundIndexes() {
		return this.indexAdmin.listCompoundIndexes();
	}
	/**
	* Ordered range within a group, e.g. "sessions in workspace X ordered by
	* updatedAt". O(log N + limit) — no full sort.
	*/
	compoundRange(name, groupValue, opts = {}) {
		return this.indexAdmin.compoundRange(name, groupValue, opts);
	}
	async createTextIndex(name, { fields, tokenizer } = {}) {
		return this.textRegistry.createTextIndex(name, {
			fields,
			tokenizer
		});
	}
	async dropTextIndex(name) {
		return this.textRegistry.dropTextIndex(name);
	}
	search(name, q, opts = {}) {
		return this.textRegistry.search(name, q, opts);
	}
	/**
	* `search` with work accounting: `opts.maxVisits` bounds how many posting
	* entries the index visits (see TextIndex.searchBounded); the result
	* reports the visits and whether the budget truncated the candidate set
	* (hits are then a subset of the full matches, never false hits).
	*/
	searchBounded(name, q, opts = {}) {
		return this.textRegistry.searchBounded(name, q, opts);
	}
	/** Async twin of searchBounded (stage 6, additive): identical hits and
	*  budget accounting; the postings reads and the disk-mode value reads run
	*  off the event loop. The server's search path prefers this variant. */
	async searchBoundedAsync(name, q, opts = {}) {
		return this.textRegistry.searchBoundedAsync(name, q, opts);
	}
	/** Async convenience: the async counterpart of search(). */
	async searchAsync(name, q, opts = {}) {
		return this.textRegistry.searchAsync(name, q, opts);
	}
	query(q = {}) {
		return this.queryEngine.query(q);
	}
	/** Async twin of query() (stage 6, additive): identical results and
	*  ordering; the disk-mode value reads (and the text branch's postings
	*  reads) run off the event loop. The candidate-collection logic mirrors
	*  query() exactly — keep both in sync when the query planner changes. */
	async queryAsync(q = {}) {
		return this.queryEngine.queryAsync(q);
	}
	/** The rejection a write op gets while a backup holds the write gate: the
	*  fence is short (file copies) and retryable, so callers can simply
	*  re-issue the write afterwards. */
	backupInProgressError() {
		return backupInProgressError();
	}
	/** Write a consistent online backup of this database directory.
	*
	*  Semantics (plan 12): backup pauses the write gate — new writes reject
	*  with BACKUP_IN_PROGRESS — and waits for every in-flight write to settle.
	*  That drain completion IS the linearization point: every write
	*  acknowledged before it is included in the backup, every write submitted
	*  after it is not. The copy itself is an atomic commit: persistent files
	*  go to a sibling temp dir, every copied file is fsync'd, the manifest is
	*  written LAST (the commit marker — a manifest on disk implies every file
	*  it lists is fully copied and durable), then the temp dir is renamed over
	*  the destination (an existing previous backup is swapped aside first and
	*  restored if the rename fails). A failure anywhere before the rename
	*  leaves the destination untouched and the temp dir removed — never a half
	*  backup. Concurrent backups serialize on serializeBackups. */
	async backup(destDir, opts = {}) {
		return backup(this.backupDeps, destDir, opts);
	}
	/** Restore a backup directory into destDir and open it. */
	static async restore(srcDir, destDir, opts = {}) {
		if (!srcDir) throw new TypeError("restore: srcDir is required");
		if (!destDir) throw new TypeError("restore: destDir is required");
		const { force, ...openOpts } = opts;
		if (force) await fs$1.rm(destDir, {
			recursive: true,
			force: true
		});
		else try {
			if ((await fs$1.readdir(destDir)).length > 0) throw new Error(`restore destination is not empty: ${destDir}`);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		await fs$1.mkdir(destDir, { recursive: true });
		const names = await fs$1.readdir(srcDir);
		for (const name of names) if (isPersistentFile(name) || name === "backup.manifest.json") {
			const src = path.join(srcDir, name);
			if ((await fs$1.stat(src)).isDirectory()) await fs$1.cp(src, path.join(destDir, name), { recursive: true });
			else await fs$1.copyFile(src, path.join(destDir, name));
		}
		return MiniDb.open({
			...openOpts,
			dir: destDir
		});
	}
	/** Refresh the write lock's timestamp (see {@link LockFile.renew}). No-op
	*  for a read-only instance. Exposed for lease-style holders such as the
	*  cluster shard pool, which renew on a timer to prove liveness. */
	async renewLock() {
		return renewMiniDbLock(this);
	}
	/** Advanced/internal (read-replica owners such as the cluster shard pool):
	*  incrementally apply WAL frames appended to db.wal after `offset` — the
	*  same frames open-time recovery would replay, interpreted identically
	*  (frameToOps: valueMode memory/disk refs, expired-SET drop with LWW,
	*  TYPE_BATCH unrolling, dt meta) — plus incremental maintenance of every
	*  derived index (dt, compound, secondary, text). Unique constraints are
	*  NOT checked: the writer already validated, and intermediate frame states
	*  must apply literally, last-writer-wins.
	*
	*  The instance tracks its own continuation: the first call must pass
	*  recoveryInfo.walScanEnd, every later call the previous call's returned
	*  offset, and the fs identity of the WAL opened for reading must match the
	*  inode recovery (or the last catch-up) scanned — an offset too old/new, a
	*  rotated file and a shrunken one all return null, meaning: reopen from
	*  scratch. A partial/torn tail left by a writer mid-writev is NOT an
	*  error: the scan stops at the last fully-valid frame; call again later
	*  and its CRC validates once the writev landed.
	*
	*  Cooperative: the scan runs through the windowed async scanner and the
	*  apply yields between primitive ops on the walApplySlicer budgets, so a
	*  replica that fell far behind does not block the host's event loop in
	*  one synchronous scan+apply. Calls are serialized per instance (see
	*  catchUpChain). */
	async catchUpFromWal(offset) {
		this.ensureOpen();
		const run = this.catchUpChain.then(() => this.doCatchUpFromWal(offset));
		this.catchUpChain = run.then(() => void 0, () => void 0);
		return run;
	}
	async doCatchUpFromWal(offset) {
		this.ensureOpen();
		const ri = this.recoveryInfo;
		const anchor = this.walTail ?? (ri && ri.walIno ? {
			dev: ri.walDev,
			ino: ri.walIno,
			size: ri.walScanEnd,
			tail: ri.walScanTail ?? null
		} : null);
		if (!anchor || offset !== anchor.size) return null;
		const res = await catchUpWalAsync(this.walPath, offset, anchor, (f, fd, slice) => this.applyRecoveredFrameAsync(f, fd, slice));
		if (!res) return null;
		this.walTail = {
			dev: anchor.dev,
			ino: anchor.ino,
			size: res.offset,
			tail: res.tail
		};
		return {
			offset: res.offset,
			appliedFrames: res.appliedFrames
		};
	}
	async compact() {
		this.ensureOpen();
		this.ensureWritable();
		await this.submitCompaction();
	}
	/** Stage 6: observable maintenance state (queued/running/publishing plus
	*  the recent failed/complete history). The public read model of the
	*  internal scheduler — callers never see workers or file details. */
	maintenanceStatus() {
		return this.maintenance.status();
	}
	/** The last open()'s lifecycle read model: which path served the open
	*  ('generation-load' + 'wal-catch-up' vs 'full-rebuild'), whether the
	*  instance is 'ready' or still 'degraded' (a deferred text-index base
	*  build in flight), the per-phase wall-clock timings, and how every text
	*  index's base was served (generation image vs worker/inline/staged
	*  rebuild). Diagnostics only — the cumulative counters stay in `stats`. */
	lifecycleStatus() {
		return this.lifecycle.snapshot();
	}
	async close() {
		return closeMiniDb(this, this.lifecycleHooks);
	}
	ensureOpen() {
		if (this.state !== "open") throw new Error("MiniDb is closed");
	}
	ensureWritable() {
		if (this.readOnly) throw new Error("MiniDb is open in read-only mode");
		if (this.writeDisabled) throw this.writeDisabledError();
	}
};
// ../../packages/minidb/src/error-classification.ts
function classifyStorageError(error) {
	if (error instanceof AggregateError) return error.errors.some((inner) => classifyStorageError(inner) === "rebuild") ? "rebuild" : "transient";
	if (error instanceof SyntaxError || error instanceof CorruptFrameError) return "rebuild";
	const code = error?.code;
	if (code === "WAL_WRITE_DISABLED" || code === "WAL_POISONED") return "rebuild";
	return "transient";
}
// ../../packages/runtime-shared/src/errors.ts
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
// ../../packages/kap-server/src/lib/clock.ts
const SYSTEM_CLOCK = {
	now: () => Date.now(),
	monotonicNow: () => performance.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle),
	setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
	clearInterval: (handle) => clearInterval(handle)
};
// ../../packages/kap-server/src/search/docs.ts
const MAX_DOC_TEXT_CHARS = 2e4;
// ../../packages/kap-server/src/search/match.ts
function boundaryWidth(q) {
	return q.mode !== "literal" && q.sort === "score" ? 3 : 2;
}
function cmpKey(a, b) {
	return a < b ? -1 : a > b ? 1 : 0;
}
function compareRows(q, a, b) {
	if (q.mode !== "literal" && q.sort === "score") return b.score - a.score || b.value.time - a.value.time || cmpKey(a.key, b.key);
	if (q.mode !== "literal" && q.sort === "time_asc") return a.value.time - b.value.time || cmpKey(a.key, b.key);
	return b.value.time - a.value.time || cmpKey(a.key, b.key);
}
function rowAfterBoundary(q, row, boundary) {
	let cmp;
	if (boundary.length === 3) {
		const [bs, bt, bk] = boundary;
		cmp = bs - row.score || bt - row.value.time || cmpKey(row.key, bk);
	} else {
		const [bt, bk] = boundary;
		cmp = q.mode !== "literal" && q.sort === "time_asc" ? row.value.time - bt || cmpKey(row.key, bk) : bt - row.value.time || cmpKey(row.key, bk);
	}
	return cmp > 0;
}
var RowTopK = class {
	q;
	k;
	a = [];
	constructor(q, k) {
		this.q = q;
		this.k = k;
	}
	worse(x, y) {
		return compareRows(this.q, x, y) > 0;
	}
	offer(row) {
		const a = this.a;
		if (a.length < this.k) {
			a.push(row);
			let i = a.length - 1;
			while (i > 0) {
				const p = i - 1 >> 1;
				if (!this.worse(a[i], a[p])) break;
				[a[p], a[i]] = [a[i], a[p]];
				i = p;
			}
			return;
		}
		if (this.k === 0 || !this.worse(a[0], row)) return;
		a[0] = row;
		let i = 0;
		for (;;) {
			let w = i;
			const l = 2 * i + 1;
			const r = 2 * i + 2;
			if (l < a.length && this.worse(a[l], a[w])) w = l;
			if (r < a.length && this.worse(a[r], a[w])) w = r;
			if (w === i) break;
			[a[w], a[i]] = [a[i], a[w]];
			i = w;
		}
	}
	sorted() {
		return this.a.sort((x, y) => compareRows(this.q, x, y));
	}
};
function matchDocs(q, docs, boundary, budget) {
	const literalQuery = q.literalQuery;
	const rows = [];
	let i = 0;
	for (const { key, value: doc, score } of docs) {
		if ((i++ & 63) === 0 && budget.now() > budget.deadlineAt) return {
			rows,
			incomplete: "deadline"
		};
		if (doc === void 0 || doc.kind !== "message" && doc.kind !== "title") continue;
		if (q.container?.sessionId !== void 0 && doc.sessionId !== q.container.sessionId) continue;
		if (q.container?.agentId !== void 0 && doc.agentId !== q.container.agentId) continue;
		if (q.role !== void 0 && doc.role !== q.role) continue;
		if (q.startTime !== void 0 && doc.time < q.startTime) continue;
		if (q.endTime !== void 0 && doc.time > q.endTime) continue;
		if (boundary !== void 0 && !rowAfterBoundary(q, {
			key,
			value: doc,
			score
		}, boundary)) continue;
		if (literalQuery !== void 0) {
			budget.textCharsLeft -= doc.text.length;
			if (budget.textCharsLeft < 0) return {
				rows,
				incomplete: "deadline"
			};
			const at = normalizeLiteral(doc.text).indexOf(literalQuery);
			if (at === -1) continue;
			rows.push({
				key,
				value: doc,
				score: 0,
				anchor: at
			});
		} else rows.push({
			key,
			value: doc,
			score
		});
	}
	return { rows };
}
function paginateRows(q, page, rows) {
	let pageRows;
	let hasMore;
	if (page.kind === "legacy") {
		rows.sort((a, b) => compareRows(q, a, b));
		const slice = rows.slice(page.skip, page.skip + q.pageSize + 1);
		hasMore = slice.length > q.pageSize;
		pageRows = slice.slice(0, q.pageSize);
	} else {
		const top = new RowTopK(q, q.pageSize + 1);
		for (const row of rows) top.offer(row);
		const slice = top.sorted();
		hasMore = slice.length > q.pageSize;
		pageRows = slice.slice(0, q.pageSize);
	}
	return {
		pageRows,
		hasMore
	};
}
function tokenFingerprint(q) {
	const basis = JSON.stringify([
		q.query,
		q.mode,
		q.op,
		q.container?.sessionId,
		q.container?.agentId,
		q.role,
		q.startTime,
		q.endTime,
		q.sort
	]);
	return new Bun.CryptoHasher("sha256").update(basis).digest("base64url").slice(0, 16);
}
const PAGE_TOKEN_VERSION = 2;
function decodePageToken(q, token, generation) {
	if (token === void 0) return { kind: "first" };
	let parsed;
	try {
		parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
	} catch {
		throw new GlobalSearchError("invalid_page_token", "pageToken is malformed");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new GlobalSearchError("invalid_page_token", "pageToken is malformed");
	const p = parsed;
	if (p.f !== tokenFingerprint(q)) throw new GlobalSearchError("invalid_page_token", "pageToken does not match the query conditions; query conditions must not change mid-pagination");
	if (p.v === void 0) {
		if (typeof p.s !== "number" || !Number.isInteger(p.s) || p.s < 0) throw new GlobalSearchError("invalid_page_token", "pageToken is malformed");
		return {
			kind: "legacy",
			skip: p.s
		};
	}
	if (p.v !== PAGE_TOKEN_VERSION) throw new GlobalSearchError("invalid_page_token", "pageToken has an unsupported version");
	if (generation !== void 0 && p.g !== generation) throw new GlobalSearchError("invalid_page_token", "pageToken was issued by an older index generation (the index was rebuilt, reopened or rescanned); restart the search");
	const width = boundaryWidth(q);
	if (!Array.isArray(p.b) || p.b.length !== width || typeof p.b[0] !== "number" || typeof p.b[width - 1] !== "string" || width === 3 && typeof p.b[1] !== "number") throw new GlobalSearchError("invalid_page_token", "pageToken is malformed");
	return {
		kind: "keyset",
		boundary: p.b
	};
}
// ../../packages/agent-core-v2/src/human/llm/media/pathTag.ts
const MEDIA_PATH_TAG_RE = /<(image|video|audio|document|file)\b[^>]*?\bpath="([^"]*)"[^>]*>(?:<\/\1>)?/g;
function unescapeMediaAttribute(value) {
	return value.replaceAll("&quot;", "\"").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}
function matchMediaPathTags(text) {
	const tags = [];
	for (const match of text.matchAll(MEDIA_PATH_TAG_RE)) tags.push({
		kind: match[1],
		path: unescapeMediaAttribute(match[2]),
		index: match.index,
		text: match[0]
	});
	return tags;
}
function matchSingleMediaPathTag(text) {
	const trimmed = text.trim();
	if (trimmed.length === 0) return void 0;
	const tags = matchMediaPathTags(trimmed);
	if (tags.length !== 1) return void 0;
	const tag = tags[0];
	return tag.index === 0 && tag.text.length === trimmed.length ? tag : void 0;
}
// ../../packages/agent-core-v2/src/agent/media/mediaRef.ts
const IMAGE_MIME_BY_SUFFIX = Object.freeze({
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".bmp": "image/bmp",
	".tif": "image/tiff",
	".tiff": "image/tiff",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".heic": "image/heic",
	".heif": "image/heif",
	".avif": "image/avif",
	".svgz": "image/svg+xml"
});
const VIDEO_MIME_BY_SUFFIX = Object.freeze({
	".mp4": "video/mp4",
	".mpg": "video/mpeg",
	".mpeg": "video/mpeg",
	".mkv": "video/x-matroska",
	".avi": "video/x-msvideo",
	".mov": "video/quicktime",
	".ogv": "video/ogg",
	".wmv": "video/x-ms-wmv",
	".webm": "video/webm",
	".m4v": "video/x-m4v",
	".flv": "video/x-flv",
	".3gp": "video/3gpp",
	".3g2": "video/3gpp2"
});
const DOCUMENT_MIME_BY_SUFFIX = Object.freeze({ ".pdf": "application/pdf" });
const AUDIO_MIME_BY_SUFFIX = Object.freeze({
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".m4a": "audio/mp4",
	".ogg": "audio/ogg",
	".oga": "audio/ogg",
	".flac": "audio/flac",
	".aac": "audio/aac",
	".opus": "audio/opus",
	".weba": "audio/webm",
	".wma": "audio/x-ms-wma"
});
invertMimeBySuffix(IMAGE_MIME_BY_SUFFIX);
invertMimeBySuffix(VIDEO_MIME_BY_SUFFIX);
invertMimeBySuffix(AUDIO_MIME_BY_SUFFIX);
invertMimeBySuffix(DOCUMENT_MIME_BY_SUFFIX);
function invertMimeBySuffix(table) {
	const out = {};
	for (const [suffix, mime] of Object.entries(table)) out[mime] ??= suffix;
	return Object.freeze(out);
}
// ../../packages/transcript/src/contract/origin.ts
const HIDDEN_USER_ORIGINS = /* @__PURE__ */ new Set([
	"injection",
	"system_trigger",
	"retry"
]);
const TURN_OPENING_SYSTEM_TRIGGERS = /* @__PURE__ */ new Set(["goal_continuation", "subagent"]);
const MARKER_USER_ORIGIN_KINDS = new Set(Object.keys({
	skill_activation: "skill",
	plugin_command: "skill",
	compaction_summary: "compaction"
}));
const NON_USER_ORIGIN_KINDS = /* @__PURE__ */ new Set([...HIDDEN_USER_ORIGINS, "compaction_summary"]);
const TASK_ORIGIN_KINDS = /* @__PURE__ */ new Set([
	"task",
	"background_task",
	"task_notification"
]);
function classifyUserOrigin(origin) {
	const payload = origin;
	const kind = payload?.kind;
	if (kind === void 0 || kind === "user") return "user";
	if (typeof kind !== "string") return "other";
	if (kind === "system_trigger") return typeof payload?.name === "string" && TURN_OPENING_SYSTEM_TRIGGERS.has(payload.name) ? "opening_trigger" : "hidden";
	if (HIDDEN_USER_ORIGINS.has(kind)) return "hidden";
	if (isUserSlashOrigin(payload)) return "slash";
	if (MARKER_USER_ORIGIN_KINDS.has(kind)) return "marker";
	if (TASK_ORIGIN_KINDS.has(kind)) return "task";
	return "other";
}
function isUserSlashOrigin(origin) {
	return (origin?.kind === "skill_activation" || origin?.kind === "plugin_command") && origin.trigger === "user-slash";
}
function isUndoAnchorTurnOrigin(origin) {
	const payload = origin;
	if (payload?.kind === void 0 || payload.kind === "user") return true;
	return isUserSlashOrigin(payload);
}
Object.freeze({ status: "aborted" });
/* @__NO_SIDE_EFFECTS__ */
function $constructor(name, initializer, params) {
	function init(inst, def) {
		if (!inst._zod) Object.defineProperty(inst, "_zod", {
			value: {
				def,
				constr: _,
				traits: /* @__PURE__ */ new Set()
			},
			enumerable: false
		});
		if (inst._zod.traits.has(name)) return;
		inst._zod.traits.add(name);
		initializer(inst, def);
		const proto = _.prototype;
		const keys = Object.keys(proto);
		for (let i = 0; i < keys.length; i++) {
			const k = keys[i];
			if (!(k in inst)) inst[k] = proto[k].bind(inst);
		}
	}
	const Parent = params?.Parent ?? Object;
	class Definition extends Parent {}
	Object.defineProperty(Definition, "name", { value: name });
	function _(def) {
		var _a;
		const inst = params?.Parent ? new Definition() : this;
		init(inst, def);
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		for (const fn of inst._zod.deferred) fn();
		return inst;
	}
	Object.defineProperty(_, "init", { value: init });
	Object.defineProperty(_, Symbol.hasInstance, { value: (inst) => {
		if (params?.Parent && inst instanceof params.Parent) return true;
		return inst?._zod?.traits?.has(name);
	} });
	Object.defineProperty(_, "name", { value: name });
	return _;
}
var $ZodAsyncError = class extends Error {
	constructor() {
		super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
	}
};
var $ZodEncodeError = class extends Error {
	constructor(name) {
		super(`Encountered unidirectional transform during encode: ${name}`);
		this.name = "ZodEncodeError";
	}
};
const globalConfig = {};
function config(newConfig) {
	if (newConfig) Object.assign(globalConfig, newConfig);
	return globalConfig;
}
// ../../node_modules/zod/v4/core/util.js
function getEnumValues(entries) {
	const numericValues = Object.values(entries).filter((v) => typeof v === "number");
	return Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
}
function jsonStringifyReplacer(_, value) {
	if (typeof value === "bigint") return value.toString();
	return value;
}
function cached(getter) {
	return { get value() {
		{
			const value = getter();
			Object.defineProperty(this, "value", { value });
			return value;
		}
	} };
}
function nullish(input) {
	return input === null || input === void 0;
}
function cleanRegex(source) {
	const start = source.startsWith("^") ? 1 : 0;
	const end = source.endsWith("$") ? source.length - 1 : source.length;
	return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
	const valDecCount = (val.toString().split(".")[1] || "").length;
	const stepString = step.toString();
	let stepDecCount = (stepString.split(".")[1] || "").length;
	if (stepDecCount === 0 && /\d?e-\d?/.test(stepString)) {
		const match = stepString.match(/\d?e-(\d?)/);
		if (match?.[1]) stepDecCount = Number.parseInt(match[1]);
	}
	const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
	return Number.parseInt(val.toFixed(decCount).replace(".", "")) % Number.parseInt(step.toFixed(decCount).replace(".", "")) / 10 ** decCount;
}
const EVALUATING = Symbol("evaluating");
function defineLazy(object, key, getter) {
	let value = void 0;
	Object.defineProperty(object, key, {
		get() {
			if (value === EVALUATING) return;
			if (value === void 0) {
				value = EVALUATING;
				value = getter();
			}
			return value;
		},
		set(v) {
			Object.defineProperty(object, key, { value: v });
		},
		configurable: true
	});
}
function assignProp(target, prop, value) {
	Object.defineProperty(target, prop, {
		value,
		writable: true,
		enumerable: true,
		configurable: true
	});
}
function mergeDefs(...defs) {
	const mergedDescriptors = {};
	for (const def of defs) {
		const descriptors = Object.getOwnPropertyDescriptors(def);
		Object.assign(mergedDescriptors, descriptors);
	}
	return Object.defineProperties({}, mergedDescriptors);
}
function esc(str) {
	return JSON.stringify(str);
}
function slugify(input) {
	return input.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
const captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
function isObject(data) {
	return typeof data === "object" && data !== null && !Array.isArray(data);
}
const allowsEval = cached(() => {
	if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) return false;
	try {
		new Function("");
		return true;
	} catch (_) {
		return false;
	}
});
function isPlainObject(o) {
	if (isObject(o) === false) return false;
	const ctor = o.constructor;
	if (ctor === void 0) return true;
	if (typeof ctor !== "function") return true;
	const prot = ctor.prototype;
	if (isObject(prot) === false) return false;
	if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) return false;
	return true;
}
function shallowClone(o) {
	if (isPlainObject(o)) return { ...o };
	if (Array.isArray(o)) return [...o];
	return o;
}
const propertyKeyTypes = /* @__PURE__ */ new Set([
	"string",
	"number",
	"symbol"
]);
function escapeRegex(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
	const cl = new inst._zod.constr(def ?? inst._zod.def);
	if (!def || params?.parent) cl._zod.parent = inst;
	return cl;
}
function normalizeParams(_params) {
	const params = _params;
	if (!params) return {};
	if (typeof params === "string") return { error: () => params };
	if (params?.message !== void 0) {
		if (params?.error !== void 0) throw new Error("Cannot specify both `message` and `error` params");
		params.error = params.message;
	}
	delete params.message;
	if (typeof params.error === "string") return {
		...params,
		error: () => params.error
	};
	return params;
}
function optionalKeys(shape) {
	return Object.keys(shape).filter((k) => {
		return shape[k]._zod.optin === "optional" && shape[k]._zod.optout === "optional";
	});
}
const NUMBER_FORMAT_RANGES = {
	safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
	int32: [-2147483648, 2147483647],
	uint32: [0, 4294967295],
	float32: [-34028234663852886e22, 34028234663852886e22],
	float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
};
function pick(schema, mask) {
	const currDef = schema._zod.def;
	const checks = currDef.checks;
	if (checks && checks.length > 0) throw new Error(".pick() cannot be used on object schemas containing refinements");
	return clone(schema, mergeDefs(schema._zod.def, {
		get shape() {
			const newShape = {};
			for (const key in mask) {
				if (!(key in currDef.shape)) throw new Error(`Unrecognized key: "${key}"`);
				if (!mask[key]) continue;
				newShape[key] = currDef.shape[key];
			}
			assignProp(this, "shape", newShape);
			return newShape;
		},
		checks: []
	}));
}
function omit(schema, mask) {
	const currDef = schema._zod.def;
	const checks = currDef.checks;
	if (checks && checks.length > 0) throw new Error(".omit() cannot be used on object schemas containing refinements");
	return clone(schema, mergeDefs(schema._zod.def, {
		get shape() {
			const newShape = { ...schema._zod.def.shape };
			for (const key in mask) {
				if (!(key in currDef.shape)) throw new Error(`Unrecognized key: "${key}"`);
				if (!mask[key]) continue;
				delete newShape[key];
			}
			assignProp(this, "shape", newShape);
			return newShape;
		},
		checks: []
	}));
}
function extend(schema, shape) {
	if (!isPlainObject(shape)) throw new Error("Invalid input to extend: expected a plain object");
	const checks = schema._zod.def.checks;
	if (checks && checks.length > 0) {
		const existingShape = schema._zod.def.shape;
		for (const key in shape) if (Object.getOwnPropertyDescriptor(existingShape, key) !== void 0) throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
	}
	return clone(schema, mergeDefs(schema._zod.def, { get shape() {
		const _shape = {
			...schema._zod.def.shape,
			...shape
		};
		assignProp(this, "shape", _shape);
		return _shape;
	} }));
}
function safeExtend(schema, shape) {
	if (!isPlainObject(shape)) throw new Error("Invalid input to safeExtend: expected a plain object");
	return clone(schema, mergeDefs(schema._zod.def, { get shape() {
		const _shape = {
			...schema._zod.def.shape,
			...shape
		};
		assignProp(this, "shape", _shape);
		return _shape;
	} }));
}
function merge(a, b) {
	return clone(a, mergeDefs(a._zod.def, {
		get shape() {
			const _shape = {
				...a._zod.def.shape,
				...b._zod.def.shape
			};
			assignProp(this, "shape", _shape);
			return _shape;
		},
		get catchall() {
			return b._zod.def.catchall;
		},
		checks: []
	}));
}
function partial(Class, schema, mask) {
	const checks = schema._zod.def.checks;
	if (checks && checks.length > 0) throw new Error(".partial() cannot be used on object schemas containing refinements");
	return clone(schema, mergeDefs(schema._zod.def, {
		get shape() {
			const oldShape = schema._zod.def.shape;
			const shape = { ...oldShape };
			if (mask) for (const key in mask) {
				if (!(key in oldShape)) throw new Error(`Unrecognized key: "${key}"`);
				if (!mask[key]) continue;
				shape[key] = Class ? new Class({
					type: "optional",
					innerType: oldShape[key]
				}) : oldShape[key];
			}
			else for (const key in oldShape) shape[key] = Class ? new Class({
				type: "optional",
				innerType: oldShape[key]
			}) : oldShape[key];
			assignProp(this, "shape", shape);
			return shape;
		},
		checks: []
	}));
}
function required(Class, schema, mask) {
	return clone(schema, mergeDefs(schema._zod.def, { get shape() {
		const oldShape = schema._zod.def.shape;
		const shape = { ...oldShape };
		if (mask) for (const key in mask) {
			if (!(key in shape)) throw new Error(`Unrecognized key: "${key}"`);
			if (!mask[key]) continue;
			shape[key] = new Class({
				type: "nonoptional",
				innerType: oldShape[key]
			});
		}
		else for (const key in oldShape) shape[key] = new Class({
			type: "nonoptional",
			innerType: oldShape[key]
		});
		assignProp(this, "shape", shape);
		return shape;
	} }));
}
function aborted(x, startIndex = 0) {
	if (x.aborted === true) return true;
	for (let i = startIndex; i < x.issues.length; i++) if (x.issues[i]?.continue !== true) return true;
	return false;
}
function prefixIssues(path, issues) {
	return issues.map((iss) => {
		var _a;
		(_a = iss).path ?? (_a.path = []);
		iss.path.unshift(path);
		return iss;
	});
}
function unwrapMessage(message) {
	return typeof message === "string" ? message : message?.message;
}
function finalizeIssue(iss, ctx, config) {
	const full = {
		...iss,
		path: iss.path ?? []
	};
	if (!iss.message) full.message = unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config.customError?.(iss)) ?? unwrapMessage(config.localeError?.(iss)) ?? "Invalid input";
	delete full.inst;
	delete full.continue;
	if (!ctx?.reportInput) delete full.input;
	return full;
}
function getLengthableOrigin(input) {
	if (Array.isArray(input)) return "array";
	if (typeof input === "string") return "string";
	return "unknown";
}
function issue(...args) {
	const [iss, input, inst] = args;
	if (typeof iss === "string") return {
		message: iss,
		code: "custom",
		input,
		inst
	};
	return { ...iss };
}
// ../../node_modules/zod/v4/core/errors.js
const initializer$1 = (inst, def) => {
	inst.name = "$ZodError";
	Object.defineProperty(inst, "_zod", {
		value: inst._zod,
		enumerable: false
	});
	Object.defineProperty(inst, "issues", {
		value: def,
		enumerable: false
	});
	inst.message = JSON.stringify(def, jsonStringifyReplacer, 2);
	Object.defineProperty(inst, "toString", {
		value: () => inst.message,
		enumerable: false
	});
};
const $ZodError = /* @__PURE__ */ $constructor("$ZodError", initializer$1);
const $ZodRealError = /* @__PURE__ */ $constructor("$ZodError", initializer$1, { Parent: Error });
function flattenError(error, mapper = (issue) => issue.message) {
	const fieldErrors = {};
	const formErrors = [];
	for (const sub of error.issues) if (sub.path.length > 0) {
		fieldErrors[sub.path[0]] = fieldErrors[sub.path[0]] || [];
		fieldErrors[sub.path[0]].push(mapper(sub));
	} else formErrors.push(mapper(sub));
	return {
		formErrors,
		fieldErrors
	};
}
function formatError(error, mapper = (issue) => issue.message) {
	const fieldErrors = { _errors: [] };
	const processError = (error) => {
		for (const issue of error.issues) if (issue.code === "invalid_union" && issue.errors.length) issue.errors.map((issues) => processError({ issues }));
		else if (issue.code === "invalid_key") processError({ issues: issue.issues });
		else if (issue.code === "invalid_element") processError({ issues: issue.issues });
		else if (issue.path.length === 0) fieldErrors._errors.push(mapper(issue));
		else {
			let curr = fieldErrors;
			let i = 0;
			while (i < issue.path.length) {
				const el = issue.path[i];
				if (!(i === issue.path.length - 1)) curr[el] = curr[el] || { _errors: [] };
				else {
					curr[el] = curr[el] || { _errors: [] };
					curr[el]._errors.push(mapper(issue));
				}
				curr = curr[el];
				i++;
			}
		}
	};
	processError(error);
	return fieldErrors;
}
// ../../node_modules/zod/v4/core/parse.js
const _parse = (_Err) => (schema, value, _ctx, _params) => {
	const ctx = _ctx ? Object.assign(_ctx, { async: false }) : { async: false };
	const result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) throw new $ZodAsyncError();
	if (result.issues.length) {
		const e = new ((_params?.Err) ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
		captureStackTrace(e, _params?.callee);
		throw e;
	}
	return result.value;
};
const _parseAsync = (_Err) => async (schema, value, _ctx, params) => {
	const ctx = _ctx ? Object.assign(_ctx, { async: true }) : { async: true };
	let result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) result = await result;
	if (result.issues.length) {
		const e = new ((params?.Err) ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
		captureStackTrace(e, params?.callee);
		throw e;
	}
	return result.value;
};
const _safeParse = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: false
	} : { async: false };
	const result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) throw new $ZodAsyncError();
	return result.issues.length ? {
		success: false,
		error: new (_Err ?? $ZodError)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	} : {
		success: true,
		data: result.value
	};
};
const safeParse$1 = /* @__PURE__*/ _safeParse($ZodRealError);
const _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? Object.assign(_ctx, { async: true }) : { async: true };
	let result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) result = await result;
	return result.issues.length ? {
		success: false,
		error: new _Err(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	} : {
		success: true,
		data: result.value
	};
};
const safeParseAsync$1 = /* @__PURE__*/ _safeParseAsync($ZodRealError);
const _encode = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
	return _parse(_Err)(schema, value, ctx);
};
const _decode = (_Err) => (schema, value, _ctx) => {
	return _parse(_Err)(schema, value, _ctx);
};
const _encodeAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
	return _parseAsync(_Err)(schema, value, ctx);
};
const _decodeAsync = (_Err) => async (schema, value, _ctx) => {
	return _parseAsync(_Err)(schema, value, _ctx);
};
const _safeEncode = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
	return _safeParse(_Err)(schema, value, ctx);
};
const _safeDecode = (_Err) => (schema, value, _ctx) => {
	return _safeParse(_Err)(schema, value, _ctx);
};
const _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
	return _safeParseAsync(_Err)(schema, value, ctx);
};
const _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
	return _safeParseAsync(_Err)(schema, value, _ctx);
};
// ../../node_modules/zod/v4/core/regexes.js
const cuid = /^[cC][^\s-]{8,}$/;
const cuid2 = /^[0-9a-z]+$/;
const ulid = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
const xid = /^[0-9a-vA-V]{20}$/;
const ksuid = /^[A-Za-z0-9]{27}$/;
const nanoid = /^[a-zA-Z0-9_-]{21}$/;
/** ISO 8601-1 duration regex. Does not support the 8601-2 extensions like negative durations or fractional/negative components. */
const duration$1 = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
/** A regex for any UUID-like identifier: 8-4-4-4-12 hex pattern */
const guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
/** Returns a regex for validating an RFC 9562/4122 UUID.
*
* @param version Optionally specify a version 1-8. If no version is specified, all versions are supported. */
const uuid = (version) => {
	if (!version) return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
	return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
/** Practical email validation */
const email = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
const _emoji$1 = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
function emoji() {
	return new RegExp(_emoji$1, "u");
}
const ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
const ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
const cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
const cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
const base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
const base64url = /^[A-Za-z0-9_-]*$/;
const e164 = /^\+[1-9]\d{6,14}$/;
const dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
const date$1 = /*@__PURE__*/ new RegExp(`^${dateSource}$`);
function timeSource(args) {
	const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
	return typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
}
function time$1(args) {
	return new RegExp(`^${timeSource(args)}$`);
}
function datetime$1(args) {
	const time = timeSource({ precision: args.precision });
	const opts = ["Z"];
	if (args.local) opts.push("");
	if (args.offset) opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
	const timeRegex = `${time}(?:${opts.join("|")})`;
	return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
const string$1 = (params) => {
	const regex = params ? `[\\s\\S]{${params?.minimum ?? 0},${params?.maximum ?? ""}}` : `[\\s\\S]*`;
	return new RegExp(`^${regex}$`);
};
const integer = /^-?\d+$/;
const number$1 = /^-?\d+(?:\.\d+)?$/;
const boolean$1 = /^(?:true|false)$/i;
const lowercase = /^[^A-Z]*$/;
const uppercase = /^[^a-z]*$/;
// ../../node_modules/zod/v4/core/checks.js
const $ZodCheck = /*@__PURE__*/ $constructor("$ZodCheck", (inst, def) => {
	var _a;
	inst._zod ?? (inst._zod = {});
	inst._zod.def = def;
	(_a = inst._zod).onattach ?? (_a.onattach = []);
});
const numericOriginMap = {
	number: "number",
	bigint: "bigint",
	object: "date"
};
const $ZodCheckLessThan = /*@__PURE__*/ $constructor("$ZodCheckLessThan", (inst, def) => {
	$ZodCheck.init(inst, def);
	const origin = numericOriginMap[typeof def.value];
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		const curr = (def.inclusive ? bag.maximum : bag.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
		if (def.value < curr) {
			if (def.inclusive) bag.maximum = def.value;
			else bag.exclusiveMaximum = def.value;
		}
	});
	inst._zod.check = (payload) => {
		if (def.inclusive ? payload.value <= def.value : payload.value < def.value) return;
		payload.issues.push({
			origin,
			code: "too_big",
			maximum: typeof def.value === "object" ? def.value.getTime() : def.value,
			input: payload.value,
			inclusive: def.inclusive,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckGreaterThan = /*@__PURE__*/ $constructor("$ZodCheckGreaterThan", (inst, def) => {
	$ZodCheck.init(inst, def);
	const origin = numericOriginMap[typeof def.value];
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		const curr = (def.inclusive ? bag.minimum : bag.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
		if (def.value > curr) {
			if (def.inclusive) bag.minimum = def.value;
			else bag.exclusiveMinimum = def.value;
		}
	});
	inst._zod.check = (payload) => {
		if (def.inclusive ? payload.value >= def.value : payload.value > def.value) return;
		payload.issues.push({
			origin,
			code: "too_small",
			minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
			input: payload.value,
			inclusive: def.inclusive,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckMultipleOf = /*@__PURE__*/ $constructor("$ZodCheckMultipleOf", (inst, def) => {
	$ZodCheck.init(inst, def);
	inst._zod.onattach.push((inst) => {
		var _a;
		(_a = inst._zod.bag).multipleOf ?? (_a.multipleOf = def.value);
	});
	inst._zod.check = (payload) => {
		if (typeof payload.value !== typeof def.value) throw new Error("Cannot mix number and bigint in multiple_of check.");
		if (typeof payload.value === "bigint" ? payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0) return;
		payload.issues.push({
			origin: typeof payload.value,
			code: "not_multiple_of",
			divisor: def.value,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckNumberFormat = /*@__PURE__*/ $constructor("$ZodCheckNumberFormat", (inst, def) => {
	$ZodCheck.init(inst, def);
	def.format = def.format || "float64";
	const isInt = def.format?.includes("int");
	const origin = isInt ? "int" : "number";
	const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.format = def.format;
		bag.minimum = minimum;
		bag.maximum = maximum;
		if (isInt) bag.pattern = integer;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (isInt) {
			if (!Number.isInteger(input)) {
				payload.issues.push({
					expected: origin,
					format: def.format,
					code: "invalid_type",
					continue: false,
					input,
					inst
				});
				return;
			}
			if (!Number.isSafeInteger(input)) {
				if (input > 0) payload.issues.push({
					input,
					code: "too_big",
					maximum: Number.MAX_SAFE_INTEGER,
					note: "Integers must be within the safe integer range.",
					inst,
					origin,
					inclusive: true,
					continue: !def.abort
				});
				else payload.issues.push({
					input,
					code: "too_small",
					minimum: Number.MIN_SAFE_INTEGER,
					note: "Integers must be within the safe integer range.",
					inst,
					origin,
					inclusive: true,
					continue: !def.abort
				});
				return;
			}
		}
		if (input < minimum) payload.issues.push({
			origin: "number",
			input,
			code: "too_small",
			minimum,
			inclusive: true,
			inst,
			continue: !def.abort
		});
		if (input > maximum) payload.issues.push({
			origin: "number",
			input,
			code: "too_big",
			maximum,
			inclusive: true,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckMaxLength = /*@__PURE__*/ $constructor("$ZodCheckMaxLength", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = (payload) => {
		const val = payload.value;
		return !nullish(val) && val.length !== void 0;
	});
	inst._zod.onattach.push((inst) => {
		const curr = inst._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
		if (def.maximum < curr) inst._zod.bag.maximum = def.maximum;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (input.length <= def.maximum) return;
		const origin = getLengthableOrigin(input);
		payload.issues.push({
			origin,
			code: "too_big",
			maximum: def.maximum,
			inclusive: true,
			input,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckMinLength = /*@__PURE__*/ $constructor("$ZodCheckMinLength", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = (payload) => {
		const val = payload.value;
		return !nullish(val) && val.length !== void 0;
	});
	inst._zod.onattach.push((inst) => {
		const curr = inst._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
		if (def.minimum > curr) inst._zod.bag.minimum = def.minimum;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (input.length >= def.minimum) return;
		const origin = getLengthableOrigin(input);
		payload.issues.push({
			origin,
			code: "too_small",
			minimum: def.minimum,
			inclusive: true,
			input,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckLengthEquals = /*@__PURE__*/ $constructor("$ZodCheckLengthEquals", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = (payload) => {
		const val = payload.value;
		return !nullish(val) && val.length !== void 0;
	});
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.minimum = def.length;
		bag.maximum = def.length;
		bag.length = def.length;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		const length = input.length;
		if (length === def.length) return;
		const origin = getLengthableOrigin(input);
		const tooBig = length > def.length;
		payload.issues.push({
			origin,
			...tooBig ? {
				code: "too_big",
				maximum: def.length
			} : {
				code: "too_small",
				minimum: def.length
			},
			inclusive: true,
			exact: true,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckStringFormat = /*@__PURE__*/ $constructor("$ZodCheckStringFormat", (inst, def) => {
	var _a, _b;
	$ZodCheck.init(inst, def);
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.format = def.format;
		if (def.pattern) {
			bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
			bag.patterns.add(def.pattern);
		}
	});
	if (def.pattern) (_a = inst._zod).check ?? (_a.check = (payload) => {
		def.pattern.lastIndex = 0;
		if (def.pattern.test(payload.value)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: def.format,
			input: payload.value,
			...def.pattern ? { pattern: def.pattern.toString() } : {},
			inst,
			continue: !def.abort
		});
	});
	else (_b = inst._zod).check ?? (_b.check = () => {});
});
const $ZodCheckRegex = /*@__PURE__*/ $constructor("$ZodCheckRegex", (inst, def) => {
	$ZodCheckStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		def.pattern.lastIndex = 0;
		if (def.pattern.test(payload.value)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "regex",
			input: payload.value,
			pattern: def.pattern.toString(),
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckLowerCase = /*@__PURE__*/ $constructor("$ZodCheckLowerCase", (inst, def) => {
	def.pattern ?? (def.pattern = lowercase);
	$ZodCheckStringFormat.init(inst, def);
});
const $ZodCheckUpperCase = /*@__PURE__*/ $constructor("$ZodCheckUpperCase", (inst, def) => {
	def.pattern ?? (def.pattern = uppercase);
	$ZodCheckStringFormat.init(inst, def);
});
const $ZodCheckIncludes = /*@__PURE__*/ $constructor("$ZodCheckIncludes", (inst, def) => {
	$ZodCheck.init(inst, def);
	const escapedRegex = escapeRegex(def.includes);
	const pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position}}${escapedRegex}` : escapedRegex);
	def.pattern = pattern;
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
		bag.patterns.add(pattern);
	});
	inst._zod.check = (payload) => {
		if (payload.value.includes(def.includes, def.position)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "includes",
			includes: def.includes,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckStartsWith = /*@__PURE__*/ $constructor("$ZodCheckStartsWith", (inst, def) => {
	$ZodCheck.init(inst, def);
	const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
	def.pattern ?? (def.pattern = pattern);
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
		bag.patterns.add(pattern);
	});
	inst._zod.check = (payload) => {
		if (payload.value.startsWith(def.prefix)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "starts_with",
			prefix: def.prefix,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckEndsWith = /*@__PURE__*/ $constructor("$ZodCheckEndsWith", (inst, def) => {
	$ZodCheck.init(inst, def);
	const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
	def.pattern ?? (def.pattern = pattern);
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
		bag.patterns.add(pattern);
	});
	inst._zod.check = (payload) => {
		if (payload.value.endsWith(def.suffix)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "ends_with",
			suffix: def.suffix,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckOverwrite = /*@__PURE__*/ $constructor("$ZodCheckOverwrite", (inst, def) => {
	$ZodCheck.init(inst, def);
	inst._zod.check = (payload) => {
		payload.value = def.tx(payload.value);
	};
});
// ../../node_modules/zod/v4/core/doc.js
var Doc = class {
	constructor(args = []) {
		this.content = [];
		this.indent = 0;
		if (this) this.args = args;
	}
	indented(fn) {
		this.indent += 1;
		fn(this);
		this.indent -= 1;
	}
	write(arg) {
		if (typeof arg === "function") {
			arg(this, { execution: "sync" });
			arg(this, { execution: "async" });
			return;
		}
		const lines = arg.split("\n").filter((x) => x);
		const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
		const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
		for (const line of dedented) this.content.push(line);
	}
	compile() {
		const F = Function;
		const args = this?.args;
		const lines = [...(this?.content ?? [``]).map((x) => `  ${x}`)];
		return new F(...args, lines.join("\n"));
	}
};
// ../../node_modules/zod/v4/core/versions.js
const version = {
	major: 4,
	minor: 3,
	patch: 6
};
// ../../node_modules/zod/v4/core/schemas.js
const $ZodType = /*@__PURE__*/ $constructor("$ZodType", (inst, def) => {
	var _a;
	inst ?? (inst = {});
	inst._zod.def = def;
	inst._zod.bag = inst._zod.bag || {};
	inst._zod.version = version;
	const checks = [...inst._zod.def.checks ?? []];
	if (inst._zod.traits.has("$ZodCheck")) checks.unshift(inst);
	for (const ch of checks) for (const fn of ch._zod.onattach) fn(inst);
	if (checks.length === 0) {
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		inst._zod.deferred?.push(() => {
			inst._zod.run = inst._zod.parse;
		});
	} else {
		const runChecks = (payload, checks, ctx) => {
			let isAborted = aborted(payload);
			let asyncResult;
			for (const ch of checks) {
				if (ch._zod.def.when) {
					if (!ch._zod.def.when(payload)) continue;
				} else if (isAborted) continue;
				const currLen = payload.issues.length;
				const _ = ch._zod.check(payload);
				if (_ instanceof Promise && ctx?.async === false) throw new $ZodAsyncError();
				if (asyncResult || _ instanceof Promise) asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
					await _;
					if (payload.issues.length === currLen) return;
					if (!isAborted) isAborted = aborted(payload, currLen);
				});
				else {
					if (payload.issues.length === currLen) continue;
					if (!isAborted) isAborted = aborted(payload, currLen);
				}
			}
			if (asyncResult) return asyncResult.then(() => {
				return payload;
			});
			return payload;
		};
		const handleCanaryResult = (canary, payload, ctx) => {
			if (aborted(canary)) {
				canary.aborted = true;
				return canary;
			}
			const checkResult = runChecks(payload, checks, ctx);
			if (checkResult instanceof Promise) {
				if (ctx.async === false) throw new $ZodAsyncError();
				return checkResult.then((checkResult) => inst._zod.parse(checkResult, ctx));
			}
			return inst._zod.parse(checkResult, ctx);
		};
		inst._zod.run = (payload, ctx) => {
			if (ctx.skipChecks) return inst._zod.parse(payload, ctx);
			if (ctx.direction === "backward") {
				const canary = inst._zod.parse({
					value: payload.value,
					issues: []
				}, {
					...ctx,
					skipChecks: true
				});
				if (canary instanceof Promise) return canary.then((canary) => {
					return handleCanaryResult(canary, payload, ctx);
				});
				return handleCanaryResult(canary, payload, ctx);
			}
			const result = inst._zod.parse(payload, ctx);
			if (result instanceof Promise) {
				if (ctx.async === false) throw new $ZodAsyncError();
				return result.then((result) => runChecks(result, checks, ctx));
			}
			return runChecks(result, checks, ctx);
		};
	}
	defineLazy(inst, "~standard", () => ({
		validate: (value) => {
			try {
				const r = safeParse$1(inst, value);
				return r.success ? { value: r.data } : { issues: r.error?.issues };
			} catch (_) {
				return safeParseAsync$1(inst, value).then((r) => r.success ? { value: r.data } : { issues: r.error?.issues });
			}
		},
		vendor: "zod",
		version: 1
	}));
});
const $ZodString = /*@__PURE__*/ $constructor("$ZodString", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = [...inst?._zod.bag?.patterns ?? []].pop() ?? string$1(inst._zod.bag);
	inst._zod.parse = (payload, _) => {
		if (def.coerce) try {
			payload.value = String(payload.value);
		} catch (_) {}
		if (typeof payload.value === "string") return payload;
		payload.issues.push({
			expected: "string",
			code: "invalid_type",
			input: payload.value,
			inst
		});
		return payload;
	};
});
const $ZodStringFormat = /*@__PURE__*/ $constructor("$ZodStringFormat", (inst, def) => {
	$ZodCheckStringFormat.init(inst, def);
	$ZodString.init(inst, def);
});
const $ZodGUID = /*@__PURE__*/ $constructor("$ZodGUID", (inst, def) => {
	def.pattern ?? (def.pattern = guid);
	$ZodStringFormat.init(inst, def);
});
const $ZodUUID = /*@__PURE__*/ $constructor("$ZodUUID", (inst, def) => {
	if (def.version) {
		const v = {
			v1: 1,
			v2: 2,
			v3: 3,
			v4: 4,
			v5: 5,
			v6: 6,
			v7: 7,
			v8: 8
		}[def.version];
		if (v === void 0) throw new Error(`Invalid UUID version: "${def.version}"`);
		def.pattern ?? (def.pattern = uuid(v));
	} else def.pattern ?? (def.pattern = uuid());
	$ZodStringFormat.init(inst, def);
});
const $ZodEmail = /*@__PURE__*/ $constructor("$ZodEmail", (inst, def) => {
	def.pattern ?? (def.pattern = email);
	$ZodStringFormat.init(inst, def);
});
const $ZodURL = /*@__PURE__*/ $constructor("$ZodURL", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		try {
			const trimmed = payload.value.trim();
			const url = new URL(trimmed);
			if (def.hostname) {
				def.hostname.lastIndex = 0;
				if (!def.hostname.test(url.hostname)) payload.issues.push({
					code: "invalid_format",
					format: "url",
					note: "Invalid hostname",
					pattern: def.hostname.source,
					input: payload.value,
					inst,
					continue: !def.abort
				});
			}
			if (def.protocol) {
				def.protocol.lastIndex = 0;
				if (!def.protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol)) payload.issues.push({
					code: "invalid_format",
					format: "url",
					note: "Invalid protocol",
					pattern: def.protocol.source,
					input: payload.value,
					inst,
					continue: !def.abort
				});
			}
			if (def.normalize) payload.value = url.href;
			else payload.value = trimmed;
			return;
		} catch (_) {
			payload.issues.push({
				code: "invalid_format",
				format: "url",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		}
	};
});
const $ZodEmoji = /*@__PURE__*/ $constructor("$ZodEmoji", (inst, def) => {
	def.pattern ?? (def.pattern = emoji());
	$ZodStringFormat.init(inst, def);
});
const $ZodNanoID = /*@__PURE__*/ $constructor("$ZodNanoID", (inst, def) => {
	def.pattern ?? (def.pattern = nanoid);
	$ZodStringFormat.init(inst, def);
});
const $ZodCUID = /*@__PURE__*/ $constructor("$ZodCUID", (inst, def) => {
	def.pattern ?? (def.pattern = cuid);
	$ZodStringFormat.init(inst, def);
});
const $ZodCUID2 = /*@__PURE__*/ $constructor("$ZodCUID2", (inst, def) => {
	def.pattern ?? (def.pattern = cuid2);
	$ZodStringFormat.init(inst, def);
});
const $ZodULID = /*@__PURE__*/ $constructor("$ZodULID", (inst, def) => {
	def.pattern ?? (def.pattern = ulid);
	$ZodStringFormat.init(inst, def);
});
const $ZodXID = /*@__PURE__*/ $constructor("$ZodXID", (inst, def) => {
	def.pattern ?? (def.pattern = xid);
	$ZodStringFormat.init(inst, def);
});
const $ZodKSUID = /*@__PURE__*/ $constructor("$ZodKSUID", (inst, def) => {
	def.pattern ?? (def.pattern = ksuid);
	$ZodStringFormat.init(inst, def);
});
const $ZodISODateTime = /*@__PURE__*/ $constructor("$ZodISODateTime", (inst, def) => {
	def.pattern ?? (def.pattern = datetime$1(def));
	$ZodStringFormat.init(inst, def);
});
const $ZodISODate = /*@__PURE__*/ $constructor("$ZodISODate", (inst, def) => {
	def.pattern ?? (def.pattern = date$1);
	$ZodStringFormat.init(inst, def);
});
const $ZodISOTime = /*@__PURE__*/ $constructor("$ZodISOTime", (inst, def) => {
	def.pattern ?? (def.pattern = time$1(def));
	$ZodStringFormat.init(inst, def);
});
const $ZodISODuration = /*@__PURE__*/ $constructor("$ZodISODuration", (inst, def) => {
	def.pattern ?? (def.pattern = duration$1);
	$ZodStringFormat.init(inst, def);
});
const $ZodIPv4 = /*@__PURE__*/ $constructor("$ZodIPv4", (inst, def) => {
	def.pattern ?? (def.pattern = ipv4);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.format = `ipv4`;
});
const $ZodIPv6 = /*@__PURE__*/ $constructor("$ZodIPv6", (inst, def) => {
	def.pattern ?? (def.pattern = ipv6);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.format = `ipv6`;
	inst._zod.check = (payload) => {
		try {
			new URL(`http://[${payload.value}]`);
		} catch {
			payload.issues.push({
				code: "invalid_format",
				format: "ipv6",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		}
	};
});
const $ZodCIDRv4 = /*@__PURE__*/ $constructor("$ZodCIDRv4", (inst, def) => {
	def.pattern ?? (def.pattern = cidrv4);
	$ZodStringFormat.init(inst, def);
});
const $ZodCIDRv6 = /*@__PURE__*/ $constructor("$ZodCIDRv6", (inst, def) => {
	def.pattern ?? (def.pattern = cidrv6);
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		const parts = payload.value.split("/");
		try {
			if (parts.length !== 2) throw new Error();
			const [address, prefix] = parts;
			if (!prefix) throw new Error();
			const prefixNum = Number(prefix);
			if (`${prefixNum}` !== prefix) throw new Error();
			if (prefixNum < 0 || prefixNum > 128) throw new Error();
			new URL(`http://[${address}]`);
		} catch {
			payload.issues.push({
				code: "invalid_format",
				format: "cidrv6",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		}
	};
});
function isValidBase64(data) {
	if (data === "") return true;
	if (data.length % 4 !== 0) return false;
	try {
		atob(data);
		return true;
	} catch {
		return false;
	}
}
const $ZodBase64 = /*@__PURE__*/ $constructor("$ZodBase64", (inst, def) => {
	def.pattern ?? (def.pattern = base64);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.contentEncoding = "base64";
	inst._zod.check = (payload) => {
		if (isValidBase64(payload.value)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "base64",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
function isValidBase64URL(data) {
	if (!base64url.test(data)) return false;
	const base64 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
	return isValidBase64(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
}
const $ZodBase64URL = /*@__PURE__*/ $constructor("$ZodBase64URL", (inst, def) => {
	def.pattern ?? (def.pattern = base64url);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.contentEncoding = "base64url";
	inst._zod.check = (payload) => {
		if (isValidBase64URL(payload.value)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "base64url",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodE164 = /*@__PURE__*/ $constructor("$ZodE164", (inst, def) => {
	def.pattern ?? (def.pattern = e164);
	$ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
	try {
		const tokensParts = token.split(".");
		if (tokensParts.length !== 3) return false;
		const [header] = tokensParts;
		if (!header) return false;
		const parsedHeader = JSON.parse(atob(header));
		if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT") return false;
		if (!parsedHeader.alg) return false;
		if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm)) return false;
		return true;
	} catch {
		return false;
	}
}
const $ZodJWT = /*@__PURE__*/ $constructor("$ZodJWT", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (isValidJWT(payload.value, def.alg)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "jwt",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodNumber = /*@__PURE__*/ $constructor("$ZodNumber", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = inst._zod.bag.pattern ?? number$1;
	inst._zod.parse = (payload, _ctx) => {
		if (def.coerce) try {
			payload.value = Number(payload.value);
		} catch (_) {}
		const input = payload.value;
		if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) return payload;
		const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? "Infinity" : void 0 : void 0;
		payload.issues.push({
			expected: "number",
			code: "invalid_type",
			input,
			inst,
			...received ? { received } : {}
		});
		return payload;
	};
});
const $ZodNumberFormat = /*@__PURE__*/ $constructor("$ZodNumberFormat", (inst, def) => {
	$ZodCheckNumberFormat.init(inst, def);
	$ZodNumber.init(inst, def);
});
const $ZodBoolean = /*@__PURE__*/ $constructor("$ZodBoolean", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = boolean$1;
	inst._zod.parse = (payload, _ctx) => {
		if (def.coerce) try {
			payload.value = Boolean(payload.value);
		} catch (_) {}
		const input = payload.value;
		if (typeof input === "boolean") return payload;
		payload.issues.push({
			expected: "boolean",
			code: "invalid_type",
			input,
			inst
		});
		return payload;
	};
});
const $ZodUnknown = /*@__PURE__*/ $constructor("$ZodUnknown", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload) => payload;
});
const $ZodNever = /*@__PURE__*/ $constructor("$ZodNever", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, _ctx) => {
		payload.issues.push({
			expected: "never",
			code: "invalid_type",
			input: payload.value,
			inst
		});
		return payload;
	};
});
function handleArrayResult(result, final, index) {
	if (result.issues.length) final.issues.push(...prefixIssues(index, result.issues));
	final.value[index] = result.value;
}
const $ZodArray = /*@__PURE__*/ $constructor("$ZodArray", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!Array.isArray(input)) {
			payload.issues.push({
				expected: "array",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		payload.value = Array(input.length);
		const proms = [];
		for (let i = 0; i < input.length; i++) {
			const item = input[i];
			const result = def.element._zod.run({
				value: item,
				issues: []
			}, ctx);
			if (result instanceof Promise) proms.push(result.then((result) => handleArrayResult(result, payload, i)));
			else handleArrayResult(result, payload, i);
		}
		if (proms.length) return Promise.all(proms).then(() => payload);
		return payload;
	};
});
function handlePropertyResult(result, final, key, input, isOptionalOut) {
	if (result.issues.length) {
		if (isOptionalOut && !(key in input)) return;
		final.issues.push(...prefixIssues(key, result.issues));
	}
	if (result.value === void 0) {
		if (key in input) final.value[key] = void 0;
	} else final.value[key] = result.value;
}
function normalizeDef(def) {
	const keys = Object.keys(def.shape);
	for (const k of keys) if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) throw new Error(`Invalid element at key "${k}": expected a Zod schema`);
	const okeys = optionalKeys(def.shape);
	return {
		...def,
		keys,
		keySet: new Set(keys),
		numKeys: keys.length,
		optionalKeys: new Set(okeys)
	};
}
function handleCatchall(proms, input, payload, ctx, def, inst) {
	const unrecognized = [];
	const keySet = def.keySet;
	const _catchall = def.catchall._zod;
	const t = _catchall.def.type;
	const isOptionalOut = _catchall.optout === "optional";
	for (const key in input) {
		if (keySet.has(key)) continue;
		if (t === "never") {
			unrecognized.push(key);
			continue;
		}
		const r = _catchall.run({
			value: input[key],
			issues: []
		}, ctx);
		if (r instanceof Promise) proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, isOptionalOut)));
		else handlePropertyResult(r, payload, key, input, isOptionalOut);
	}
	if (unrecognized.length) payload.issues.push({
		code: "unrecognized_keys",
		keys: unrecognized,
		input,
		inst
	});
	if (!proms.length) return payload;
	return Promise.all(proms).then(() => {
		return payload;
	});
}
const $ZodObject = /*@__PURE__*/ $constructor("$ZodObject", (inst, def) => {
	$ZodType.init(inst, def);
	if (!Object.getOwnPropertyDescriptor(def, "shape")?.get) {
		const sh = def.shape;
		Object.defineProperty(def, "shape", { get: () => {
			const newSh = { ...sh };
			Object.defineProperty(def, "shape", { value: newSh });
			return newSh;
		} });
	}
	const _normalized = cached(() => normalizeDef(def));
	defineLazy(inst._zod, "propValues", () => {
		const shape = def.shape;
		const propValues = {};
		for (const key in shape) {
			const field = shape[key]._zod;
			if (field.values) {
				propValues[key] ?? (propValues[key] = /* @__PURE__ */ new Set());
				for (const v of field.values) propValues[key].add(v);
			}
		}
		return propValues;
	});
	const isObject$2 = isObject;
	const catchall = def.catchall;
	let value;
	inst._zod.parse = (payload, ctx) => {
		value ?? (value = _normalized.value);
		const input = payload.value;
		if (!isObject$2(input)) {
			payload.issues.push({
				expected: "object",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		payload.value = {};
		const proms = [];
		const shape = value.shape;
		for (const key of value.keys) {
			const el = shape[key];
			const isOptionalOut = el._zod.optout === "optional";
			const r = el._zod.run({
				value: input[key],
				issues: []
			}, ctx);
			if (r instanceof Promise) proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, isOptionalOut)));
			else handlePropertyResult(r, payload, key, input, isOptionalOut);
		}
		if (!catchall) return proms.length ? Promise.all(proms).then(() => payload) : payload;
		return handleCatchall(proms, input, payload, ctx, _normalized.value, inst);
	};
});
const $ZodObjectJIT = /*@__PURE__*/ $constructor("$ZodObjectJIT", (inst, def) => {
	$ZodObject.init(inst, def);
	const superParse = inst._zod.parse;
	const _normalized = cached(() => normalizeDef(def));
	const generateFastpass = (shape) => {
		const doc = new Doc([
			"shape",
			"payload",
			"ctx"
		]);
		const normalized = _normalized.value;
		const parseStr = (key) => {
			const k = esc(key);
			return `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
		};
		doc.write(`const input = payload.value;`);
		const ids = Object.create(null);
		let counter = 0;
		for (const key of normalized.keys) ids[key] = `key_${counter++}`;
		doc.write(`const newResult = {};`);
		for (const key of normalized.keys) {
			const id = ids[key];
			const k = esc(key);
			const isOptionalOut = shape[key]?._zod?.optout === "optional";
			doc.write(`const ${id} = ${parseStr(key)};`);
			if (isOptionalOut) doc.write(`
        if (${id}.issues.length) {
          if (${k} in input) {
            payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
              ...iss,
              path: iss.path ? [${k}, ...iss.path] : [${k}]
            })));
          }
        }
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
			else doc.write(`
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
		}
		doc.write(`payload.value = newResult;`);
		doc.write(`return payload;`);
		const fn = doc.compile();
		return (payload, ctx) => fn(shape, payload, ctx);
	};
	let fastpass;
	const isObject$1 = isObject;
	const jit = !globalConfig.jitless;
	const fastEnabled = jit && allowsEval.value;
	const catchall = def.catchall;
	let value;
	inst._zod.parse = (payload, ctx) => {
		value ?? (value = _normalized.value);
		const input = payload.value;
		if (!isObject$1(input)) {
			payload.issues.push({
				expected: "object",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
			if (!fastpass) fastpass = generateFastpass(def.shape);
			payload = fastpass(payload, ctx);
			if (!catchall) return payload;
			return handleCatchall([], input, payload, ctx, value, inst);
		}
		return superParse(payload, ctx);
	};
});
function handleUnionResults(results, final, inst, ctx) {
	for (const result of results) if (result.issues.length === 0) {
		final.value = result.value;
		return final;
	}
	const nonaborted = results.filter((r) => !aborted(r));
	if (nonaborted.length === 1) {
		final.value = nonaborted[0].value;
		return nonaborted[0];
	}
	final.issues.push({
		code: "invalid_union",
		input: final.value,
		inst,
		errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	});
	return final;
}
const $ZodUnion = /*@__PURE__*/ $constructor("$ZodUnion", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "optin", () => def.options.some((o) => o._zod.optin === "optional") ? "optional" : void 0);
	defineLazy(inst._zod, "optout", () => def.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0);
	defineLazy(inst._zod, "values", () => {
		if (def.options.every((o) => o._zod.values)) return new Set(def.options.flatMap((option) => Array.from(option._zod.values)));
	});
	defineLazy(inst._zod, "pattern", () => {
		if (def.options.every((o) => o._zod.pattern)) {
			const patterns = def.options.map((o) => o._zod.pattern);
			return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
		}
	});
	const single = def.options.length === 1;
	const first = def.options[0]._zod.run;
	inst._zod.parse = (payload, ctx) => {
		if (single) return first(payload, ctx);
		let async = false;
		const results = [];
		for (const option of def.options) {
			const result = option._zod.run({
				value: payload.value,
				issues: []
			}, ctx);
			if (result instanceof Promise) {
				results.push(result);
				async = true;
			} else {
				if (result.issues.length === 0) return result;
				results.push(result);
			}
		}
		if (!async) return handleUnionResults(results, payload, inst, ctx);
		return Promise.all(results).then((results) => {
			return handleUnionResults(results, payload, inst, ctx);
		});
	};
});
const $ZodDiscriminatedUnion = /*@__PURE__*/ $constructor("$ZodDiscriminatedUnion", (inst, def) => {
	def.inclusive = false;
	$ZodUnion.init(inst, def);
	const _super = inst._zod.parse;
	defineLazy(inst._zod, "propValues", () => {
		const propValues = {};
		for (const option of def.options) {
			const pv = option._zod.propValues;
			if (!pv || Object.keys(pv).length === 0) throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(option)}"`);
			for (const [k, v] of Object.entries(pv)) {
				if (!propValues[k]) propValues[k] = /* @__PURE__ */ new Set();
				for (const val of v) propValues[k].add(val);
			}
		}
		return propValues;
	});
	const disc = cached(() => {
		const opts = def.options;
		const map = /* @__PURE__ */ new Map();
		for (const o of opts) {
			const values = o._zod.propValues?.[def.discriminator];
			if (!values || values.size === 0) throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(o)}"`);
			for (const v of values) {
				if (map.has(v)) throw new Error(`Duplicate discriminator value "${String(v)}"`);
				map.set(v, o);
			}
		}
		return map;
	});
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!isObject(input)) {
			payload.issues.push({
				code: "invalid_type",
				expected: "object",
				input,
				inst
			});
			return payload;
		}
		const opt = disc.value.get(input?.[def.discriminator]);
		if (opt) return opt._zod.run(payload, ctx);
		if (def.unionFallback) return _super(payload, ctx);
		payload.issues.push({
			code: "invalid_union",
			errors: [],
			note: "No matching discriminator",
			discriminator: def.discriminator,
			input,
			path: [def.discriminator],
			inst
		});
		return payload;
	};
});
const $ZodIntersection = /*@__PURE__*/ $constructor("$ZodIntersection", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		const left = def.left._zod.run({
			value: input,
			issues: []
		}, ctx);
		const right = def.right._zod.run({
			value: input,
			issues: []
		}, ctx);
		if (left instanceof Promise || right instanceof Promise) return Promise.all([left, right]).then(([left, right]) => {
			return handleIntersectionResults(payload, left, right);
		});
		return handleIntersectionResults(payload, left, right);
	};
});
function mergeValues(a, b) {
	if (a === b) return {
		valid: true,
		data: a
	};
	if (a instanceof Date && b instanceof Date && +a === +b) return {
		valid: true,
		data: a
	};
	if (isPlainObject(a) && isPlainObject(b)) {
		const bKeys = Object.keys(b);
		const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
		const newObj = {
			...a,
			...b
		};
		for (const key of sharedKeys) {
			const sharedValue = mergeValues(a[key], b[key]);
			if (!sharedValue.valid) return {
				valid: false,
				mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
			};
			newObj[key] = sharedValue.data;
		}
		return {
			valid: true,
			data: newObj
		};
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return {
			valid: false,
			mergeErrorPath: []
		};
		const newArray = [];
		for (let index = 0; index < a.length; index++) {
			const itemA = a[index];
			const itemB = b[index];
			const sharedValue = mergeValues(itemA, itemB);
			if (!sharedValue.valid) return {
				valid: false,
				mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
			};
			newArray.push(sharedValue.data);
		}
		return {
			valid: true,
			data: newArray
		};
	}
	return {
		valid: false,
		mergeErrorPath: []
	};
}
function handleIntersectionResults(result, left, right) {
	const unrecKeys = /* @__PURE__ */ new Map();
	let unrecIssue;
	for (const iss of left.issues) if (iss.code === "unrecognized_keys") {
		unrecIssue ?? (unrecIssue = iss);
		for (const k of iss.keys) {
			if (!unrecKeys.has(k)) unrecKeys.set(k, {});
			unrecKeys.get(k).l = true;
		}
	} else result.issues.push(iss);
	for (const iss of right.issues) if (iss.code === "unrecognized_keys") for (const k of iss.keys) {
		if (!unrecKeys.has(k)) unrecKeys.set(k, {});
		unrecKeys.get(k).r = true;
	}
	else result.issues.push(iss);
	const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
	if (bothKeys.length && unrecIssue) result.issues.push({
		...unrecIssue,
		keys: bothKeys
	});
	if (aborted(result)) return result;
	const merged = mergeValues(left.value, right.value);
	if (!merged.valid) throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath)}`);
	result.value = merged.data;
	return result;
}
const $ZodRecord = /*@__PURE__*/ $constructor("$ZodRecord", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!isPlainObject(input)) {
			payload.issues.push({
				expected: "record",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		const proms = [];
		const values = def.keyType._zod.values;
		if (values) {
			payload.value = {};
			const recordKeys = /* @__PURE__ */ new Set();
			for (const key of values) if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
				recordKeys.add(typeof key === "number" ? key.toString() : key);
				const result = def.valueType._zod.run({
					value: input[key],
					issues: []
				}, ctx);
				if (result instanceof Promise) proms.push(result.then((result) => {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[key] = result.value;
				}));
				else {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[key] = result.value;
				}
			}
			let unrecognized;
			for (const key in input) if (!recordKeys.has(key)) {
				unrecognized = unrecognized ?? [];
				unrecognized.push(key);
			}
			if (unrecognized && unrecognized.length > 0) payload.issues.push({
				code: "unrecognized_keys",
				input,
				inst,
				keys: unrecognized
			});
		} else {
			payload.value = {};
			for (const key of Reflect.ownKeys(input)) {
				if (key === "__proto__") continue;
				let keyResult = def.keyType._zod.run({
					value: key,
					issues: []
				}, ctx);
				if (keyResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
				if (typeof key === "string" && number$1.test(key) && keyResult.issues.length) {
					const retryResult = def.keyType._zod.run({
						value: Number(key),
						issues: []
					}, ctx);
					if (retryResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
					if (retryResult.issues.length === 0) keyResult = retryResult;
				}
				if (keyResult.issues.length) {
					if (def.mode === "loose") payload.value[key] = input[key];
					else payload.issues.push({
						code: "invalid_key",
						origin: "record",
						issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
						input: key,
						path: [key],
						inst
					});
					continue;
				}
				const result = def.valueType._zod.run({
					value: input[key],
					issues: []
				}, ctx);
				if (result instanceof Promise) proms.push(result.then((result) => {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[keyResult.value] = result.value;
				}));
				else {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[keyResult.value] = result.value;
				}
			}
		}
		if (proms.length) return Promise.all(proms).then(() => payload);
		return payload;
	};
});
const $ZodEnum = /*@__PURE__*/ $constructor("$ZodEnum", (inst, def) => {
	$ZodType.init(inst, def);
	const values = getEnumValues(def.entries);
	const valuesSet = new Set(values);
	inst._zod.values = valuesSet;
	inst._zod.pattern = new RegExp(`^(${values.filter((k) => propertyKeyTypes.has(typeof k)).map((o) => typeof o === "string" ? escapeRegex(o) : o.toString()).join("|")})$`);
	inst._zod.parse = (payload, _ctx) => {
		const input = payload.value;
		if (valuesSet.has(input)) return payload;
		payload.issues.push({
			code: "invalid_value",
			values,
			input,
			inst
		});
		return payload;
	};
});
const $ZodLiteral = /*@__PURE__*/ $constructor("$ZodLiteral", (inst, def) => {
	$ZodType.init(inst, def);
	if (def.values.length === 0) throw new Error("Cannot create literal schema with no valid values");
	const values = new Set(def.values);
	inst._zod.values = values;
	inst._zod.pattern = new RegExp(`^(${def.values.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$`);
	inst._zod.parse = (payload, _ctx) => {
		const input = payload.value;
		if (values.has(input)) return payload;
		payload.issues.push({
			code: "invalid_value",
			values: def.values,
			input,
			inst
		});
		return payload;
	};
});
const $ZodTransform = /*@__PURE__*/ $constructor("$ZodTransform", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
		const _out = def.transform(payload.value, payload);
		if (ctx.async) return (_out instanceof Promise ? _out : Promise.resolve(_out)).then((output) => {
			payload.value = output;
			return payload;
		});
		if (_out instanceof Promise) throw new $ZodAsyncError();
		payload.value = _out;
		return payload;
	};
});
function handleOptionalResult(result, input) {
	if (result.issues.length && input === void 0) return {
		issues: [],
		value: void 0
	};
	return result;
}
const $ZodOptional = /*@__PURE__*/ $constructor("$ZodOptional", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	inst._zod.optout = "optional";
	defineLazy(inst._zod, "values", () => {
		return def.innerType._zod.values ? /* @__PURE__ */ new Set([...def.innerType._zod.values, void 0]) : void 0;
	});
	defineLazy(inst._zod, "pattern", () => {
		const pattern = def.innerType._zod.pattern;
		return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		if (def.innerType._zod.optin === "optional") {
			const result = def.innerType._zod.run(payload, ctx);
			if (result instanceof Promise) return result.then((r) => handleOptionalResult(r, payload.value));
			return handleOptionalResult(result, payload.value);
		}
		if (payload.value === void 0) return payload;
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodExactOptional = /*@__PURE__*/ $constructor("$ZodExactOptional", (inst, def) => {
	$ZodOptional.init(inst, def);
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	defineLazy(inst._zod, "pattern", () => def.innerType._zod.pattern);
	inst._zod.parse = (payload, ctx) => {
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodNullable = /*@__PURE__*/ $constructor("$ZodNullable", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
	defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
	defineLazy(inst._zod, "pattern", () => {
		const pattern = def.innerType._zod.pattern;
		return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : void 0;
	});
	defineLazy(inst._zod, "values", () => {
		return def.innerType._zod.values ? /* @__PURE__ */ new Set([...def.innerType._zod.values, null]) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		if (payload.value === null) return payload;
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodDefault = /*@__PURE__*/ $constructor("$ZodDefault", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		if (payload.value === void 0) {
			payload.value = def.defaultValue;
			/**
			* $ZodDefault returns the default value immediately in forward direction.
			* It doesn't pass the default value into the validator ("prefault"). There's no reason to pass the default value through validation. The validity of the default is enforced by TypeScript statically. Otherwise, it's the responsibility of the user to ensure the default is valid. In the case of pipes with divergent in/out types, you can specify the default on the `in` schema of your ZodPipe to set a "prefault" for the pipe.   */
			return payload;
		}
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => handleDefaultResult(result, def));
		return handleDefaultResult(result, def);
	};
});
function handleDefaultResult(payload, def) {
	if (payload.value === void 0) payload.value = def.defaultValue;
	return payload;
}
const $ZodPrefault = /*@__PURE__*/ $constructor("$ZodPrefault", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		if (payload.value === void 0) payload.value = def.defaultValue;
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodNonOptional = /*@__PURE__*/ $constructor("$ZodNonOptional", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "values", () => {
		const v = def.innerType._zod.values;
		return v ? new Set([...v].filter((x) => x !== void 0)) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => handleNonOptionalResult(result, inst));
		return handleNonOptionalResult(result, inst);
	};
});
function handleNonOptionalResult(payload, inst) {
	if (!payload.issues.length && payload.value === void 0) payload.issues.push({
		code: "invalid_type",
		expected: "nonoptional",
		input: payload.value,
		inst
	});
	return payload;
}
const $ZodCatch = /*@__PURE__*/ $constructor("$ZodCatch", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
	defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => {
			payload.value = result.value;
			if (result.issues.length) {
				payload.value = def.catchValue({
					...payload,
					error: { issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config())) },
					input: payload.value
				});
				payload.issues = [];
			}
			return payload;
		});
		payload.value = result.value;
		if (result.issues.length) {
			payload.value = def.catchValue({
				...payload,
				error: { issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config())) },
				input: payload.value
			});
			payload.issues = [];
		}
		return payload;
	};
});
const $ZodPipe = /*@__PURE__*/ $constructor("$ZodPipe", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "values", () => def.in._zod.values);
	defineLazy(inst._zod, "optin", () => def.in._zod.optin);
	defineLazy(inst._zod, "optout", () => def.out._zod.optout);
	defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") {
			const right = def.out._zod.run(payload, ctx);
			if (right instanceof Promise) return right.then((right) => handlePipeResult(right, def.in, ctx));
			return handlePipeResult(right, def.in, ctx);
		}
		const left = def.in._zod.run(payload, ctx);
		if (left instanceof Promise) return left.then((left) => handlePipeResult(left, def.out, ctx));
		return handlePipeResult(left, def.out, ctx);
	};
});
function handlePipeResult(left, next, ctx) {
	if (left.issues.length) {
		left.aborted = true;
		return left;
	}
	return next._zod.run({
		value: left.value,
		issues: left.issues
	}, ctx);
}
const $ZodReadonly = /*@__PURE__*/ $constructor("$ZodReadonly", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "propValues", () => def.innerType._zod.propValues);
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	defineLazy(inst._zod, "optin", () => def.innerType?._zod?.optin);
	defineLazy(inst._zod, "optout", () => def.innerType?._zod?.optout);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then(handleReadonlyResult);
		return handleReadonlyResult(result);
	};
});
function handleReadonlyResult(payload) {
	payload.value = Object.freeze(payload.value);
	return payload;
}
const $ZodCustom = /*@__PURE__*/ $constructor("$ZodCustom", (inst, def) => {
	$ZodCheck.init(inst, def);
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, _) => {
		return payload;
	};
	inst._zod.check = (payload) => {
		const input = payload.value;
		const r = def.fn(input);
		if (r instanceof Promise) return r.then((r) => handleRefineResult(r, payload, input, inst));
		handleRefineResult(r, payload, input, inst);
	};
});
function handleRefineResult(result, payload, input, inst) {
	if (!result) {
		const _iss = {
			code: "custom",
			input,
			inst,
			path: [...inst._zod.def.path ?? []],
			continue: !inst._zod.def.abort
		};
		if (inst._zod.def.params) _iss.params = inst._zod.def.params;
		payload.issues.push(issue(_iss));
	}
}
// ../../node_modules/zod/v4/core/registries.js
var _a;
var $ZodRegistry = class {
	constructor() {
		this._map = /* @__PURE__ */ new WeakMap();
		this._idmap = /* @__PURE__ */ new Map();
	}
	add(schema, ..._meta) {
		const meta = _meta[0];
		this._map.set(schema, meta);
		if (meta && typeof meta === "object" && "id" in meta) this._idmap.set(meta.id, schema);
		return this;
	}
	clear() {
		this._map = /* @__PURE__ */ new WeakMap();
		this._idmap = /* @__PURE__ */ new Map();
		return this;
	}
	remove(schema) {
		const meta = this._map.get(schema);
		if (meta && typeof meta === "object" && "id" in meta) this._idmap.delete(meta.id);
		this._map.delete(schema);
		return this;
	}
	get(schema) {
		const p = schema._zod.parent;
		if (p) {
			const pm = { ...this.get(p) ?? {} };
			delete pm.id;
			const f = {
				...pm,
				...this._map.get(schema)
			};
			return Object.keys(f).length ? f : void 0;
		}
		return this._map.get(schema);
	}
	has(schema) {
		return this._map.has(schema);
	}
};
function registry() {
	return new $ZodRegistry();
}
(_a = globalThis).__zod_globalRegistry ?? (_a.__zod_globalRegistry = registry());
const globalRegistry = globalThis.__zod_globalRegistry;
// ../../node_modules/zod/v4/core/api.js
// @__NO_SIDE_EFFECTS__
function _string(Class, params) {
	return new Class({
		type: "string",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _email(Class, params) {
	return new Class({
		type: "string",
		format: "email",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _guid(Class, params) {
	return new Class({
		type: "string",
		format: "guid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuid(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv4(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v4",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv6(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v6",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv7(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v7",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _url(Class, params) {
	return new Class({
		type: "string",
		format: "url",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _emoji(Class, params) {
	return new Class({
		type: "string",
		format: "emoji",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _nanoid(Class, params) {
	return new Class({
		type: "string",
		format: "nanoid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cuid(Class, params) {
	return new Class({
		type: "string",
		format: "cuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cuid2(Class, params) {
	return new Class({
		type: "string",
		format: "cuid2",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ulid(Class, params) {
	return new Class({
		type: "string",
		format: "ulid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _xid(Class, params) {
	return new Class({
		type: "string",
		format: "xid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ksuid(Class, params) {
	return new Class({
		type: "string",
		format: "ksuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ipv4(Class, params) {
	return new Class({
		type: "string",
		format: "ipv4",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ipv6(Class, params) {
	return new Class({
		type: "string",
		format: "ipv6",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cidrv4(Class, params) {
	return new Class({
		type: "string",
		format: "cidrv4",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cidrv6(Class, params) {
	return new Class({
		type: "string",
		format: "cidrv6",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _base64(Class, params) {
	return new Class({
		type: "string",
		format: "base64",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _base64url(Class, params) {
	return new Class({
		type: "string",
		format: "base64url",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _e164(Class, params) {
	return new Class({
		type: "string",
		format: "e164",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _jwt(Class, params) {
	return new Class({
		type: "string",
		format: "jwt",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDateTime(Class, params) {
	return new Class({
		type: "string",
		format: "datetime",
		check: "string_format",
		offset: false,
		local: false,
		precision: null,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDate(Class, params) {
	return new Class({
		type: "string",
		format: "date",
		check: "string_format",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoTime(Class, params) {
	return new Class({
		type: "string",
		format: "time",
		check: "string_format",
		precision: null,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDuration(Class, params) {
	return new Class({
		type: "string",
		format: "duration",
		check: "string_format",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _number(Class, params) {
	return new Class({
		type: "number",
		checks: [],
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _int(Class, params) {
	return new Class({
		type: "number",
		check: "number_format",
		abort: false,
		format: "safeint",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _boolean(Class, params) {
	return new Class({
		type: "boolean",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _unknown(Class) {
	return new Class({ type: "unknown" });
}
// @__NO_SIDE_EFFECTS__
function _never(Class, params) {
	return new Class({
		type: "never",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _lt(value, params) {
	return new $ZodCheckLessThan({
		check: "less_than",
		...normalizeParams(params),
		value,
		inclusive: false
	});
}
// @__NO_SIDE_EFFECTS__
function _lte(value, params) {
	return new $ZodCheckLessThan({
		check: "less_than",
		...normalizeParams(params),
		value,
		inclusive: true
	});
}
// @__NO_SIDE_EFFECTS__
function _gt(value, params) {
	return new $ZodCheckGreaterThan({
		check: "greater_than",
		...normalizeParams(params),
		value,
		inclusive: false
	});
}
// @__NO_SIDE_EFFECTS__
function _gte(value, params) {
	return new $ZodCheckGreaterThan({
		check: "greater_than",
		...normalizeParams(params),
		value,
		inclusive: true
	});
}
// @__NO_SIDE_EFFECTS__
function _multipleOf(value, params) {
	return new $ZodCheckMultipleOf({
		check: "multiple_of",
		...normalizeParams(params),
		value
	});
}
// @__NO_SIDE_EFFECTS__
function _maxLength(maximum, params) {
	return new $ZodCheckMaxLength({
		check: "max_length",
		...normalizeParams(params),
		maximum
	});
}
// @__NO_SIDE_EFFECTS__
function _minLength(minimum, params) {
	return new $ZodCheckMinLength({
		check: "min_length",
		...normalizeParams(params),
		minimum
	});
}
// @__NO_SIDE_EFFECTS__
function _length(length, params) {
	return new $ZodCheckLengthEquals({
		check: "length_equals",
		...normalizeParams(params),
		length
	});
}
// @__NO_SIDE_EFFECTS__
function _regex(pattern, params) {
	return new $ZodCheckRegex({
		check: "string_format",
		format: "regex",
		...normalizeParams(params),
		pattern
	});
}
// @__NO_SIDE_EFFECTS__
function _lowercase(params) {
	return new $ZodCheckLowerCase({
		check: "string_format",
		format: "lowercase",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uppercase(params) {
	return new $ZodCheckUpperCase({
		check: "string_format",
		format: "uppercase",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _includes(includes, params) {
	return new $ZodCheckIncludes({
		check: "string_format",
		format: "includes",
		...normalizeParams(params),
		includes
	});
}
// @__NO_SIDE_EFFECTS__
function _startsWith(prefix, params) {
	return new $ZodCheckStartsWith({
		check: "string_format",
		format: "starts_with",
		...normalizeParams(params),
		prefix
	});
}
// @__NO_SIDE_EFFECTS__
function _endsWith(suffix, params) {
	return new $ZodCheckEndsWith({
		check: "string_format",
		format: "ends_with",
		...normalizeParams(params),
		suffix
	});
}
// @__NO_SIDE_EFFECTS__
function _overwrite(tx) {
	return new $ZodCheckOverwrite({
		check: "overwrite",
		tx
	});
}
// @__NO_SIDE_EFFECTS__
function _normalize(form) {
	return /* @__PURE__ */ _overwrite((input) => input.normalize(form));
}
// @__NO_SIDE_EFFECTS__
function _trim() {
	return /* @__PURE__ */ _overwrite((input) => input.trim());
}
// @__NO_SIDE_EFFECTS__
function _toLowerCase() {
	return /* @__PURE__ */ _overwrite((input) => input.toLowerCase());
}
// @__NO_SIDE_EFFECTS__
function _toUpperCase() {
	return /* @__PURE__ */ _overwrite((input) => input.toUpperCase());
}
// @__NO_SIDE_EFFECTS__
function _slugify() {
	return /* @__PURE__ */ _overwrite((input) => slugify(input));
}
// @__NO_SIDE_EFFECTS__
function _array(Class, element, params) {
	return new Class({
		type: "array",
		element,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _refine(Class, fn, _params) {
	return new Class({
		type: "custom",
		check: "custom",
		fn,
		...normalizeParams(_params)
	});
}
// @__NO_SIDE_EFFECTS__
function _superRefine(fn) {
	const ch = /* @__PURE__ */ _check((payload) => {
		payload.addIssue = (issue$2) => {
			if (typeof issue$2 === "string") payload.issues.push(issue(issue$2, payload.value, ch._zod.def));
			else {
				const _issue = issue$2;
				if (_issue.fatal) _issue.continue = false;
				_issue.code ?? (_issue.code = "custom");
				_issue.input ?? (_issue.input = payload.value);
				_issue.inst ?? (_issue.inst = ch);
				_issue.continue ?? (_issue.continue = !ch._zod.def.abort);
				payload.issues.push(issue(_issue));
			}
		};
		return fn(payload.value, payload);
	});
	return ch;
}
// @__NO_SIDE_EFFECTS__
function _check(fn, params) {
	const ch = new $ZodCheck({
		check: "custom",
		...normalizeParams(params)
	});
	ch._zod.check = fn;
	return ch;
}
// ../../node_modules/zod/v4/core/to-json-schema.js
function initializeContext(params) {
	let target = params?.target ?? "draft-2020-12";
	if (target === "draft-4") target = "draft-04";
	if (target === "draft-7") target = "draft-07";
	return {
		processors: params.processors ?? {},
		metadataRegistry: params?.metadata ?? globalRegistry,
		target,
		unrepresentable: params?.unrepresentable ?? "throw",
		override: params?.override ?? (() => {}),
		io: params?.io ?? "output",
		counter: 0,
		seen: /* @__PURE__ */ new Map(),
		cycles: params?.cycles ?? "ref",
		reused: params?.reused ?? "inline",
		external: params?.external ?? void 0
	};
}
function process$1(schema, ctx, _params = {
	path: [],
	schemaPath: []
}) {
	var _a;
	const def = schema._zod.def;
	const seen = ctx.seen.get(schema);
	if (seen) {
		seen.count++;
		if (_params.schemaPath.includes(schema)) seen.cycle = _params.path;
		return seen.schema;
	}
	const result = {
		schema: {},
		count: 1,
		cycle: void 0,
		path: _params.path
	};
	ctx.seen.set(schema, result);
	const overrideSchema = schema._zod.toJSONSchema?.();
	if (overrideSchema) result.schema = overrideSchema;
	else {
		const params = {
			..._params,
			schemaPath: [..._params.schemaPath, schema],
			path: _params.path
		};
		if (schema._zod.processJSONSchema) schema._zod.processJSONSchema(ctx, result.schema, params);
		else {
			const _json = result.schema;
			const processor = ctx.processors[def.type];
			if (!processor) throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
			processor(schema, ctx, _json, params);
		}
		const parent = schema._zod.parent;
		if (parent) {
			if (!result.ref) result.ref = parent;
			process$1(parent, ctx, params);
			ctx.seen.get(parent).isParent = true;
		}
	}
	const meta = ctx.metadataRegistry.get(schema);
	if (meta) Object.assign(result.schema, meta);
	if (ctx.io === "input" && isTransforming(schema)) {
		delete result.schema.examples;
		delete result.schema.default;
	}
	if (ctx.io === "input" && result.schema._prefault) (_a = result.schema).default ?? (_a.default = result.schema._prefault);
	delete result.schema._prefault;
	return ctx.seen.get(schema).schema;
}
function extractDefs(ctx, schema) {
	const root = ctx.seen.get(schema);
	if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
	const idToSchema = /* @__PURE__ */ new Map();
	for (const entry of ctx.seen.entries()) {
		const id = ctx.metadataRegistry.get(entry[0])?.id;
		if (id) {
			const existing = idToSchema.get(id);
			if (existing && existing !== entry[0]) throw new Error(`Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
			idToSchema.set(id, entry[0]);
		}
	}
	const makeURI = (entry) => {
		const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
		if (ctx.external) {
			const externalId = ctx.external.registry.get(entry[0])?.id;
			const uriGenerator = ctx.external.uri ?? ((id) => id);
			if (externalId) return { ref: uriGenerator(externalId) };
			const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
			entry[1].defId = id;
			return {
				defId: id,
				ref: `${uriGenerator("__shared")}#/${defsSegment}/${id}`
			};
		}
		if (entry[1] === root) return { ref: "#" };
		const defUriPrefix = `#/${defsSegment}/`;
		const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
		return {
			defId,
			ref: defUriPrefix + defId
		};
	};
	const extractToDef = (entry) => {
		if (entry[1].schema.$ref) return;
		const seen = entry[1];
		const { ref, defId } = makeURI(entry);
		seen.def = { ...seen.schema };
		if (defId) seen.defId = defId;
		const schema = seen.schema;
		for (const key in schema) delete schema[key];
		schema.$ref = ref;
	};
	if (ctx.cycles === "throw") for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (seen.cycle) throw new Error(`Cycle detected: #/${seen.cycle?.join("/")}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`);
	}
	for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (schema === entry[0]) {
			extractToDef(entry);
			continue;
		}
		if (ctx.external) {
			const ext = ctx.external.registry.get(entry[0])?.id;
			if (schema !== entry[0] && ext) {
				extractToDef(entry);
				continue;
			}
		}
		if (ctx.metadataRegistry.get(entry[0])?.id) {
			extractToDef(entry);
			continue;
		}
		if (seen.cycle) {
			extractToDef(entry);
			continue;
		}
		if (seen.count > 1) {
			if (ctx.reused === "ref") {
				extractToDef(entry);
				continue;
			}
		}
	}
}
function finalize(ctx, schema) {
	const root = ctx.seen.get(schema);
	if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
	const flattenRef = (zodSchema) => {
		const seen = ctx.seen.get(zodSchema);
		if (seen.ref === null) return;
		const schema = seen.def ?? seen.schema;
		const _cached = { ...schema };
		const ref = seen.ref;
		seen.ref = null;
		if (ref) {
			flattenRef(ref);
			const refSeen = ctx.seen.get(ref);
			const refSchema = refSeen.schema;
			if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
				schema.allOf = schema.allOf ?? [];
				schema.allOf.push(refSchema);
			} else Object.assign(schema, refSchema);
			Object.assign(schema, _cached);
			if (zodSchema._zod.parent === ref) for (const key in schema) {
				if (key === "$ref" || key === "allOf") continue;
				if (!(key in _cached)) delete schema[key];
			}
			if (refSchema.$ref && refSeen.def) for (const key in schema) {
				if (key === "$ref" || key === "allOf") continue;
				if (key in refSeen.def && JSON.stringify(schema[key]) === JSON.stringify(refSeen.def[key])) delete schema[key];
			}
		}
		const parent = zodSchema._zod.parent;
		if (parent && parent !== ref) {
			flattenRef(parent);
			const parentSeen = ctx.seen.get(parent);
			if (parentSeen?.schema.$ref) {
				schema.$ref = parentSeen.schema.$ref;
				if (parentSeen.def) for (const key in schema) {
					if (key === "$ref" || key === "allOf") continue;
					if (key in parentSeen.def && JSON.stringify(schema[key]) === JSON.stringify(parentSeen.def[key])) delete schema[key];
				}
			}
		}
		ctx.override({
			zodSchema,
			jsonSchema: schema,
			path: seen.path ?? []
		});
	};
	for (const entry of [...ctx.seen.entries()].reverse()) flattenRef(entry[0]);
	const result = {};
	if (ctx.target === "draft-2020-12") result.$schema = "https://json-schema.org/draft/2020-12/schema";
	else if (ctx.target === "draft-07") result.$schema = "http://json-schema.org/draft-07/schema#";
	else if (ctx.target === "draft-04") result.$schema = "http://json-schema.org/draft-04/schema#";
	else if (ctx.target === "openapi-3.0") {}
	if (ctx.external?.uri) {
		const id = ctx.external.registry.get(schema)?.id;
		if (!id) throw new Error("Schema is missing an `id` property");
		result.$id = ctx.external.uri(id);
	}
	Object.assign(result, root.def ?? root.schema);
	const defs = ctx.external?.defs ?? {};
	for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (seen.def && seen.defId) defs[seen.defId] = seen.def;
	}
	if (ctx.external) {} else if (Object.keys(defs).length > 0) {
		if (ctx.target === "draft-2020-12") result.$defs = defs;
		else result.definitions = defs;
	}
	try {
		const finalized = JSON.parse(JSON.stringify(result));
		Object.defineProperty(finalized, "~standard", {
			value: {
				...schema["~standard"],
				jsonSchema: {
					input: createStandardJSONSchemaMethod(schema, "input", ctx.processors),
					output: createStandardJSONSchemaMethod(schema, "output", ctx.processors)
				}
			},
			enumerable: false,
			writable: false
		});
		return finalized;
	} catch (_err) {
		throw new Error("Error converting schema to JSON.");
	}
}
function isTransforming(_schema, _ctx) {
	const ctx = _ctx ?? { seen: /* @__PURE__ */ new Set() };
	if (ctx.seen.has(_schema)) return false;
	ctx.seen.add(_schema);
	const def = _schema._zod.def;
	if (def.type === "transform") return true;
	if (def.type === "array") return isTransforming(def.element, ctx);
	if (def.type === "set") return isTransforming(def.valueType, ctx);
	if (def.type === "lazy") return isTransforming(def.getter(), ctx);
	if (def.type === "promise" || def.type === "optional" || def.type === "nonoptional" || def.type === "nullable" || def.type === "readonly" || def.type === "default" || def.type === "prefault") return isTransforming(def.innerType, ctx);
	if (def.type === "intersection") return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
	if (def.type === "record" || def.type === "map") return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
	if (def.type === "pipe") return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
	if (def.type === "object") {
		for (const key in def.shape) if (isTransforming(def.shape[key], ctx)) return true;
		return false;
	}
	if (def.type === "union") {
		for (const option of def.options) if (isTransforming(option, ctx)) return true;
		return false;
	}
	if (def.type === "tuple") {
		for (const item of def.items) if (isTransforming(item, ctx)) return true;
		if (def.rest && isTransforming(def.rest, ctx)) return true;
		return false;
	}
	return false;
}
/**
* Creates a toJSONSchema method for a schema instance.
* This encapsulates the logic of initializing context, processing, extracting defs, and finalizing.
*/
const createToJSONSchemaMethod = (schema, processors = {}) => (params) => {
	const ctx = initializeContext({
		...params,
		processors
	});
	process$1(schema, ctx);
	extractDefs(ctx, schema);
	return finalize(ctx, schema);
};
const createStandardJSONSchemaMethod = (schema, io, processors = {}) => (params) => {
	const { libraryOptions, target } = params ?? {};
	const ctx = initializeContext({
		...libraryOptions ?? {},
		target,
		io,
		processors
	});
	process$1(schema, ctx);
	extractDefs(ctx, schema);
	return finalize(ctx, schema);
};
// ../../node_modules/zod/v4/core/json-schema-processors.js
const formatMap = {
	guid: "uuid",
	url: "uri",
	datetime: "date-time",
	json_string: "json-string",
	regex: ""
};
const stringProcessor = (schema, ctx, _json, _params) => {
	const json = _json;
	json.type = "string";
	const { minimum, maximum, format, patterns, contentEncoding } = schema._zod.bag;
	if (typeof minimum === "number") json.minLength = minimum;
	if (typeof maximum === "number") json.maxLength = maximum;
	if (format) {
		json.format = formatMap[format] ?? format;
		if (json.format === "") delete json.format;
		if (format === "time") delete json.format;
	}
	if (contentEncoding) json.contentEncoding = contentEncoding;
	if (patterns && patterns.size > 0) {
		const regexes = [...patterns];
		if (regexes.length === 1) json.pattern = regexes[0].source;
		else if (regexes.length > 1) json.allOf = [...regexes.map((regex) => ({
			...ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0" ? { type: "string" } : {},
			pattern: regex.source
		}))];
	}
};
const numberProcessor = (schema, ctx, _json, _params) => {
	const json = _json;
	const { minimum, maximum, format, multipleOf, exclusiveMaximum, exclusiveMinimum } = schema._zod.bag;
	if (typeof format === "string" && format.includes("int")) json.type = "integer";
	else json.type = "number";
	if (typeof exclusiveMinimum === "number") {
		if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") {
			json.minimum = exclusiveMinimum;
			json.exclusiveMinimum = true;
		} else json.exclusiveMinimum = exclusiveMinimum;
	}
	if (typeof minimum === "number") {
		json.minimum = minimum;
		if (typeof exclusiveMinimum === "number" && ctx.target !== "draft-04") {
			if (exclusiveMinimum >= minimum) delete json.minimum;
			else delete json.exclusiveMinimum;
		}
	}
	if (typeof exclusiveMaximum === "number") {
		if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") {
			json.maximum = exclusiveMaximum;
			json.exclusiveMaximum = true;
		} else json.exclusiveMaximum = exclusiveMaximum;
	}
	if (typeof maximum === "number") {
		json.maximum = maximum;
		if (typeof exclusiveMaximum === "number" && ctx.target !== "draft-04") {
			if (exclusiveMaximum <= maximum) delete json.maximum;
			else delete json.exclusiveMaximum;
		}
	}
	if (typeof multipleOf === "number") json.multipleOf = multipleOf;
};
const booleanProcessor = (_schema, _ctx, json, _params) => {
	json.type = "boolean";
};
const neverProcessor = (_schema, _ctx, json, _params) => {
	json.not = {};
};
const enumProcessor = (schema, _ctx, json, _params) => {
	const def = schema._zod.def;
	const values = getEnumValues(def.entries);
	if (values.every((v) => typeof v === "number")) json.type = "number";
	if (values.every((v) => typeof v === "string")) json.type = "string";
	json.enum = values;
};
const literalProcessor = (schema, ctx, json, _params) => {
	const def = schema._zod.def;
	const vals = [];
	for (const val of def.values) if (val === void 0) {
		if (ctx.unrepresentable === "throw") throw new Error("Literal `undefined` cannot be represented in JSON Schema");
	} else if (typeof val === "bigint") {
		if (ctx.unrepresentable === "throw") throw new Error("BigInt literals cannot be represented in JSON Schema");
		else vals.push(Number(val));
	} else vals.push(val);
	if (vals.length === 0) {} else if (vals.length === 1) {
		const val = vals[0];
		json.type = val === null ? "null" : typeof val;
		if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") json.enum = [val];
		else json.const = val;
	} else {
		if (vals.every((v) => typeof v === "number")) json.type = "number";
		if (vals.every((v) => typeof v === "string")) json.type = "string";
		if (vals.every((v) => typeof v === "boolean")) json.type = "boolean";
		if (vals.every((v) => v === null)) json.type = "null";
		json.enum = vals;
	}
};
const customProcessor = (_schema, ctx, _json, _params) => {
	if (ctx.unrepresentable === "throw") throw new Error("Custom types cannot be represented in JSON Schema");
};
const transformProcessor = (_schema, ctx, _json, _params) => {
	if (ctx.unrepresentable === "throw") throw new Error("Transforms cannot be represented in JSON Schema");
};
const arrayProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	const { minimum, maximum } = schema._zod.bag;
	if (typeof minimum === "number") json.minItems = minimum;
	if (typeof maximum === "number") json.maxItems = maximum;
	json.type = "array";
	json.items = process$1(def.element, ctx, {
		...params,
		path: [...params.path, "items"]
	});
};
const objectProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	json.type = "object";
	json.properties = {};
	const shape = def.shape;
	for (const key in shape) json.properties[key] = process$1(shape[key], ctx, {
		...params,
		path: [
			...params.path,
			"properties",
			key
		]
	});
	const allKeys = new Set(Object.keys(shape));
	const requiredKeys = new Set([...allKeys].filter((key) => {
		const v = def.shape[key]._zod;
		if (ctx.io === "input") return v.optin === void 0;
		else return v.optout === void 0;
	}));
	if (requiredKeys.size > 0) json.required = Array.from(requiredKeys);
	if (def.catchall?._zod.def.type === "never") json.additionalProperties = false;
	else if (!def.catchall) {
		if (ctx.io === "output") json.additionalProperties = false;
	} else if (def.catchall) json.additionalProperties = process$1(def.catchall, ctx, {
		...params,
		path: [...params.path, "additionalProperties"]
	});
};
const unionProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const isExclusive = def.inclusive === false;
	const options = def.options.map((x, i) => process$1(x, ctx, {
		...params,
		path: [
			...params.path,
			isExclusive ? "oneOf" : "anyOf",
			i
		]
	}));
	if (isExclusive) json.oneOf = options;
	else json.anyOf = options;
};
const intersectionProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const a = process$1(def.left, ctx, {
		...params,
		path: [
			...params.path,
			"allOf",
			0
		]
	});
	const b = process$1(def.right, ctx, {
		...params,
		path: [
			...params.path,
			"allOf",
			1
		]
	});
	const isSimpleIntersection = (val) => "allOf" in val && Object.keys(val).length === 1;
	json.allOf = [...isSimpleIntersection(a) ? a.allOf : [a], ...isSimpleIntersection(b) ? b.allOf : [b]];
};
const recordProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	json.type = "object";
	const keyType = def.keyType;
	const patterns = keyType._zod.bag?.patterns;
	if (def.mode === "loose" && patterns && patterns.size > 0) {
		const valueSchema = process$1(def.valueType, ctx, {
			...params,
			path: [
				...params.path,
				"patternProperties",
				"*"
			]
		});
		json.patternProperties = {};
		for (const pattern of patterns) json.patternProperties[pattern.source] = valueSchema;
	} else {
		if (ctx.target === "draft-07" || ctx.target === "draft-2020-12") json.propertyNames = process$1(def.keyType, ctx, {
			...params,
			path: [...params.path, "propertyNames"]
		});
		json.additionalProperties = process$1(def.valueType, ctx, {
			...params,
			path: [...params.path, "additionalProperties"]
		});
	}
	const keyValues = keyType._zod.values;
	if (keyValues) {
		const validKeyValues = [...keyValues].filter((v) => typeof v === "string" || typeof v === "number");
		if (validKeyValues.length > 0) json.required = validKeyValues;
	}
};
const nullableProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const inner = process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	if (ctx.target === "openapi-3.0") {
		seen.ref = def.innerType;
		json.nullable = true;
	} else json.anyOf = [inner, { type: "null" }];
};
const nonoptionalProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
};
const defaultProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	json.default = JSON.parse(JSON.stringify(def.defaultValue));
};
const prefaultProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	if (ctx.io === "input") json._prefault = JSON.parse(JSON.stringify(def.defaultValue));
};
const catchProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	let catchValue;
	try {
		catchValue = def.catchValue(void 0);
	} catch {
		throw new Error("Dynamic catch values are not supported in JSON Schema");
	}
	json.default = catchValue;
};
const pipeProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	const innerType = ctx.io === "input" ? def.in._zod.def.type === "transform" ? def.out : def.in : def.out;
	process$1(innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = innerType;
};
const readonlyProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	json.readOnly = true;
};
const optionalProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
};
// ../../node_modules/zod/v4/classic/iso.js
const ZodISODateTime = /*@__PURE__*/ $constructor("ZodISODateTime", (inst, def) => {
	$ZodISODateTime.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function datetime(params) {
	return /* @__PURE__ */ _isoDateTime(ZodISODateTime, params);
}
const ZodISODate = /*@__PURE__*/ $constructor("ZodISODate", (inst, def) => {
	$ZodISODate.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function date(params) {
	return /* @__PURE__ */ _isoDate(ZodISODate, params);
}
const ZodISOTime = /*@__PURE__*/ $constructor("ZodISOTime", (inst, def) => {
	$ZodISOTime.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function time(params) {
	return /* @__PURE__ */ _isoTime(ZodISOTime, params);
}
const ZodISODuration = /*@__PURE__*/ $constructor("ZodISODuration", (inst, def) => {
	$ZodISODuration.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function duration(params) {
	return /* @__PURE__ */ _isoDuration(ZodISODuration, params);
}
// ../../node_modules/zod/v4/classic/errors.js
const initializer = (inst, issues) => {
	$ZodError.init(inst, issues);
	inst.name = "ZodError";
	Object.defineProperties(inst, {
		format: { value: (mapper) => formatError(inst, mapper) },
		flatten: { value: (mapper) => flattenError(inst, mapper) },
		addIssue: { value: (issue) => {
			inst.issues.push(issue);
			inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
		} },
		addIssues: { value: (issues) => {
			inst.issues.push(...issues);
			inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
		} },
		isEmpty: { get() {
			return inst.issues.length === 0;
		} }
	});
};
const ZodRealError = /* @__PURE__ */ $constructor("ZodError", initializer, { Parent: Error });
// ../../node_modules/zod/v4/classic/parse.js
const parse = /* @__PURE__ */ _parse(ZodRealError);
const parseAsync = /* @__PURE__ */ _parseAsync(ZodRealError);
const safeParse = /* @__PURE__ */ _safeParse(ZodRealError);
const safeParseAsync = /* @__PURE__ */ _safeParseAsync(ZodRealError);
const encode = /* @__PURE__ */ _encode(ZodRealError);
const decode = /* @__PURE__ */ _decode(ZodRealError);
const encodeAsync = /* @__PURE__ */ _encodeAsync(ZodRealError);
const decodeAsync = /* @__PURE__ */ _decodeAsync(ZodRealError);
const safeEncode = /* @__PURE__ */ _safeEncode(ZodRealError);
const safeDecode = /* @__PURE__ */ _safeDecode(ZodRealError);
const safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
const safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);
// ../../node_modules/zod/v4/classic/schemas.js
const ZodType = /*@__PURE__*/ $constructor("ZodType", (inst, def) => {
	$ZodType.init(inst, def);
	Object.assign(inst["~standard"], { jsonSchema: {
		input: createStandardJSONSchemaMethod(inst, "input"),
		output: createStandardJSONSchemaMethod(inst, "output")
	} });
	inst.toJSONSchema = createToJSONSchemaMethod(inst, {});
	inst.def = def;
	inst.type = def.type;
	Object.defineProperty(inst, "_def", { value: def });
	inst.check = (...checks) => {
		return inst.clone(mergeDefs(def, { checks: [...def.checks ?? [], ...checks.map((ch) => typeof ch === "function" ? { _zod: {
			check: ch,
			def: { check: "custom" },
			onattach: []
		} } : ch)] }), { parent: true });
	};
	inst.with = inst.check;
	inst.clone = (def, params) => clone(inst, def, params);
	inst.brand = () => inst;
	inst.register = ((reg, meta) => {
		reg.add(inst, meta);
		return inst;
	});
	inst.parse = (data, params) => parse(inst, data, params, { callee: inst.parse });
	inst.safeParse = (data, params) => safeParse(inst, data, params);
	inst.parseAsync = async (data, params) => parseAsync(inst, data, params, { callee: inst.parseAsync });
	inst.safeParseAsync = async (data, params) => safeParseAsync(inst, data, params);
	inst.spa = inst.safeParseAsync;
	inst.encode = (data, params) => encode(inst, data, params);
	inst.decode = (data, params) => decode(inst, data, params);
	inst.encodeAsync = async (data, params) => encodeAsync(inst, data, params);
	inst.decodeAsync = async (data, params) => decodeAsync(inst, data, params);
	inst.safeEncode = (data, params) => safeEncode(inst, data, params);
	inst.safeDecode = (data, params) => safeDecode(inst, data, params);
	inst.safeEncodeAsync = async (data, params) => safeEncodeAsync(inst, data, params);
	inst.safeDecodeAsync = async (data, params) => safeDecodeAsync(inst, data, params);
	inst.refine = (check, params) => inst.check(refine(check, params));
	inst.superRefine = (refinement) => inst.check(superRefine(refinement));
	inst.overwrite = (fn) => inst.check(/* @__PURE__ */ _overwrite(fn));
	inst.optional = () => optional(inst);
	inst.exactOptional = () => exactOptional(inst);
	inst.nullable = () => nullable(inst);
	inst.nullish = () => optional(nullable(inst));
	inst.nonoptional = (params) => nonoptional(inst, params);
	inst.array = () => array(inst);
	inst.or = (arg) => union([inst, arg]);
	inst.and = (arg) => intersection(inst, arg);
	inst.transform = (tx) => pipe(inst, transform(tx));
	inst.default = (def) => _default(inst, def);
	inst.prefault = (def) => prefault(inst, def);
	inst.catch = (params) => _catch(inst, params);
	inst.pipe = (target) => pipe(inst, target);
	inst.readonly = () => readonly(inst);
	inst.describe = (description) => {
		const cl = inst.clone();
		globalRegistry.add(cl, { description });
		return cl;
	};
	Object.defineProperty(inst, "description", {
		get() {
			return globalRegistry.get(inst)?.description;
		},
		configurable: true
	});
	inst.meta = (...args) => {
		if (args.length === 0) return globalRegistry.get(inst);
		const cl = inst.clone();
		globalRegistry.add(cl, args[0]);
		return cl;
	};
	inst.isOptional = () => inst.safeParse(void 0).success;
	inst.isNullable = () => inst.safeParse(null).success;
	inst.apply = (fn) => fn(inst);
	return inst;
});
/** @internal */
const _ZodString = /*@__PURE__*/ $constructor("_ZodString", (inst, def) => {
	$ZodString.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => stringProcessor(inst, ctx, json, params);
	const bag = inst._zod.bag;
	inst.format = bag.format ?? null;
	inst.minLength = bag.minimum ?? null;
	inst.maxLength = bag.maximum ?? null;
	inst.regex = (...args) => inst.check(/* @__PURE__ */ _regex(...args));
	inst.includes = (...args) => inst.check(/* @__PURE__ */ _includes(...args));
	inst.startsWith = (...args) => inst.check(/* @__PURE__ */ _startsWith(...args));
	inst.endsWith = (...args) => inst.check(/* @__PURE__ */ _endsWith(...args));
	inst.min = (...args) => inst.check(/* @__PURE__ */ _minLength(...args));
	inst.max = (...args) => inst.check(/* @__PURE__ */ _maxLength(...args));
	inst.length = (...args) => inst.check(/* @__PURE__ */ _length(...args));
	inst.nonempty = (...args) => inst.check(/* @__PURE__ */ _minLength(1, ...args));
	inst.lowercase = (params) => inst.check(/* @__PURE__ */ _lowercase(params));
	inst.uppercase = (params) => inst.check(/* @__PURE__ */ _uppercase(params));
	inst.trim = () => inst.check(/* @__PURE__ */ _trim());
	inst.normalize = (...args) => inst.check(/* @__PURE__ */ _normalize(...args));
	inst.toLowerCase = () => inst.check(/* @__PURE__ */ _toLowerCase());
	inst.toUpperCase = () => inst.check(/* @__PURE__ */ _toUpperCase());
	inst.slugify = () => inst.check(/* @__PURE__ */ _slugify());
});
const ZodString = /*@__PURE__*/ $constructor("ZodString", (inst, def) => {
	$ZodString.init(inst, def);
	_ZodString.init(inst, def);
	inst.email = (params) => inst.check(/* @__PURE__ */ _email(ZodEmail, params));
	inst.url = (params) => inst.check(/* @__PURE__ */ _url(ZodURL, params));
	inst.jwt = (params) => inst.check(/* @__PURE__ */ _jwt(ZodJWT, params));
	inst.emoji = (params) => inst.check(/* @__PURE__ */ _emoji(ZodEmoji, params));
	inst.guid = (params) => inst.check(/* @__PURE__ */ _guid(ZodGUID, params));
	inst.uuid = (params) => inst.check(/* @__PURE__ */ _uuid(ZodUUID, params));
	inst.uuidv4 = (params) => inst.check(/* @__PURE__ */ _uuidv4(ZodUUID, params));
	inst.uuidv6 = (params) => inst.check(/* @__PURE__ */ _uuidv6(ZodUUID, params));
	inst.uuidv7 = (params) => inst.check(/* @__PURE__ */ _uuidv7(ZodUUID, params));
	inst.nanoid = (params) => inst.check(/* @__PURE__ */ _nanoid(ZodNanoID, params));
	inst.guid = (params) => inst.check(/* @__PURE__ */ _guid(ZodGUID, params));
	inst.cuid = (params) => inst.check(/* @__PURE__ */ _cuid(ZodCUID, params));
	inst.cuid2 = (params) => inst.check(/* @__PURE__ */ _cuid2(ZodCUID2, params));
	inst.ulid = (params) => inst.check(/* @__PURE__ */ _ulid(ZodULID, params));
	inst.base64 = (params) => inst.check(/* @__PURE__ */ _base64(ZodBase64, params));
	inst.base64url = (params) => inst.check(/* @__PURE__ */ _base64url(ZodBase64URL, params));
	inst.xid = (params) => inst.check(/* @__PURE__ */ _xid(ZodXID, params));
	inst.ksuid = (params) => inst.check(/* @__PURE__ */ _ksuid(ZodKSUID, params));
	inst.ipv4 = (params) => inst.check(/* @__PURE__ */ _ipv4(ZodIPv4, params));
	inst.ipv6 = (params) => inst.check(/* @__PURE__ */ _ipv6(ZodIPv6, params));
	inst.cidrv4 = (params) => inst.check(/* @__PURE__ */ _cidrv4(ZodCIDRv4, params));
	inst.cidrv6 = (params) => inst.check(/* @__PURE__ */ _cidrv6(ZodCIDRv6, params));
	inst.e164 = (params) => inst.check(/* @__PURE__ */ _e164(ZodE164, params));
	inst.datetime = (params) => inst.check(datetime(params));
	inst.date = (params) => inst.check(date(params));
	inst.time = (params) => inst.check(time(params));
	inst.duration = (params) => inst.check(duration(params));
});
function string(params) {
	return /* @__PURE__ */ _string(ZodString, params);
}
const ZodStringFormat = /*@__PURE__*/ $constructor("ZodStringFormat", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	_ZodString.init(inst, def);
});
const ZodEmail = /*@__PURE__*/ $constructor("ZodEmail", (inst, def) => {
	$ZodEmail.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodGUID = /*@__PURE__*/ $constructor("ZodGUID", (inst, def) => {
	$ZodGUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodUUID = /*@__PURE__*/ $constructor("ZodUUID", (inst, def) => {
	$ZodUUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodURL = /*@__PURE__*/ $constructor("ZodURL", (inst, def) => {
	$ZodURL.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodEmoji = /*@__PURE__*/ $constructor("ZodEmoji", (inst, def) => {
	$ZodEmoji.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodNanoID = /*@__PURE__*/ $constructor("ZodNanoID", (inst, def) => {
	$ZodNanoID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodCUID = /*@__PURE__*/ $constructor("ZodCUID", (inst, def) => {
	$ZodCUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodCUID2 = /*@__PURE__*/ $constructor("ZodCUID2", (inst, def) => {
	$ZodCUID2.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodULID = /*@__PURE__*/ $constructor("ZodULID", (inst, def) => {
	$ZodULID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodXID = /*@__PURE__*/ $constructor("ZodXID", (inst, def) => {
	$ZodXID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodKSUID = /*@__PURE__*/ $constructor("ZodKSUID", (inst, def) => {
	$ZodKSUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodIPv4 = /*@__PURE__*/ $constructor("ZodIPv4", (inst, def) => {
	$ZodIPv4.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodIPv6 = /*@__PURE__*/ $constructor("ZodIPv6", (inst, def) => {
	$ZodIPv6.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodCIDRv4 = /*@__PURE__*/ $constructor("ZodCIDRv4", (inst, def) => {
	$ZodCIDRv4.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodCIDRv6 = /*@__PURE__*/ $constructor("ZodCIDRv6", (inst, def) => {
	$ZodCIDRv6.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodBase64 = /*@__PURE__*/ $constructor("ZodBase64", (inst, def) => {
	$ZodBase64.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodBase64URL = /*@__PURE__*/ $constructor("ZodBase64URL", (inst, def) => {
	$ZodBase64URL.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodE164 = /*@__PURE__*/ $constructor("ZodE164", (inst, def) => {
	$ZodE164.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodJWT = /*@__PURE__*/ $constructor("ZodJWT", (inst, def) => {
	$ZodJWT.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodNumber = /*@__PURE__*/ $constructor("ZodNumber", (inst, def) => {
	$ZodNumber.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => numberProcessor(inst, ctx, json, params);
	inst.gt = (value, params) => inst.check(/* @__PURE__ */ _gt(value, params));
	inst.gte = (value, params) => inst.check(/* @__PURE__ */ _gte(value, params));
	inst.min = (value, params) => inst.check(/* @__PURE__ */ _gte(value, params));
	inst.lt = (value, params) => inst.check(/* @__PURE__ */ _lt(value, params));
	inst.lte = (value, params) => inst.check(/* @__PURE__ */ _lte(value, params));
	inst.max = (value, params) => inst.check(/* @__PURE__ */ _lte(value, params));
	inst.int = (params) => inst.check(int(params));
	inst.safe = (params) => inst.check(int(params));
	inst.positive = (params) => inst.check(/* @__PURE__ */ _gt(0, params));
	inst.nonnegative = (params) => inst.check(/* @__PURE__ */ _gte(0, params));
	inst.negative = (params) => inst.check(/* @__PURE__ */ _lt(0, params));
	inst.nonpositive = (params) => inst.check(/* @__PURE__ */ _lte(0, params));
	inst.multipleOf = (value, params) => inst.check(/* @__PURE__ */ _multipleOf(value, params));
	inst.step = (value, params) => inst.check(/* @__PURE__ */ _multipleOf(value, params));
	inst.finite = () => inst;
	const bag = inst._zod.bag;
	inst.minValue = Math.max(bag.minimum ?? Number.NEGATIVE_INFINITY, bag.exclusiveMinimum ?? Number.NEGATIVE_INFINITY) ?? null;
	inst.maxValue = Math.min(bag.maximum ?? Number.POSITIVE_INFINITY, bag.exclusiveMaximum ?? Number.POSITIVE_INFINITY) ?? null;
	inst.isInt = (bag.format ?? "").includes("int") || Number.isSafeInteger(bag.multipleOf ?? .5);
	inst.isFinite = true;
	inst.format = bag.format ?? null;
});
function number(params) {
	return /* @__PURE__ */ _number(ZodNumber, params);
}
const ZodNumberFormat = /*@__PURE__*/ $constructor("ZodNumberFormat", (inst, def) => {
	$ZodNumberFormat.init(inst, def);
	ZodNumber.init(inst, def);
});
function int(params) {
	return /* @__PURE__ */ _int(ZodNumberFormat, params);
}
const ZodBoolean = /*@__PURE__*/ $constructor("ZodBoolean", (inst, def) => {
	$ZodBoolean.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => booleanProcessor(inst, ctx, json, params);
});
function boolean(params) {
	return /* @__PURE__ */ _boolean(ZodBoolean, params);
}
const ZodUnknown = /*@__PURE__*/ $constructor("ZodUnknown", (inst, def) => {
	$ZodUnknown.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => void 0;
});
function unknown() {
	return /* @__PURE__ */ _unknown(ZodUnknown);
}
const ZodNever = /*@__PURE__*/ $constructor("ZodNever", (inst, def) => {
	$ZodNever.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => neverProcessor(inst, ctx, json, params);
});
function never(params) {
	return /* @__PURE__ */ _never(ZodNever, params);
}
const ZodArray = /*@__PURE__*/ $constructor("ZodArray", (inst, def) => {
	$ZodArray.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => arrayProcessor(inst, ctx, json, params);
	inst.element = def.element;
	inst.min = (minLength, params) => inst.check(/* @__PURE__ */ _minLength(minLength, params));
	inst.nonempty = (params) => inst.check(/* @__PURE__ */ _minLength(1, params));
	inst.max = (maxLength, params) => inst.check(/* @__PURE__ */ _maxLength(maxLength, params));
	inst.length = (len, params) => inst.check(/* @__PURE__ */ _length(len, params));
	inst.unwrap = () => inst.element;
});
function array(element, params) {
	return /* @__PURE__ */ _array(ZodArray, element, params);
}
const ZodObject = /*@__PURE__*/ $constructor("ZodObject", (inst, def) => {
	$ZodObjectJIT.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => objectProcessor(inst, ctx, json, params);
	defineLazy(inst, "shape", () => {
		return def.shape;
	});
	inst.keyof = () => _enum(Object.keys(inst._zod.def.shape));
	inst.catchall = (catchall) => inst.clone({
		...inst._zod.def,
		catchall
	});
	inst.passthrough = () => inst.clone({
		...inst._zod.def,
		catchall: unknown()
	});
	inst.loose = () => inst.clone({
		...inst._zod.def,
		catchall: unknown()
	});
	inst.strict = () => inst.clone({
		...inst._zod.def,
		catchall: never()
	});
	inst.strip = () => inst.clone({
		...inst._zod.def,
		catchall: void 0
	});
	inst.extend = (incoming) => {
		return extend(inst, incoming);
	};
	inst.safeExtend = (incoming) => {
		return safeExtend(inst, incoming);
	};
	inst.merge = (other) => merge(inst, other);
	inst.pick = (mask) => pick(inst, mask);
	inst.omit = (mask) => omit(inst, mask);
	inst.partial = (...args) => partial(ZodOptional, inst, args[0]);
	inst.required = (...args) => required(ZodNonOptional, inst, args[0]);
});
function object(shape, params) {
	const def = {
		type: "object",
		shape: shape ?? {},
		...normalizeParams(params)
	};
	return new ZodObject(def);
}
const ZodUnion = /*@__PURE__*/ $constructor("ZodUnion", (inst, def) => {
	$ZodUnion.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => unionProcessor(inst, ctx, json, params);
	inst.options = def.options;
});
function union(options, params) {
	return new ZodUnion({
		type: "union",
		options,
		...normalizeParams(params)
	});
}
const ZodDiscriminatedUnion = /*@__PURE__*/ $constructor("ZodDiscriminatedUnion", (inst, def) => {
	ZodUnion.init(inst, def);
	$ZodDiscriminatedUnion.init(inst, def);
});
function discriminatedUnion(discriminator, options, params) {
	return new ZodDiscriminatedUnion({
		type: "union",
		options,
		discriminator,
		...normalizeParams(params)
	});
}
const ZodIntersection = /*@__PURE__*/ $constructor("ZodIntersection", (inst, def) => {
	$ZodIntersection.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => intersectionProcessor(inst, ctx, json, params);
});
function intersection(left, right) {
	return new ZodIntersection({
		type: "intersection",
		left,
		right
	});
}
const ZodRecord = /*@__PURE__*/ $constructor("ZodRecord", (inst, def) => {
	$ZodRecord.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => recordProcessor(inst, ctx, json, params);
	inst.keyType = def.keyType;
	inst.valueType = def.valueType;
});
function record(keyType, valueType, params) {
	return new ZodRecord({
		type: "record",
		keyType,
		valueType,
		...normalizeParams(params)
	});
}
const ZodEnum = /*@__PURE__*/ $constructor("ZodEnum", (inst, def) => {
	$ZodEnum.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => enumProcessor(inst, ctx, json, params);
	inst.enum = def.entries;
	inst.options = Object.values(def.entries);
	const keys = new Set(Object.keys(def.entries));
	inst.extract = (values, params) => {
		const newEntries = {};
		for (const value of values) if (keys.has(value)) newEntries[value] = def.entries[value];
		else throw new Error(`Key ${value} not found in enum`);
		return new ZodEnum({
			...def,
			checks: [],
			...normalizeParams(params),
			entries: newEntries
		});
	};
	inst.exclude = (values, params) => {
		const newEntries = { ...def.entries };
		for (const value of values) if (keys.has(value)) delete newEntries[value];
		else throw new Error(`Key ${value} not found in enum`);
		return new ZodEnum({
			...def,
			checks: [],
			...normalizeParams(params),
			entries: newEntries
		});
	};
});
function _enum(values, params) {
	const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
	return new ZodEnum({
		type: "enum",
		entries,
		...normalizeParams(params)
	});
}
const ZodLiteral = /*@__PURE__*/ $constructor("ZodLiteral", (inst, def) => {
	$ZodLiteral.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => literalProcessor(inst, ctx, json, params);
	inst.values = new Set(def.values);
	Object.defineProperty(inst, "value", { get() {
		if (def.values.length > 1) throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
		return def.values[0];
	} });
});
function literal(value, params) {
	return new ZodLiteral({
		type: "literal",
		values: Array.isArray(value) ? value : [value],
		...normalizeParams(params)
	});
}
const ZodTransform = /*@__PURE__*/ $constructor("ZodTransform", (inst, def) => {
	$ZodTransform.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => transformProcessor(inst, ctx, json, params);
	inst._zod.parse = (payload, _ctx) => {
		if (_ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
		payload.addIssue = (issue$1) => {
			if (typeof issue$1 === "string") payload.issues.push(issue(issue$1, payload.value, def));
			else {
				const _issue = issue$1;
				if (_issue.fatal) _issue.continue = false;
				_issue.code ?? (_issue.code = "custom");
				_issue.input ?? (_issue.input = payload.value);
				_issue.inst ?? (_issue.inst = inst);
				payload.issues.push(issue(_issue));
			}
		};
		const output = def.transform(payload.value, payload);
		if (output instanceof Promise) return output.then((output) => {
			payload.value = output;
			return payload;
		});
		payload.value = output;
		return payload;
	};
});
function transform(fn) {
	return new ZodTransform({
		type: "transform",
		transform: fn
	});
}
const ZodOptional = /*@__PURE__*/ $constructor("ZodOptional", (inst, def) => {
	$ZodOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
	return new ZodOptional({
		type: "optional",
		innerType
	});
}
const ZodExactOptional = /*@__PURE__*/ $constructor("ZodExactOptional", (inst, def) => {
	$ZodExactOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function exactOptional(innerType) {
	return new ZodExactOptional({
		type: "optional",
		innerType
	});
}
const ZodNullable = /*@__PURE__*/ $constructor("ZodNullable", (inst, def) => {
	$ZodNullable.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nullableProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
	return new ZodNullable({
		type: "nullable",
		innerType
	});
}
const ZodDefault = /*@__PURE__*/ $constructor("ZodDefault", (inst, def) => {
	$ZodDefault.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => defaultProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
	inst.removeDefault = inst.unwrap;
});
function _default(innerType, defaultValue) {
	return new ZodDefault({
		type: "default",
		innerType,
		get defaultValue() {
			return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
		}
	});
}
const ZodPrefault = /*@__PURE__*/ $constructor("ZodPrefault", (inst, def) => {
	$ZodPrefault.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => prefaultProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
	return new ZodPrefault({
		type: "prefault",
		innerType,
		get defaultValue() {
			return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
		}
	});
}
const ZodNonOptional = /*@__PURE__*/ $constructor("ZodNonOptional", (inst, def) => {
	$ZodNonOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nonoptionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
	return new ZodNonOptional({
		type: "nonoptional",
		innerType,
		...normalizeParams(params)
	});
}
const ZodCatch = /*@__PURE__*/ $constructor("ZodCatch", (inst, def) => {
	$ZodCatch.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => catchProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
	inst.removeCatch = inst.unwrap;
});
function _catch(innerType, catchValue) {
	return new ZodCatch({
		type: "catch",
		innerType,
		catchValue: typeof catchValue === "function" ? catchValue : () => catchValue
	});
}
const ZodPipe = /*@__PURE__*/ $constructor("ZodPipe", (inst, def) => {
	$ZodPipe.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => pipeProcessor(inst, ctx, json, params);
	inst.in = def.in;
	inst.out = def.out;
});
function pipe(in_, out) {
	return new ZodPipe({
		type: "pipe",
		in: in_,
		out
	});
}
const ZodReadonly = /*@__PURE__*/ $constructor("ZodReadonly", (inst, def) => {
	$ZodReadonly.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => readonlyProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
	return new ZodReadonly({
		type: "readonly",
		innerType
	});
}
const ZodCustom = /*@__PURE__*/ $constructor("ZodCustom", (inst, def) => {
	$ZodCustom.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => customProcessor(inst, ctx, json, params);
});
function refine(fn, _params = {}) {
	return /* @__PURE__ */ _refine(ZodCustom, fn, _params);
}
function superRefine(fn) {
	return /* @__PURE__ */ _superRefine(fn);
}
// ../../packages/transcript/src/contract/schema.ts
const turnIdSchema = string().min(1);
const stepIdSchema = string().min(1);
const frameIdSchema = string().min(1);
const taskIdSchema = string().min(1);
const agentIdSchema = string().min(1);
const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
function isPlainAgentId(agentId) {
	return AGENT_ID_PATTERN.test(agentId) && agentId !== "." && agentId !== "..";
}
const turnOriginSchema = discriminatedUnion("kind", [
	object({
		kind: literal("user"),
		payload: unknown().optional()
	}),
	object({
		kind: literal("cron"),
		taskId: taskIdSchema.optional(),
		payload: unknown().optional()
	}),
	object({
		kind: literal("task"),
		taskId: taskIdSchema,
		payload: unknown().optional()
	}),
	object({
		kind: literal("hook"),
		payload: unknown().optional()
	}),
	object({
		kind: literal("compaction"),
		payload: unknown().optional()
	}),
	object({
		kind: literal("side"),
		payload: unknown().optional()
	}),
	object({
		kind: literal("other"),
		payload: unknown().optional()
	})
]);
const transcriptUsageSchema = object({
	inputTokens: number().optional(),
	outputTokens: number().optional(),
	cachedTokens: number().optional(),
	cost: number().optional()
});
const stepUsageSchema = object({
	inputOther: number(),
	output: number(),
	inputCacheRead: number(),
	inputCacheCreation: number()
});
const stepTimingSchema = object({
	llmFirstTokenLatencyMs: number().optional(),
	llmStreamDurationMs: number().optional(),
	llmRequestBuildMs: number().optional(),
	llmServerFirstTokenMs: number().optional(),
	llmServerDecodeMs: number().optional(),
	llmClientConsumeMs: number().optional(),
	llmClientBlockedMs: number().optional(),
	llmFirstTokenOffsetMs: number().optional(),
	llmLastTokenOffsetMs: number().optional(),
	llmWindowOnFrameClock: boolean().optional()
});
const stepRetrySchema = object({
	failedAttempt: number(),
	nextAttempt: number(),
	maxAttempts: number(),
	delayMs: number(),
	errorName: string(),
	errorMessage: string(),
	statusCode: number().optional()
});
const turnStateSchema = _enum([
	"queued",
	"running",
	"completed",
	"failed",
	"cancelled"
]);
const stepStateSchema = _enum([
	"running",
	"completed",
	"interrupted",
	"failed"
]);
const transcriptSkillActivationSchema = object({
	skillName: string(),
	skillArgs: string().optional()
});
const transcriptUserOriginSchema = discriminatedUnion("kind", [object({
	kind: literal("user"),
	clientMetadata: array(record(string(), unknown())).optional(),
	skillActivations: array(transcriptSkillActivationSchema).optional()
}), object({
	kind: literal("skill_activation"),
	trigger: literal("user-slash"),
	skillName: string().min(1),
	skillArgs: string().optional(),
	clientMetadata: array(record(string(), unknown())).optional()
})]);
const textFrameShape = {
	kind: literal("text"),
	frameId: frameIdSchema,
	text: string(),
	attachmentIds: array(string()).optional(),
	taskId: taskIdSchema.optional(),
	promptIds: array(string()).optional()
};
const textFrameSchema = discriminatedUnion("role", [object({
	...textFrameShape,
	role: literal("assistant"),
	origin: never().optional()
}), object({
	...textFrameShape,
	role: literal("user"),
	origin: transcriptUserOriginSchema.optional()
})]);
const thinkingFrameSchema = object({
	kind: literal("thinking"),
	frameId: frameIdSchema,
	text: string()
});
const agentRefSchema = object({
	agentId: agentIdSchema,
	role: _enum(["child", "member"]).optional()
});
const toolFrameProgressSchema = object({
	kind: _enum([
		"stdout",
		"stderr",
		"progress",
		"status",
		"custom"
	]),
	text: string().optional(),
	percent: number().optional(),
	customKind: string().optional(),
	customData: unknown().optional()
});
const toolCallFrameSchema = object({
	kind: literal("tool"),
	frameId: frameIdSchema,
	toolCallId: string(),
	name: string(),
	view: string().optional(),
	state: _enum([
		"running",
		"done",
		"error"
	]),
	input: unknown().optional(),
	output: unknown().optional(),
	display: unknown().optional(),
	error: string().optional(),
	inputText: string().optional(),
	progress: toolFrameProgressSchema.optional(),
	taskId: taskIdSchema.optional(),
	approvalId: string().optional(),
	agentRefs: array(agentRefSchema).optional()
});
const interactionSchema = object({
	interactionId: string(),
	interactionKind: _enum(["approval", "question"]),
	toolCallId: string().optional(),
	state: _enum([
		"pending",
		"approved",
		"rejected",
		"cancelled",
		"answered",
		"dismissed"
	]),
	request: unknown().optional(),
	response: unknown().optional()
});
const transcriptFrameSchema = discriminatedUnion("kind", [
	textFrameSchema,
	thinkingFrameSchema,
	toolCallFrameSchema,
	object({
		kind: literal("notice"),
		frameId: frameIdSchema,
		level: _enum([
			"error",
			"warning",
			"info"
		]),
		source: string().optional(),
		message: string(),
		detail: unknown().optional()
	})
]);
const transcriptStepSchema = object({
	kind: literal("step"),
	stepId: stepIdSchema,
	turnId: turnIdSchema,
	ordinal: number().int(),
	state: stepStateSchema,
	frames: array(transcriptFrameSchema),
	startedAt: string().optional(),
	endedAt: string().optional(),
	usage: stepUsageSchema.optional(),
	finishReason: string().optional(),
	llmTiming: stepTimingSchema.optional(),
	retry: stepRetrySchema.optional(),
	endReason: string().optional(),
	endMessage: string().optional()
});
const transcriptTurnSchema = object({
	kind: literal("turn"),
	turnId: turnIdSchema,
	triggerPromptId: string().min(1).optional(),
	ordinal: number().int(),
	state: turnStateSchema,
	origin: turnOriginSchema,
	prompt: string().optional(),
	attachmentIds: array(string()).optional(),
	steps: array(transcriptStepSchema),
	startedAt: string().optional(),
	endedAt: string().optional(),
	usage: transcriptUsageSchema.optional(),
	durationMs: number().optional(),
	error: string().optional(),
	wedged: boolean().optional()
});
const transcriptMarkerSchema = object({
	kind: literal("marker"),
	markerId: string(),
	marker: string(),
	payload: unknown().optional(),
	at: string().optional()
});
const transcriptTaskRefSchema = object({
	kind: literal("taskref"),
	refId: string(),
	taskId: taskIdSchema,
	at: string().optional()
});
const transcriptItemSchema = discriminatedUnion("kind", [
	transcriptTurnSchema,
	transcriptMarkerSchema,
	transcriptTaskRefSchema
]);
const transcriptTaskSchema = object({
	taskId: taskIdSchema,
	kind: _enum([
		"shell",
		"subagent",
		"tool",
		"other"
	]),
	state: _enum([
		"running",
		"completed",
		"failed",
		"timed_out",
		"killed",
		"lost"
	]),
	detached: boolean(),
	description: string().optional(),
	agentId: agentIdSchema.optional(),
	outputTail: string(),
	startedAt: string().optional(),
	endedAt: string().optional(),
	resultSummary: string().optional(),
	error: string().optional(),
	stateReason: string().optional(),
	usage: stepUsageSchema.optional(),
	model: string().optional(),
	thinkingEffort: string().optional()
});
const attachmentSchema = object({
	attachmentId: string(),
	mediaType: string(),
	name: string().optional(),
	size: number().optional(),
	source: discriminatedUnion("kind", [
		object({
			kind: literal("url"),
			url: string()
		}),
		object({
			kind: literal("file"),
			fileId: string()
		}),
		object({
			kind: literal("session_media"),
			fileId: string()
		})
	]).optional(),
	placeholder: string().optional()
});
const transcriptPromptSchema = object({
	promptId: string(),
	status: _enum([
		"running",
		"queued",
		"blocked",
		"completed",
		"failed",
		"aborted"
	]),
	userMessageId: string().optional(),
	content: unknown().optional(),
	clientMetadata: array(record(string(), unknown())).optional(),
	createdAt: string(),
	finishedAt: string().optional(),
	steeredAt: string().optional()
});
const agentTranscriptSnapshotSchema = object({
	items: array(transcriptItemSchema),
	tasks: array(transcriptTaskSchema),
	interactions: array(interactionSchema).default([]),
	attachments: array(attachmentSchema).default([]),
	prompts: array(transcriptPromptSchema).default([]),
	hasMoreOlder: boolean().optional()
});
const turnHeaderSchema = transcriptTurnSchema.omit({ steps: true });
const stepHeaderSchema = transcriptStepSchema.omit({ frames: true });
const appendTargetSchema = discriminatedUnion("type", [object({
	type: literal("frame"),
	turnId: turnIdSchema,
	stepId: stepIdSchema,
	frameId: frameIdSchema
}), object({
	type: literal("task"),
	taskId: taskIdSchema
})]);
const transcriptOperationSchema = discriminatedUnion("op", [
	object({
		op: literal("reset"),
		agentId: agentIdSchema,
		snapshot: agentTranscriptSnapshotSchema
	}),
	object({
		op: literal("turn.upsert"),
		turn: turnHeaderSchema
	}),
	object({
		op: literal("step.upsert"),
		turnId: turnIdSchema,
		step: stepHeaderSchema
	}),
	object({
		op: literal("frame.upsert"),
		turnId: turnIdSchema,
		stepId: stepIdSchema,
		frame: transcriptFrameSchema
	}),
	object({
		op: literal("append"),
		target: appendTargetSchema,
		offset: number().int().nonnegative(),
		text: string()
	}),
	object({
		op: literal("marker.upsert"),
		item: transcriptMarkerSchema,
		beforeTurn: number().int().optional()
	}),
	object({
		op: literal("taskref.upsert"),
		item: transcriptTaskRefSchema,
		beforeTurn: number().int().optional()
	}),
	object({
		op: literal("task.upsert"),
		task: transcriptTaskSchema
	}),
	object({
		op: literal("interaction.upsert"),
		interaction: interactionSchema
	}),
	object({
		op: literal("attachment.upsert"),
		attachment: attachmentSchema
	}),
	object({
		op: literal("prompt.upsert"),
		prompt: transcriptPromptSchema
	}),
	object({
		op: literal("items.remove"),
		ids: array(string())
	})
]);
object({
	agentId: agentIdSchema,
	ops: array(transcriptOperationSchema)
});
const transcriptGradeSchema = _enum([
	"off",
	"turn",
	"block",
	"delta"
]);
const transcriptSeqSchema = number().int().nonnegative();
const transcriptGradeSpecSchema = record(string(), transcriptGradeSchema);
object({
	session_id: string().min(1),
	transcript: transcriptGradeSpecSchema,
	transcript_since: record(string(), transcriptSeqSchema).optional()
});
object({
	agent_id: agentIdSchema,
	before_turn: string().min(1).optional(),
	after_turn: string().min(1).optional(),
	page_size: number().int().min(1).max(100).optional()
}).superRefine((value, ctx) => {
	if (value.before_turn !== void 0 && value.after_turn !== void 0) ctx.addIssue({
		code: "custom",
		message: "before_turn and after_turn are mutually exclusive",
		path: ["before_turn"]
	});
	if (!isPlainAgentId(value.agent_id)) ctx.addIssue({
		code: "custom",
		message: "agent_id must be a plain agent id (no path separators)",
		path: ["agent_id"]
	});
});
const agentDescriptorSchema = object({
	agentId: agentIdSchema,
	type: _enum([
		"main",
		"sub",
		"independent"
	]).optional(),
	parentAgentId: agentIdSchema.optional(),
	label: string().optional(),
	createdAt: string().optional(),
	disposedAt: string().optional()
});
object({
	agent_id: agentIdSchema,
	items: array(transcriptItemSchema),
	has_more: boolean(),
	tasks: array(transcriptTaskSchema),
	interactions: array(interactionSchema).default([]),
	attachments: array(attachmentSchema).default([]),
	prompts: array(transcriptPromptSchema).default([]),
	agents: array(agentDescriptorSchema),
	pending_interactions: array(string()),
	seq: transcriptSeqSchema.optional()
});
object({
	agent_id: agentIdSchema,
	batches: array(object({
		seq: transcriptSeqSchema,
		ops: array(transcriptOperationSchema)
	})),
	latest_seq: transcriptSeqSchema,
	complete: boolean()
});
object({ agents: array(object({
	agent_id: agentIdSchema,
	messages: array(object({
		turn_id: turnIdSchema,
		ordinal: number().int(),
		state: turnStateSchema,
		origin: turnOriginSchema,
		prompt: string(),
		attachment_ids: array(string()).optional(),
		started_at: string().optional()
	})),
	attachments: array(attachmentSchema).default([])
})) });
const transcriptPlanReviewSchema = object({
	state: _enum([
		"pending",
		"approved",
		"rejected",
		"cancelled"
	]),
	selected_option: string().optional(),
	feedback: string().optional()
});
object({
	agent_id: agentIdSchema,
	plans: array(object({
		tool_call_id: string(),
		turn_id: turnIdSchema,
		source: _enum([
			"interaction",
			"display",
			"output"
		]),
		plan: string(),
		path: string().optional(),
		options: array(object({
			label: string(),
			description: string().optional()
		})).optional(),
		review: transcriptPlanReviewSchema.optional()
	}))
});
const transcriptResetPayloadSchema = object({
	agent_id: agentIdSchema,
	snapshot: agentTranscriptSnapshotSchema,
	has_more_older: boolean(),
	seq: transcriptSeqSchema.optional()
});
const transcriptOpsPayloadSchema = object({
	agent_id: agentIdSchema,
	ops: array(transcriptOperationSchema),
	seq: transcriptSeqSchema.optional()
});
discriminatedUnion("type", [transcriptResetPayloadSchema.extend({ type: literal("transcript.reset") }), transcriptOpsPayloadSchema.extend({ type: literal("transcript.ops") })]);
// ../../packages/kap-server/src/search/wireExtract.ts
const NONE = { kind: "none" };
const ENSURE = { kind: "ensure" };
const STEP_NONE = { kind: "none" };
function isUserTypedOrigin(origin) {
	if (origin.kind === "skill_activation" || origin.kind === "plugin_command") return origin.trigger === "user-slash";
	if (typeof origin.kind === "string" && NON_USER_ORIGIN_KINDS.has(origin.kind)) return false;
	return true;
}
function normalizeTimestampMs(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return void 0;
	return value > 0xe8d4a51000 ? Math.floor(value) : Math.floor(value * 1e3);
}
function textOfContent(content) {
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const raw of content) {
		if (raw === null || typeof raw !== "object") continue;
		const part = raw;
		if (part.type !== "text" || typeof part.text !== "string") continue;
		if (matchSingleMediaPathTag(part.text) !== void 0) continue;
		text += part.text;
	}
	return text;
}
function parseWireLine(line) {
	const trimmed = line.trim();
	if (trimmed.length === 0) return void 0;
	let record;
	try {
		record = JSON.parse(trimmed);
	} catch {
		return;
	}
	if (record === null || typeof record !== "object" || Array.isArray(record)) return void 0;
	return record;
}
function turnEffectOfAppendMessage(message) {
	if (message === null || typeof message !== "object") return NONE;
	const m = message;
	if (m.role === "system") return NONE;
	if (m.role === "assistant") return ENSURE;
	if (m.role !== "user") return NONE;
	const origin = m.origin !== null && typeof m.origin === "object" ? m.origin : void 0;
	const originClass = classifyUserOrigin(origin);
	if (originClass === "opening_trigger") return {
		kind: "open",
		anchor: false
	};
	if (originClass === "hidden" || originClass === "marker") return NONE;
	return {
		kind: "open",
		anchor: isUndoAnchorTurnOrigin(origin)
	};
}
function analyzeWireLine(line) {
	const r = parseWireLine(line);
	if (r === void 0) return {
		messages: [],
		turn: NONE,
		step: STEP_NONE
	};
	const time = normalizeTimestampMs(r.time);
	if (r.type === "context.append_message") {
		const turn = turnEffectOfAppendMessage(r.message);
		const message = r.message;
		const messages = [];
		if (message !== null && typeof message === "object") {
			const m = message;
			if (m.role === "user") {
				const origin = m.origin;
				if (origin === null || origin === void 0 || typeof origin === "object" && isUserTypedOrigin(origin)) {
					const text = textOfContent(m.content).trim();
					if (text.length > 0) messages.push({
						role: "user",
						text,
						time
					});
				}
			}
		}
		return {
			messages,
			turn,
			step: STEP_NONE
		};
	}
	if (r.type === "context.append_loop_event") {
		const event = r.event;
		if (event === null || typeof event !== "object") return {
			messages: [],
			turn: NONE,
			step: STEP_NONE
		};
		const e = event;
		const messages = [];
		if (e.type === "step.begin") {
			if (typeof e.uuid !== "string" || e.uuid.length === 0) return {
				messages: [],
				turn: NONE,
				step: STEP_NONE
			};
			const ordinal = typeof e.step === "number" && Number.isSafeInteger(e.step) && e.step > 0 ? e.step : void 0;
			return {
				messages: [],
				turn: NONE,
				step: {
					kind: "begin",
					uuid: e.uuid,
					ordinal
				}
			};
		}
		const stepUuid = typeof e.stepUuid === "string" && e.stepUuid.length > 0 ? e.stepUuid : void 0;
		let turn = NONE;
		if (e.type === "content.part") {
			const part = e.part;
			if (part !== null && typeof part === "object") {
				const p = part;
				if (p.type === "text" && typeof p.text === "string") {
					const text = p.text.trim();
					if (text.length > 0) {
						messages.push({
							role: "assistant",
							text,
							time,
							stepUuid
						});
						turn = ENSURE;
					}
				} else if (p.type === "think" && typeof p.think === "string") {
					if (p.think.trim().length > 0 || p.encrypted !== void 0) turn = ENSURE;
				} else turn = ENSURE;
			}
		} else if (e.type === "tool.call") turn = ENSURE;
		return {
			messages,
			turn,
			step: STEP_NONE
		};
	}
	if (r.type === "context.undo") {
		const count = r.count;
		if (typeof count === "number" && Number.isSafeInteger(count) && count > 0) return {
			messages: [],
			turn: {
				kind: "undo",
				count
			},
			step: STEP_NONE
		};
		return {
			messages: [],
			turn: NONE,
			step: STEP_NONE
		};
	}
	return {
		messages: [],
		turn: NONE,
		step: STEP_NONE
	};
}
// ../../packages/kap-server/src/search/indexCore.ts
const TEXT_INDEX_NAME = "body";
const TRI_INDEX_NAME = "tri";
const WIRE_FILENAME = "wire.jsonl";
const TEXT_BUILD_TMP_SUFFIX = ".tmpbuild";
const SEARCH_WIRE_PROTOCOL_VERSION = "1.5";
const MALFORMED_WIRE_META_CODE = "wire.metadata_malformed";
function malformedWireMetaError() {
	const error = /* @__PURE__ */ new TypeError("Agent wire metadata is malformed");
	error.code = MALFORMED_WIRE_META_CODE;
	return error;
}
function assertSearchWireReaderVersion(line) {
	let record;
	try {
		const parsed = JSON.parse(line);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw malformedWireMetaError();
		record = parsed;
	} catch {
		throw malformedWireMetaError();
	}
	if (record["type"] !== "metadata") return;
	const protocolVersion = record["protocol_version"];
	const createdAt = record["created_at"];
	const minReaderVersion = record["min_protocol_version"];
	if (typeof protocolVersion !== "string" || typeof createdAt !== "number") throw malformedWireMetaError();
	if (minReaderVersion === void 0) return;
	if (typeof minReaderVersion !== "string" || !/^\d+(\.\d+)*$/.test(minReaderVersion)) throw malformedWireMetaError();
	const current = SEARCH_WIRE_PROTOCOL_VERSION.split(".");
	const required = minReaderVersion.split(".");
	for (let index = 0; index < Math.max(current.length, required.length); index++) {
		const diff = Number(current[index] ?? "0") - Number(required[index] ?? "0");
		if (diff < 0) {
			const error = /* @__PURE__ */ new Error(`This wire.jsonl requires reader protocol ${minReaderVersion}; current Kimi Code supports ${SEARCH_WIRE_PROTOCOL_VERSION}. Upgrade Kimi Code to read this session.`);
			error.code = "wire.version_too_low";
			throw error;
		}
		if (diff > 0) return;
	}
}
function isSearchWireCompatibilityError(error) {
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	const code = error.code;
	return code === MALFORMED_WIRE_META_CODE || code === "wire.version_too_low";
}
const FILE_META_PREFIX = "\0meta\\file\\";
const SESSION_META_PREFIX = "\0meta\\session\\";
const STATS_KEY = "\0meta\\stats";
function hashPath(filePath) {
	return new Bun.CryptoHasher("sha256").update(filePath).digest("hex").slice(0, 32);
}
function fileMetaKey(sessionId, filePath) {
	return `${FILE_META_PREFIX}${sessionId}\\${hashPath(filePath)}`;
}
function fileMetaPrefixFor(sessionId) {
	return `${FILE_META_PREFIX}${sessionId}\\`;
}
function legacyFileMetaKey(filePath) {
	return FILE_META_PREFIX + hashPath(filePath);
}
const WIRE_READ_CHUNK_BYTES = 1 << 20;
const WIRE_BATCH_OPS = 1e3;
const SYNC_ROUND_BYTE_BUDGET = 64 << 20;
const SYNC_ROUND_TIME_BUDGET_MS = 3e4;
const SYNC_FAILURE_ESCALATION_LIMIT = 5;
const SESSION_SYNC_FAILURE_SKIP_LIMIT = 5;
const SESSION_SYNC_SKIP_COOLDOWN_MS = 3e5;
const SYNC_SESSION_CAP_DEFAULT = 500;
const EMPTY_BUFFER = Buffer.alloc(0);
function syncBudgetExhausted(budget) {
	return budget.bytesLeft <= 0 || Date.now() >= budget.deadline;
}
const statFn = { current: fs$1.stat };
async function sessionDirectoryIdentity(dir) {
	try {
		const info = await statFn.current(dir, { bigint: true });
		if (!info.isDirectory() || info.ino <= 0n || info.birthtimeNs <= 0n) return void 0;
		return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
	} catch (error) {
		const code = error.code;
		if (code === "ENOENT" || code === "ENOTDIR") return void 0;
		throw error;
	}
}
async function statMtimeMs(path) {
	try {
		return (await fs$1.stat(path)).mtimeMs;
	} catch {
		return;
	}
}
async function probeSessionSource(dir) {
	let dirStat;
	try {
		dirStat = await fs$1.stat(dir);
	} catch {
		return;
	}
	if (!dirStat.isDirectory()) return void 0;
	const agentsMtimeMs = await statMtimeMs(join(dir, "agents"));
	const stateMtimeMs = await statMtimeMs(join(dir, "state.json")) ?? await statMtimeMs(join(dir, "session-meta", "state.json"));
	return {
		dirMtimeMs: dirStat.mtimeMs,
		agentsMtimeMs,
		stateMtimeMs
	};
}
function formatSessionSourceProbe(probe) {
	return `${probe.dirMtimeMs}|${probe.agentsMtimeMs ?? "x"}|${probe.stateMtimeMs ?? "x"}`;
}
async function wireFileUnchanged(meta) {
	if (meta.mtimeMs === void 0) return false;
	let st;
	try {
		st = await fs$1.stat(meta.path);
	} catch {
		return false;
	}
	if (st.size !== meta.size || st.mtimeMs !== meta.mtimeMs) return false;
	if (meta.ino !== void 0 && st.ino !== meta.ino) return false;
	return true;
}
const querySourceChecks = {
	running: false,
	waiters: /* @__PURE__ */ new Set()
};
async function queryDirectoryIdentity(dir, deadlineAt, deadline, now) {
	while (querySourceChecks.running) {
		let wake;
		const available = new Promise((resolve) => {
			wake = () => {
				resolve(true);
			};
		});
		querySourceChecks.waiters.add(wake);
		try {
			if (await Promise.race([available, deadline]) === null) return null;
		} finally {
			querySourceChecks.waiters.delete(wake);
		}
	}
	if (now() >= deadlineAt) return null;
	querySourceChecks.running = true;
	const identity = sessionDirectoryIdentity(dir);
	const release = () => {
		querySourceChecks.running = false;
		for (const wake of querySourceChecks.waiters) wake();
		querySourceChecks.waiters.clear();
	};
	identity.then(release, release);
	return Promise.race([identity, deadline]);
}
async function sessionDirectoryTitle(dir, log) {
	for (const scope of ["", "session-meta"]) try {
		const meta = JSON.parse(await fs$1.readFile(join(dir, scope, "state.json"), "utf8"));
		if (typeof meta === "object" && meta !== null && "title" in meta && typeof meta.title === "string") return meta.title;
		return "";
	} catch (error) {
		if (error.code !== "ENOENT") log.warn("search index: cannot read session title", {
			dir,
			error: errorMessage(error)
		});
	}
	return "";
}
const INITIAL_TURN_STATE = {
	next: 0,
	hasTurn: false,
	openers: []
};
function initialTurnState() {
	return INITIAL_TURN_STATE;
}
function applyUndoToTurnState(state, count) {
	let found = 0;
	for (let i = state.openers.length - 1; i >= 0; i--) if (state.openers[i].anchor) {
		found++;
		if (found === count) return {
			next: state.openers[i].turn,
			hasTurn: i > 0,
			openers: state.openers.slice(0, i)
		};
	}
	return state;
}
function advanceTurnCounter(state, effect) {
	switch (effect.kind) {
		case "open": return {
			docTurn: state.next,
			state: {
				next: state.next + 1,
				hasTurn: true,
				openers: [...state.openers, {
					turn: state.next,
					anchor: effect.anchor
				}]
			}
		};
		case "ensure": {
			const next = state.hasTurn ? state : {
				...state,
				next: state.next + 1,
				hasTurn: true
			};
			return {
				docTurn: next.next - 1,
				state: next
			};
		}
		case "undo": return {
			docTurn: void 0,
			state: applyUndoToTurnState(state, effect.count)
		};
		case "none": return {
			docTurn: void 0,
			state
		};
	}
}
const INITIAL_STEP_STATE = {
	byUuid: {},
	begins: 0
};
function initialStepState() {
	return INITIAL_STEP_STATE;
}
function advanceStepTracker(state, effect) {
	if (effect.kind !== "begin") return state;
	const begins = state.begins + 1;
	const ordinal = effect.ordinal ?? begins;
	if (state.byUuid[effect.uuid] === ordinal) return state;
	return {
		byUuid: {
			...state.byUuid,
			[effect.uuid]: ordinal
		},
		begins
	};
}
var SearchIndexCore = class {
	options;
	walOffset = 0;
	fingerprint = "";
	disposed = false;
	ops = new OpTracker();
	generation = 0;
	syncReplaced = false;
	lastRefreshError = null;
	openError = null;
	fileMetaMigrated = false;
	lockToken;
	lastMaintenanceDetail;
	consecutiveSyncFailures = 0;
	sessionSyncFailures = /* @__PURE__ */ new Map();
	sessionSyncSkips = /* @__PURE__ */ new Map();
	db = null;
	openPromise = null;
	refreshPromise = null;
	fullSyncDone = false;
	syncRoundBytes = SYNC_ROUND_BYTE_BUDGET;
	syncRoundMs = SYNC_ROUND_TIME_BUDGET_MS;
	syncSkipCooldownMs = SESSION_SYNC_SKIP_COOLDOWN_MS;
	syncSessionCap = SYNC_SESSION_CAP_DEFAULT;
	clock = SYSTEM_CLOCK;
	constructor(options) {
		this.options = options;
		this.clock = options.clock ?? SYSTEM_CLOCK;
	}
	get lockTokenView() {
		return this.lockToken;
	}
	get indexDir() {
		return this.options.indexDir;
	}
	get log() {
		return this.options.log;
	}
	ensureOpen() {
		this.openPromise ??= this.openDb().then(() => {
			this.openError = null;
		}, (error) => {
			this.openPromise = null;
			this.openError = errorMessage(error);
			throw error;
		});
		return this.openPromise;
	}
	async openDb() {
		const db = await this.openSearchDb();
		if (this.disposed) {
			await db.close().catch(() => {});
			throw new GlobalSearchError("index_unavailable", "search service is disposed");
		}
		await this.publishDb(db, null);
		if (!db.readOnly) await this.cleanInterruptedTextBuilds();
	}
	async cleanInterruptedTextBuilds() {
		const entries = await fs$1.readdir(this.indexDir, { withFileTypes: true }).catch(() => void 0);
		if (entries === void 0) return;
		for (const entry of entries) {
			if (!entry.isDirectory() || !entry.name.endsWith(TEXT_BUILD_TMP_SUFFIX)) continue;
			const path = join(this.indexDir, entry.name);
			try {
				await fs$1.rm(path, {
					recursive: true,
					force: true
				});
				this.log.info("global search: removed an interrupted text-build leftover", { dir: path });
			} catch (error) {
				this.log.warn("global search: cannot remove an interrupted text-build leftover", {
					dir: path,
					error: errorMessage(error)
				});
			}
		}
	}
	tokenGeneration() {
		return `${this.options.bootSalt}:${this.generation}`;
	}
	async publishDb(next, prev) {
		let fingerprint;
		try {
			if (!next.readOnly) for (const [name, options] of [[TEXT_INDEX_NAME, { fields: ["text"] }], [TRI_INDEX_NAME, {
				fields: ["text"],
				tokenizer: "ngram"
			}]]) try {
				await next.createTextIndex(name, options);
			} catch (error) {
				if (error instanceof Error && error.message.includes("already exists")) continue;
				const code = error.code;
				const cause = error.cause?.code;
				if (code === "EPERM" || cause === "EPERM" || String(error).includes("EPERM")) continue;
				throw error;
			}
			fingerprint = await this.computeFingerprint();
		} catch (error) {
			await next.close().catch(() => {});
			throw error;
		}
		this.db = next;
		this.walOffset = next.recoveryInfo?.walScanEnd ?? 0;
		this.generation++;
		this.fingerprint = fingerprint;
		this.lockToken = next.readOnly ? void 0 : await this.readLockToken();
		if (prev !== null) await prev.close().catch(() => {});
		const lifecycle = next.lifecycleStatus();
		this.log.info("global search: index opened", {
			dir: this.indexDir,
			readOnly: next.readOnly,
			state: lifecycle.state,
			generation: next.getIndexGeneration()?.id ?? null,
			openMs: Math.round(lifecycle.phases.openMs),
			fullRecoveryMs: Math.round(lifecycle.phases.fullRecoveryMs)
		});
	}
	async readLockToken() {
		try {
			const raw = await fs$1.readFile(join(this.indexDir, "db.lock"), "utf8");
			const parsed = JSON.parse(raw);
			if (parsed.pid !== process.pid || typeof parsed.token !== "string") return void 0;
			return parsed.token;
		} catch {
			return;
		}
	}
	async openSearchDb() {
		const opts = {
			dir: this.indexDir,
			valueCodec: "json",
			valueMode: "disk",
			fsyncPolicy: "everysec",
			onLockFail: "readonly",
			onLockAcquired: (info) => {
				this.lockToken = info.token;
				this.options.onLockToken?.(info.token);
			}
		};
		try {
			return await MiniDb.open(opts);
		} catch (error) {
			if (classifyStorageError(error) !== "rebuild") throw error;
			if (await wipeStoreDir({ dir: this.indexDir }) === "locked") throw error;
			this.log.warn("global search: search-index corruption detected; rebuilding from scratch", {
				dir: this.indexDir,
				error: errorMessage(error)
			});
			return MiniDb.open(opts);
		}
	}
	beginClose() {
		this.disposed = true;
	}
	async close() {
		this.disposed = true;
		let drainTimer;
		await Promise.race([this.ops.close(), new Promise((resolve) => {
			drainTimer = setTimeout(resolve, 2e3);
			drainTimer.unref?.();
		})]);
		if (drainTimer !== void 0) clearTimeout(drainTimer);
		await this.openPromise?.catch(() => {});
		const db = this.db;
		this.db = null;
		if (db) await db.close().catch(() => {});
	}
	async tracked(op) {
		if (!this.ops.enter()) return;
		try {
			await op();
		} finally {
			this.ops.leave();
		}
	}
	async computeFingerprint() {
		const parts = [];
		for (const name of [
			"db.wal",
			"db.snapshot",
			"db.textindexes.json"
		]) try {
			const s = await fs$1.stat(join(this.indexDir, name));
			parts.push(`${name}:${s.dev}:${s.ino}:${s.mtimeMs}:${s.size}`);
		} catch {
			parts.push(`${name}:-`);
		}
		return parts.join("|");
	}
	refresh() {
		this.refreshPromise ??= this.tracked(() => this.doRefreshReadonly()).then(() => {
			this.lastRefreshError = null;
		}, (error) => {
			this.lastRefreshError = {
				at: Date.now(),
				message: errorMessage(error)
			};
			this.log.warn("global search: read-only refresh failed; serving the stale view", { error: errorMessage(error) });
		}).finally(() => {
			this.refreshPromise = null;
		});
		return this.refreshPromise;
	}
	async doRefreshReadonly() {
		const db = this.db;
		if (!db || !db.readOnly || this.disposed) return;
		const fp = await this.computeFingerprint();
		if (fp === this.fingerprint) return;
		const [, snapPrev, defsPrev] = this.fingerprint.split("|");
		const [, snapNow, defsNow] = fp.split("|");
		if (snapPrev === snapNow && defsPrev === defsNow) {
			const res = await db.catchUpFromWal(this.walOffset);
			if (res !== null) {
				this.walOffset = res.offset;
				this.fingerprint = fp;
				return;
			}
		}
		const next = await this.openSearchDb();
		if (this.disposed) {
			await next.close().catch(() => {});
			return;
		}
		if (this.db !== db) {
			await next.close().catch(() => {});
			return;
		}
		await this.publishDb(next, db);
	}
	async sync(sessions) {
		let outcome = {
			noop: true,
			sessions: 0,
			documents: 0,
			truncated: false,
			failures: 0
		};
		await this.tracked(async () => {
			try {
				outcome = await this.runSync(sessions);
				this.consecutiveSyncFailures = 0;
			} catch (error) {
				if (classifyStorageError(error) !== "rebuild") {
					this.consecutiveSyncFailures += 1;
					if (this.consecutiveSyncFailures < SYNC_FAILURE_ESCALATION_LIMIT) throw error;
				}
				this.consecutiveSyncFailures = 0;
				await this.recoverByRebuild(error);
				outcome = {
					noop: false,
					sessions: 0,
					documents: 0,
					truncated: true,
					failures: 0
				};
			}
		});
		return {
			...outcome,
			lockToken: this.lockToken,
			lifecycle: this.lifecycleState()
		};
	}
	async recoverByRebuild(cause) {
		this.log.warn("global search: search-index state is unrecoverable; wiping and rebuilding from the transcripts", {
			dir: this.indexDir,
			error: errorMessage(cause)
		});
		await this.reindex();
	}
	async runSync(sessions) {
		const noop = {
			noop: true,
			sessions: 0,
			documents: 0,
			truncated: false,
			failures: 0
		};
		if (this.disposed) return noop;
		this.syncReplaced = false;
		await this.ensureOpen();
		const db = this.db;
		if (!db || db.readOnly || this.disposed) return noop;
		await this.migrateFileMetaKeys(db);
		const currentIds = new Set(sessions.map((s) => s.id));
		for (const row of db.query({
			key: { prefix: SESSION_META_PREFIX },
			project: []
		})) {
			if (this.disposed) return noop;
			const sessionId = row.key.slice(14);
			if (!currentIds.has(sessionId)) await this.deleteSessionDocs(db, sessionId);
		}
		const budget = {
			bytesLeft: this.syncRoundBytes,
			deadline: Date.now() + this.syncRoundMs
		};
		let indexed = 0;
		let syncedFresh = 0;
		let truncated = false;
		let failures = 0;
		for (const summary of sessions) {
			if (this.disposed) return noop;
			const skip = this.sessionSyncSkips.get(summary.id);
			if (skip !== void 0 && summary.updatedAt === skip.updatedAt && Date.now() - skip.at < this.syncSkipCooldownMs) continue;
			this.sessionSyncSkips.delete(summary.id);
			if (syncBudgetExhausted(budget)) {
				truncated = true;
				break;
			}
			if (syncedFresh >= this.syncSessionCap) {
				truncated = true;
				break;
			}
			const result = await this.syncSession(db, summary, budget);
			if (result === void 0) continue;
			if (result.skipped !== true) syncedFresh++;
			if (result.truncated) truncated = true;
			if (result.failed) {
				const count = (this.sessionSyncFailures.get(summary.id) ?? 0) + 1;
				this.sessionSyncFailures.set(summary.id, count);
				if (count >= SESSION_SYNC_FAILURE_SKIP_LIMIT) {
					this.sessionSyncFailures.delete(summary.id);
					this.sessionSyncSkips.set(summary.id, {
						at: Date.now(),
						updatedAt: summary.updatedAt
					});
					this.log.warn("global search: giving up on a session whose wire transcript stays unreadable", {
						sessionId: summary.id,
						error: result.error
					});
				} else {
					failures += 1;
					this.log.warn("global search: failed to index session", {
						sessionId: summary.id,
						error: result.error
					});
				}
			} else this.sessionSyncFailures.delete(summary.id);
			indexed++;
		}
		if (this.disposed) return noop;
		const metaCount = db.query({
			key: { prefix: "\0meta\\" },
			project: []
		}).length;
		const stats = {
			kind: "stats",
			degraded: indexed < sessions.length ? `Skipped ${sessions.length - indexed} session(s) during indexing` : void 0,
			sessions: indexed,
			documents: db.size - metaCount,
			lastIndexedAt: Date.now()
		};
		await db.set(STATS_KEY, stats);
		if (!truncated && failures === 0) this.fullSyncDone = true;
		if (this.syncReplaced) this.generation++;
		return {
			noop: false,
			sessions: indexed,
			documents: stats.documents,
			truncated,
			failures
		};
	}
	async migrateFileMetaKeys(db) {
		if (this.fileMetaMigrated) return;
		const ops = [];
		for (const row of db.query({
			key: { prefix: FILE_META_PREFIX },
			project: []
		})) {
			if (row.key.slice(11).includes("\\")) continue;
			const meta = row.value;
			if (meta.kind !== "fileMeta") continue;
			ops.push({
				op: "set",
				key: fileMetaKey(meta.sessionId, meta.path),
				value: meta
			});
			ops.push({
				op: "del",
				key: row.key
			});
		}
		if (ops.length > 0) await db.batch(ops);
		this.fileMetaMigrated = true;
	}
	async deleteSessionDocs(db, sessionId) {
		for (const row of db.query({
			key: { prefix: `${sessionId}/` },
			project: []
		})) await db.del(row.key);
		for (const row of db.query({
			key: { prefix: fileMetaPrefixFor(sessionId) },
			project: []
		})) await db.del(row.key);
		await db.del(SESSION_META_PREFIX + sessionId);
	}
	async syncSession(db, summary, budget = {
		bytesLeft: SYNC_ROUND_BYTE_BUDGET,
		deadline: Date.now() + SYNC_ROUND_TIME_BUDGET_MS
	}) {
		const metaKey = SESSION_META_PREFIX + summary.id;
		const previous = db.get(metaKey);
		if (await this.sessionSourceUnchanged(db, summary, previous)) return {
			truncated: false,
			failed: false,
			skipped: true
		};
		let identity;
		try {
			identity = await sessionDirectoryIdentity(summary.dir);
		} catch (error) {
			this.log.warn("global search: failed to index session", {
				sessionId: summary.id,
				error: errorMessage(error)
			});
			return;
		}
		if (identity === void 0) {
			await this.deleteSessionDocs(db, summary.id);
			return;
		}
		const title = await sessionDirectoryTitle(summary.dir, this.log);
		if (previous?.kind !== "sessionMeta" || previous.identity !== identity || previous.dir !== summary.dir) {
			await this.deleteSessionDocs(db, summary.id);
			if (previous !== void 0) this.syncReplaced = true;
		}
		const meta = {
			kind: "sessionMeta",
			dir: summary.dir,
			identity,
			title
		};
		if (previous?.kind !== "sessionMeta" || previous.identity !== identity || previous.dir !== summary.dir || previous.title !== title) await db.set(metaKey, meta);
		const wireFiles = await collectWireFiles(summary.dir);
		const seenPaths = new Set(wireFiles.map((file) => file.path));
		for (const row of db.query({ key: { prefix: fileMetaPrefixFor(summary.id) } })) {
			const meta = row.value;
			if (meta.kind !== "fileMeta") continue;
			if (seenPaths.has(meta.path)) continue;
			await this.deleteFileDocs(db, meta);
			await db.del(row.key);
		}
		let truncated = false;
		let failed = false;
		let error;
		for (const file of wireFiles) {
			const result = await this.syncWireFile(db, {
				...summary,
				title,
				sessionIdentity: identity
			}, file, budget);
			if (result.truncated) truncated = true;
			if (result.failed) {
				failed = true;
				error ??= result.error;
			}
		}
		const titleKey = `${summary.id}/$title`;
		const existing = db.get(titleKey);
		if (title.length > 0) {
			if (existing?.kind !== "title" || existing.text !== title) {
				const doc = {
					kind: "title",
					sessionIdentity: identity,
					sessionId: summary.id,
					workspaceId: summary.workspaceId,
					sessionTitle: title,
					agentId: "",
					role: "title",
					text: title,
					time: summary.updatedAt
				};
				await db.set(titleKey, doc);
				if (existing !== void 0) this.syncReplaced = true;
			}
		} else if (existing !== void 0) await db.del(titleKey);
		if (!truncated && !failed) await this.stampSessionSource(db, metaKey, meta, summary);
		return {
			truncated,
			failed,
			error
		};
	}
	async sessionSourceUnchanged(db, summary, previous) {
		if (previous?.kind !== "sessionMeta") return false;
		if (previous.dir !== summary.dir) return false;
		if (previous.sourceUpdatedAt !== summary.updatedAt) return false;
		if ((previous.title ?? "") !== (summary.title ?? "")) return false;
		const syncSource = previous.syncSource;
		if (syncSource === void 0) return false;
		const probe = await probeSessionSource(summary.dir);
		if (probe === void 0 || formatSessionSourceProbe(probe) !== syncSource) return false;
		for (const row of db.query({ key: { prefix: fileMetaPrefixFor(summary.id) } })) {
			const meta = row.value;
			if (meta.kind !== "fileMeta") continue;
			if (!await wireFileUnchanged(meta)) return false;
		}
		return true;
	}
	async stampSessionSource(db, metaKey, meta, summary) {
		const probe = await probeSessionSource(summary.dir);
		if (probe === void 0) return;
		await db.set(metaKey, {
			...meta,
			sourceUpdatedAt: summary.updatedAt,
			syncSource: formatSessionSourceProbe(probe)
		});
	}
	async deleteFileDocs(db, meta) {
		const prefix = `${meta.sessionId}/${meta.agentId}/${meta.source}:`;
		for (const row of db.query({
			key: { prefix },
			project: []
		})) await db.del(row.key);
	}
	async syncWireFile(db, summary, file, budget) {
		let st;
		try {
			st = await fs$1.stat(file.path);
		} catch {
			return {
				truncated: false,
				failed: false
			};
		}
		const size = st.size;
		const metaKey = fileMetaKey(summary.id, file.path);
		let meta = db.get(metaKey);
		let legacyKey = null;
		if (meta?.kind !== "fileMeta") {
			const oldKey = legacyFileMetaKey(file.path);
			const legacy = db.get(oldKey);
			if (legacy?.kind === "fileMeta") {
				meta = legacy;
				legacyKey = oldKey;
			}
		}
		const known = meta?.kind === "fileMeta" ? meta : void 0;
		let offset = known?.offset ?? 0;
		let turnState = known?.turnState ?? initialTurnState();
		let stepState = known?.stepState ?? initialStepState();
		const fileMeta = (nextOffset, turns, steps) => ({
			kind: "fileMeta",
			sessionId: summary.id,
			agentId: file.agentId,
			source: file.source,
			path: file.path,
			offset: nextOffset,
			size,
			mtimeMs: st.mtimeMs,
			ino: st.ino,
			turnState: turns,
			stepState: steps
		});
		const legacyMeta = known !== void 0 && known.stepState === void 0;
		const replacedFile = known?.ino !== void 0 && known.ino !== st.ino;
		const rewrittenInPlace = known?.mtimeMs !== void 0 && size === known.offset && st.mtimeMs > known.mtimeMs;
		if (size < offset || legacyMeta || replacedFile || rewrittenInPlace) {
			this.syncReplaced = true;
			await this.deleteFileDocs(db, fileMeta(0, initialTurnState(), initialStepState()));
			offset = 0;
			turnState = initialTurnState();
			stepState = initialStepState();
		}
		if (size === offset) {
			if (legacyKey !== null || known === void 0 || known.size !== size || known.mtimeMs !== st.mtimeMs || known.ino !== st.ino || known.offset !== offset) {
				const ops = [{
					op: "set",
					key: metaKey,
					value: fileMeta(offset, turnState, stepState)
				}];
				if (legacyKey !== null) ops.push({
					op: "del",
					key: legacyKey
				});
				await db.batch(ops);
			}
			return {
				truncated: false,
				failed: false
			};
		}
		let handle;
		try {
			handle = await fs$1.open(file.path, "r");
		} catch (error) {
			return {
				truncated: false,
				failed: true,
				error: errorMessage(error)
			};
		}
		const ops = [];
		let byteCursor = offset;
		let position = offset;
		let wireError;
		let compatibilityFailure = false;
		try {
			let pending = EMPTY_BUFFER;
			let finishing = false;
			const chunk = Buffer.allocUnsafe(WIRE_READ_CHUNK_BYTES);
			while (position < size) {
				if (this.disposed) return {
					truncated: false,
					failed: false
				};
				if (syncBudgetExhausted(budget)) {
					if (pending.length === 0) break;
					finishing = true;
				}
				let bytesRead;
				try {
					({bytesRead} = await handle.read(chunk, 0, Math.min(chunk.length, size - position), position));
				} catch (error) {
					wireError = error;
					break;
				}
				if (bytesRead === 0) break;
				budget.bytesLeft -= bytesRead;
				const slice = chunk.subarray(0, bytesRead);
				position += bytesRead;
				let start = 0;
				let completedRecord = false;
				for (;;) {
					const nl = slice.indexOf(10, start);
					if (nl === -1) break;
					const lineBuf = pending.length > 0 ? Buffer.concat([pending, slice.subarray(start, nl)]) : slice.subarray(start, nl);
					pending = EMPTY_BUFFER;
					const lineOffset = byteCursor;
					byteCursor += lineBuf.length + 1;
					const line = lineBuf.toString("utf8");
					try {
						if (lineOffset === 0) assertSearchWireReaderVersion(line);
						({turnState, stepState} = this.collectWireLine(ops, summary, file, line, lineOffset, {
							turnState,
							stepState
						}));
					} catch (error) {
						if (!isSearchWireCompatibilityError(error)) throw error;
						wireError = error;
						compatibilityFailure = true;
						break;
					}
					completedRecord = true;
					start = nl + 1;
				}
				pending = pending.length > 0 ? Buffer.concat([pending, slice.subarray(start)]) : Buffer.from(slice.subarray(start));
				if (compatibilityFailure) break;
				if (finishing && completedRecord) break;
				if (ops.length >= WIRE_BATCH_OPS) {
					ops.push({
						op: "set",
						key: metaKey,
						value: fileMeta(byteCursor, turnState, stepState)
					});
					if (legacyKey !== null) {
						ops.push({
							op: "del",
							key: legacyKey
						});
						legacyKey = null;
					}
					await db.batch(ops);
					ops.length = 0;
				}
			}
		} finally {
			await handle.close();
		}
		if (compatibilityFailure) {
			await this.deleteFileDocs(db, fileMeta(0, initialTurnState(), initialStepState()));
			await db.del(metaKey);
			if (legacyKey !== null) await db.del(legacyKey);
			return {
				truncated: false,
				failed: true,
				error: errorMessage(wireError)
			};
		}
		const truncated = position < size && syncBudgetExhausted(budget);
		if (byteCursor !== offset || legacyKey !== null) {
			ops.push({
				op: "set",
				key: metaKey,
				value: fileMeta(byteCursor, turnState, stepState)
			});
			if (legacyKey !== null) ops.push({
				op: "del",
				key: legacyKey
			});
			await db.batch(ops);
		}
		return {
			truncated,
			failed: wireError !== void 0,
			error: wireError !== void 0 ? errorMessage(wireError) : void 0
		};
	}
	collectWireLine(ops, summary, file, line, lineOffset, counters) {
		let { turnState, stepState } = counters;
		const analysis = analyzeWireLine(line);
		const advanced = advanceTurnCounter(turnState, analysis.turn);
		if (analysis.turn.kind === "open" || analysis.turn.kind === "undo" || analysis.turn.kind === "ensure" && !turnState.hasTurn) stepState = initialStepState();
		turnState = advanced.state;
		stepState = advanceStepTracker(stepState, analysis.step);
		const extracted = analysis.messages;
		for (let i = 0; i < extracted.length; i++) {
			const e = extracted[i];
			const stepOrdinal = e.stepUuid !== void 0 ? stepState.byUuid[e.stepUuid] : void 0;
			const doc = {
				kind: "message",
				sessionIdentity: summary.sessionIdentity,
				sessionId: summary.id,
				workspaceId: summary.workspaceId,
				sessionTitle: summary.title ?? "",
				agentId: file.agentId,
				role: e.role,
				text: e.text.length > 2e4 ? e.text.slice(0, MAX_DOC_TEXT_CHARS) : e.text,
				time: e.time ?? summary.updatedAt,
				turn: advanced.docTurn,
				stepId: advanced.docTurn !== void 0 && stepOrdinal !== void 0 ? `t${advanced.docTurn}.${stepOrdinal}` : void 0
			};
			ops.push({
				op: "set",
				key: `${docKeyPrefix(summary.id, file)}${lineOffset}:${i}`,
				value: doc
			});
		}
		return {
			turnState,
			stepState
		};
	}
	async search(params) {
		const { q, budgets } = params;
		const db = this.db;
		if (db === null) {
			if (this.disposed) throw new GlobalSearchError("index_unavailable", "search service is disposed");
			if (this.openError !== null) throw new GlobalSearchError("index_unavailable", `search index failed to open: ${this.openError}`);
			if (params.pageToken !== void 0) throw new GlobalSearchError("invalid_page_token", "the search index is not ready yet; restart the search");
			return {
				kind: "building",
				index: this.buildingView()
			};
		}
		let freshnessStale = false;
		let serveDb = db;
		if (serveDb.readOnly) {
			let fp = null;
			try {
				fp = await this.computeFingerprint();
			} catch (error) {
				this.lastRefreshError = {
					at: Date.now(),
					message: errorMessage(error)
				};
			}
			if (this.db === null) throw new GlobalSearchError("index_unavailable", "search service is disposed");
			serveDb = this.db;
			if (serveDb.readOnly) {
				freshnessStale = fp === null || fp !== this.fingerprint || this.refreshPromise !== null;
				if (fp !== null && fp !== this.fingerprint) this.refresh();
			}
		}
		const generation = this.tokenGeneration();
		const page = decodePageToken(q, params.pageToken, generation);
		if (serveDb.textIndexBuilding(q.mode === "literal" ? TRI_INDEX_NAME : TEXT_INDEX_NAME)) return {
			kind: "building",
			index: this.buildingView(serveDb)
		};
		let candidates;
		let incomplete;
		const runBounded = (db2) => {
			if (q.mode === "literal") return db2.searchBoundedAsync(TRI_INDEX_NAME, q.query, {
				op: "AND",
				limit: budgets.literalCandidateCap + 1,
				maxVisits: budgets.postingsVisitBudget
			});
			return db2.searchBoundedAsync(TEXT_INDEX_NAME, q.query, {
				op: q.op,
				limit: budgets.maxTextHits + 1,
				maxVisits: budgets.postingsVisitBudget
			});
		};
		try {
			let res;
			try {
				res = await runBounded(serveDb);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				if (!(msg.includes("postings file is closed") || msg.includes("MiniDb is closed") || msg.includes("ValueReader is not open")) || this.db === null || this.db === serveDb) throw error;
				serveDb = this.db;
				res = await runBounded(serveDb);
			}
			if (q.mode === "literal") {
				candidates = res.hits;
				if (res.truncated) incomplete = "postings_budget";
				if (candidates.length > budgets.literalCandidateCap) {
					candidates.length = budgets.literalCandidateCap;
					incomplete ??= "candidate_cap";
				}
			} else {
				candidates = res.hits;
				if (res.truncated) incomplete = "postings_budget";
				if (candidates.length > budgets.maxTextHits) {
					candidates.length = budgets.maxTextHits;
					incomplete ??= "candidate_cap";
				}
			}
		} catch (error) {
			if (error instanceof TextIndexBuildingError) return {
				kind: "building",
				index: this.buildingView(serveDb)
			};
			if (error instanceof Error && error.message.includes("no such text index")) return {
				kind: "page",
				rows: [],
				hasMore: false,
				incomplete: void 0,
				generation,
				index: this.readIndexView(serveDb, freshnessStale)
			};
			throw error;
		}
		const budget = {
			deadlineAt: this.clock.now() + budgets.queryDeadlineMs,
			textCharsLeft: budgets.queryTextBudgetChars,
			now: () => this.clock.now()
		};
		const boundary = page.kind === "keyset" ? page.boundary : void 0;
		const matched = matchDocs(q, candidates, boundary, budget);
		incomplete ??= matched.incomplete;
		const index = this.readIndexView(serveDb, freshnessStale);
		const sources = /* @__PURE__ */ new Map();
		for (const row of matched.rows) {
			const id = row.value.sessionId;
			if (sources.has(id)) continue;
			if (this.clock.now() > budget.deadlineAt) {
				incomplete ??= "deadline";
				break;
			}
			const meta = serveDb.get(SESSION_META_PREFIX + id);
			sources.set(id, meta?.kind === "sessionMeta" ? meta : void 0);
		}
		const identities = /* @__PURE__ */ new Map();
		const visible = [];
		let deadlineTimer;
		const deadline = new Promise((resolve) => {
			deadlineTimer = this.clock.setTimeout(() => resolve(null), Math.max(0, budget.deadlineAt - this.clock.now()));
			deadlineTimer.unref?.();
		});
		try {
			for (const row of matched.rows) {
				if (this.clock.now() > budget.deadlineAt) {
					incomplete ??= "deadline";
					break;
				}
				const meta = sources.get(row.value.sessionId);
				if (meta?.dir === void 0 || row.value.sessionIdentity === void 0 || meta.identity !== row.value.sessionIdentity) {
					freshnessStale = true;
					continue;
				}
				if (!identities.has(meta.dir)) try {
					const identity = await queryDirectoryIdentity(meta.dir, budget.deadlineAt, deadline, () => this.clock.now());
					if (identity === null || this.clock.now() > budget.deadlineAt) {
						incomplete ??= "deadline";
						break;
					}
					identities.set(meta.dir, identity);
				} catch (error) {
					throw new GlobalSearchError("index_unavailable", `cannot verify search source: ${errorMessage(error)}`);
				}
				if (identities.get(meta.dir) === row.value.sessionIdentity) visible.push({
					...row,
					value: {
						...row.value,
						sessionTitle: meta.title ?? ""
					}
				});
				else freshnessStale = true;
			}
		} finally {
			if (deadlineTimer !== void 0) this.clock.clearTimeout(deadlineTimer);
		}
		const { pageRows, hasMore } = paginateRows(q, page, visible);
		return {
			kind: "page",
			rows: pageRows,
			hasMore,
			incomplete,
			generation,
			index: {
				...index,
				freshnessStale: freshnessStale || this.db !== serveDb
			}
		};
	}
	async reindex() {
		await this.ensureOpen();
		if (this.db?.readOnly === true) throw new GlobalSearchError("readonly_index", "another process holds the search-index write lock; reindex from that process");
		await this.refreshPromise?.catch(() => {});
		const db = this.db;
		if (db) {
			await db.close().catch(() => {});
			this.db = null;
		}
		this.openPromise = null;
		this.fullSyncDone = false;
		this.sessionSyncFailures.clear();
		this.sessionSyncSkips.clear();
		this.lockToken = void 0;
		if (await wipeStoreDir({ dir: this.indexDir }) === "locked") throw new GlobalSearchError("readonly_index", "another process holds the search-index write lock; reindex from that process");
		await this.ensureOpen();
	}
	lifecycleState() {
		if (this.disposed) return { state: this.db === null ? "stopped" : "closing" };
		const db = this.db;
		if (db !== null) this.noteMaintenanceDetail(db);
		if (db === null) {
			if (this.openPromise !== null) return { state: "opening" };
			if (this.openError !== null) return {
				state: "degraded",
				detail: this.openError
			};
			return { state: "stopped" };
		}
		if (db.textIndexBuilding(TEXT_INDEX_NAME) || db.textIndexBuilding(TRI_INDEX_NAME)) return { state: "building" };
		return { state: "ready" };
	}
	maintenanceDetail(db) {
		const failure = db.lastCompactError ?? db.lastGenBuildError;
		return failure === null ? void 0 : errorMessage(failure);
	}
	noteMaintenanceDetail(db) {
		const detail = this.maintenanceDetail(db);
		if (detail === this.lastMaintenanceDetail) return;
		const previous = this.lastMaintenanceDetail;
		this.lastMaintenanceDetail = detail;
		if (detail !== void 0) this.log.warn("global search: index maintenance is failing; the WAL keeps growing until it recovers", { error: detail });
		else if (previous !== void 0) this.log.info("global search: index maintenance recovered");
	}
	async status() {
		await this.ensureOpen();
		if (this.db?.readOnly === true) await this.refresh();
		const stats = this.db?.get(STATS_KEY);
		const maintenance = this.db !== null ? this.maintenanceDetail(this.db) : void 0;
		return {
			sessions: stats?.kind === "stats" ? stats.sessions : 0,
			documents: stats?.kind === "stats" ? stats.documents : 0,
			lastIndexedAt: stats?.kind === "stats" ? stats.lastIndexedAt : null,
			generation: this.generation,
			readOnly: this.db?.readOnly === true,
			lockToken: this.lockToken,
			degraded: this.lastRefreshError?.message ?? maintenance ?? (stats?.kind === "stats" ? stats.degraded : void 0),
			lifecycle: this.lifecycleState()
		};
	}
	buildingView(db) {
		const handle = db ?? this.db;
		const stats = handle?.get(STATS_KEY);
		return {
			state: "building",
			indexedSessions: stats?.kind === "stats" ? stats.sessions : 0,
			documents: stats?.kind === "stats" ? stats.documents : 0,
			readOnly: handle?.readOnly === true,
			freshnessStale: true,
			degraded: this.lastRefreshError?.message ?? (stats?.kind === "stats" ? stats.degraded : void 0),
			lockToken: this.lockToken
		};
	}
	readIndexView(db, freshnessStale) {
		const stats = db.get(STATS_KEY);
		const indexed = stats?.kind === "stats" ? stats.sessions : 0;
		const documents = stats?.kind === "stats" ? stats.documents : 0;
		return {
			state: db.textIndexBuilding(TEXT_INDEX_NAME) || db.textIndexBuilding(TRI_INDEX_NAME) ? "building" : db.readOnly ? "readonly" : this.fullSyncDone ? "ready" : "building",
			indexedSessions: indexed,
			documents,
			readOnly: db.readOnly,
			freshnessStale,
			degraded: this.lastRefreshError?.message ?? (stats?.kind === "stats" ? stats.degraded : void 0),
			lockToken: this.lockToken
		};
	}
};
async function collectWireFiles(sessionDir) {
	const files = [];
	const root = join(sessionDir, WIRE_FILENAME);
	try {
		if ((await fs$1.stat(root)).isFile()) files.push({
			path: root,
			agentId: "main",
			source: "root"
		});
	} catch {}
	const agentsDir = join(sessionDir, "agents");
	try {
		const entries = await fs$1.readdir(agentsDir, {
			recursive: true,
			withFileTypes: true
		});
		for (const entry of entries) {
			if (!entry.isFile() || entry.name !== WIRE_FILENAME) continue;
			const path = join(entry.parentPath, entry.name);
			files.push({
				path,
				agentId: relative(agentsDir, entry.parentPath),
				source: "agents"
			});
		}
	} catch {}
	return files;
}
function docKeyPrefix(sessionId, file) {
	return `${sessionId}/${file.agentId}/${file.source}:`;
}
// ../../packages/kap-server/src/search/worker/entry.ts
const scope = globalThis;
const port = parentPort;
const queued = [];
let deliver = (message) => {
	queued.push(message);
};
if (port === null) scope.onmessage = (event) => {
	deliver(event.data);
};
else port.on("message", (message) => {
	deliver(message);
});
const data = await (scope.getEnvironmentData?.() ?? workerData ?? new Promise((resolve) => {
	deliver = (message) => {
		const value = message;
		if (value !== null && typeof value === "object" && value.type === "init") {
			resolve(value.params);
			return;
		}
		queued.push(value);
	};
}));
if (data === void 0 || data === null) throw new Error("search worker entry is missing its bootstrap data");
if (typeof data.textBuildWorkerPath === "string") try {
	configureTextBuildWorkerRuntime(data.textBuildWorkerPath);
} catch {}
const post = (event) => {
	try {
		if (port === null) scope.postMessage(event);
		else port.postMessage(event);
	} catch (error) {
		const detail = error instanceof Error ? error.stack ?? error.message : String(error);
		writeSync(2, `search worker failed to deliver a ${event.type} event: ${detail}\n`);
		process.exit(1);
	}
};
const core = new SearchIndexCore({
	indexDir: data.dir,
	bootSalt: data.bootSalt,
	log: {
		info: (message, meta) => {
			post({
				type: "log",
				level: "info",
				message,
				meta
			});
		},
		warn: (message, meta) => {
			post({
				type: "log",
				level: "warn",
				message,
				meta
			});
		}
	},
	onLockToken: (token) => {
		post({
			type: "lockToken",
			token
		});
	}
});
if (typeof data.syncSessionCap === "number") core.syncSessionCap = data.syncSessionCap;
function toErrorPayload(error) {
	if (error instanceof GlobalSearchError) return {
		message: error.message,
		reason: error.reason
	};
	return { message: error instanceof Error ? error.message : String(error) };
}
async function dispatch(request) {
	switch (request.type) {
		case "open":
			await core.ensureOpen();
			return {
				readOnly: core.db?.readOnly === true,
				lockToken: core.lockTokenView,
				lifecycle: core.lifecycleState()
			};
		case "search": return core.search(request.params);
		case "sync": return core.sync(request.params.sessions);
		case "refresh":
			await core.refresh();
			return {
				readOnly: core.db?.readOnly === true,
				lockToken: core.lockTokenView,
				lifecycle: core.lifecycleState()
			};
		case "reindex":
			await core.reindex();
			return {
				readOnly: core.db?.readOnly === true,
				lockToken: core.lockTokenView,
				lifecycle: core.lifecycleState()
			};
		case "status": return core.status();
		case "close": return null;
	}
}
const inFlight = /* @__PURE__ */ new Set();
let closing = false;
const CLOSE_DRAIN_BUDGET_MS = 2e3;
async function settleInFlight(budgetMs) {
	if (inFlight.size === 0) return;
	let timer;
	try {
		await Promise.race([Promise.all(inFlight), new Promise((resolve) => {
			timer = setTimeout(resolve, budgetMs);
			timer.unref?.();
		})]);
	} finally {
		if (timer !== void 0) clearTimeout(timer);
	}
}
async function handle(request) {
	if (request.v !== 1) {
		post({
			id: request.id,
			type: "error",
			error: { message: `search worker protocol mismatch: host v${request.v}, worker v1` }
		});
		return;
	}
	if (request.type === "close") {
		closing = true;
		core.beginClose();
		await settleInFlight(CLOSE_DRAIN_BUDGET_MS);
		let error = null;
		try {
			await core.close();
		} catch (closeError) {
			error = toErrorPayload(closeError);
		}
		if (error !== null) post({
			id: request.id,
			type: "error",
			error
		});
		else post({
			id: request.id,
			type: "result",
			result: null
		});
		process.exit(0);
	}
	if (closing) {
		post({
			id: request.id,
			type: "error",
			error: {
				message: "search service is disposed",
				reason: "index_unavailable"
			}
		});
		return;
	}
	try {
		const result = await dispatch(request);
		post({
			id: request.id,
			type: "result",
			result
		});
	} catch (error) {
		post({
			id: request.id,
			type: "error",
			error: toErrorPayload(error)
		});
	}
}
const accept = (value) => {
	const request = value;
	if (request === null || typeof request !== "object") return;
	if (request.type === "beginClose") {
		closing = true;
		core.beginClose();
		return;
	}
	if (typeof request.id !== "number" || typeof request.type !== "string") return;
	if (request.type === "close") {
		handle(request).catch(() => {});
		return;
	}
	const tracked = handle(request);
	inFlight.add(tracked);
	tracked.finally(() => {
		inFlight.delete(tracked);
	});
};
deliver = accept;
post({
	type: "ready",
	v: 1
});
for (const message of queued.splice(0)) accept(message);
export {};
