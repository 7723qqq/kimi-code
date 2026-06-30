/**
 * Startup terminal-capability probe using a unified DA1 sentinel FIFO.
 *
 * Each probe writes a feature query immediately followed by a Primary Device
 * Attributes request (`CSI c`). The feature owner is pushed onto a FIFO before
 * the write. If the terminal supports the feature, its real reply arrives before
 * the DA1 reply and resolves the probe; the trailing DA1 is then a no-op. If the
 * terminal ignores the query, it still answers `CSI c`, so the DA1 drains the
 * owner and resolves it as inconclusive. The DA1 sentinel is therefore the
 * timeout for ignored probes.
 *
 * This is a Node-pure port of oh-my-pi's `ProcessTerminal` probe. OMP relies on
 * its StdinBuffer to pre-split replies into sequences; here {@link ProbeIO}
 * delivers raw stdin chunks, so the probe does its own CSI/OSC sequence
 * extraction (observe-only — it never consumes bytes from the input stream).
 */

/** Discriminated owner of an outstanding DA1 sentinel in the probe FIFO. */
type Da1SentinelOwner = { kind: "keyboard" } | { kind: "osc11" } | { kind: "privateMode"; mode: number };

export interface ProbeResult {
	kittyKeyboard: boolean;
	/** DECRQM ?2026 synchronized output. `undefined` means inconclusive. */
	syncOutput: boolean | undefined;
	/** DECRQM ?2048 in-band resize. `undefined` means inconclusive. */
	inBandResize: boolean | undefined;
	/** DECRQM ?2031 appearance-push notifications. `undefined` means inconclusive. */
	appearancePush: boolean | undefined;
	background: { r: number; g: number; b: number } | undefined;
}

export interface ProbeIO {
	write(data: string): void;
	/** Register a raw-reply observer. Returns an unsubscribe function. */
	onReply(cb: (data: string) => void): () => void;
}

interface Deferred<T> {
	promise: Promise<T>;
	/** Idempotent resolve — the first value wins. */
	resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	let resolved = false;
	return {
		promise,
		resolve(value: T) {
			if (resolved) return;
			resolved = true;
			resolve(value);
		},
	};
}

/** Maximum bytes held while waiting for a split CSI/OSC sequence to complete. */
const REPLY_BUFFER_CAP = 256;

/**
 * Convert a 1-4 digit XParseColor hex component to an 8-bit channel value.
 * The component's full width maps to 255 (e.g. "1e1e" → 30, "2e2e" → 46).
 */
function hexComponentToByte(hex: string): number {
	const value = Number.parseInt(hex, 16);
	if (Number.isNaN(value)) return 0;
	const max = 16 ** hex.length - 1;
	if (max <= 0) return 0;
	return Math.round((value * 255) / max);
}

const DECRPM_PATTERN = /^\x1b\[\?(\d+);(\d+)\$y$/;
const DA1_PATTERN = /^\x1b\[\?[\d;]*c$/;
const KITTY_PATTERN = /^\x1b\[\?(\d+)u$/;
const OSC11_PATTERN =
	/^\x1b\]11;rgba?:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})(?:\x07|\x1b\\)$/;

/**
 * Probe terminal capabilities by writing feature queries interleaved with DA1
 * sentinels and routing the replies through a FIFO.
 *
 * @param io - Raw write + reply-observer channel (typically stdout + a stdin tap).
 * @param opts.timeoutMs - Wall-clock ceiling per probe (default 300). This is the
 *   one deviation from OMP (which has no ceiling): it guarantees the promise
 *   resolves even on a terminal that ignores `CSI c` itself.
 */
export async function probeCapabilities(io: ProbeIO, opts?: { timeoutMs?: number }): Promise<ProbeResult> {
	const timeoutMs = opts?.timeoutMs ?? 300;

	const keyboard = createDeferred<boolean>();
	const background = createDeferred<{ r: number; g: number; b: number } | undefined>();
	const mode2026 = createDeferred<boolean | undefined>();
	const mode2048 = createDeferred<boolean | undefined>();
	const mode2031 = createDeferred<boolean | undefined>();

	const fifo: Da1SentinelOwner[] = [];
	let replyBuffer = "";
	const timers: ReturnType<typeof setTimeout>[] = [];

	const resolveMode = (mode: number, value: boolean | undefined): void => {
		if (mode === 2026) mode2026.resolve(value);
		else if (mode === 2048) mode2048.resolve(value);
		else if (mode === 2031) mode2031.resolve(value);
	};

	/** Resolve the owner drained by a DA1 sentinel as inconclusive/unsupported. */
	const resolveOwnerIgnored = (owner: Da1SentinelOwner): void => {
		switch (owner.kind) {
			case "keyboard":
				keyboard.resolve(false);
				break;
			case "osc11":
				background.resolve(undefined);
				break;
			case "privateMode":
				resolveMode(owner.mode, undefined);
				break;
		}
	};

	/** Route a fully-extracted sequence to the matching probe. */
	const handleSequence = (sequence: string): void => {
		// 1. DECRPM private-mode report: \x1b[?<mode>;<status>$y
		const decrpm = sequence.match(DECRPM_PATTERN);
		if (decrpm) {
			const mode = Number.parseInt(decrpm[1]!, 10);
			const status = decrpm[2]!;
			// status 0/4 = unsupported (not recognized / permanently reset);
			// 1/2/3 = supported (set / reset / permanently set).
			resolveMode(mode, status !== "0" && status !== "4");
			return;
		}
		// 2. DA1 sentinel: drain the FIFO head as ignored. A real reply for that
		// owner would have already resolved it (idempotent), so this is a no-op then.
		if (DA1_PATTERN.test(sequence)) {
			if (fifo.length > 0) {
				resolveOwnerIgnored(fifo.shift()!);
			}
			return;
		}
		// 3. Kitty keyboard protocol report: \x1b[?<flags>u — any reply implies support.
		if (KITTY_PATTERN.test(sequence)) {
			keyboard.resolve(true);
			return;
		}
		// 4. OSC 11 background color reply.
		const osc11 = sequence.match(OSC11_PATTERN);
		if (osc11) {
			background.resolve({
				r: hexComponentToByte(osc11[1]!),
				g: hexComponentToByte(osc11[2]!),
				b: hexComponentToByte(osc11[3]!),
			});
		}
	};

	/** Drain complete CSI/OSC sequences out of the reply buffer. */
	const drain = (): void => {
		while (replyBuffer.length > 0) {
			const esc = replyBuffer.indexOf("\x1b");
			if (esc === -1) {
				// No ESC: pure user input flowing past — observe-only, drop it.
				replyBuffer = "";
				return;
			}
			if (esc > 0) {
				replyBuffer = replyBuffer.slice(esc);
			}
			if (replyBuffer.length < 2) return; // lone ESC — wait for more

			const introducer = replyBuffer[1];
			if (introducer === "[") {
				// CSI: ESC [ + param bytes (0x30-0x3F) + intermediate (0x20-0x2F, incl. $)
				// + final byte (0x40-0x7E).
				let finalAt = -1;
				let invalid = false;
				for (let i = 2; i < replyBuffer.length; i++) {
					const c = replyBuffer.charCodeAt(i);
					if (c >= 0x40 && c <= 0x7e) {
						finalAt = i;
						break;
					}
					if ((c >= 0x30 && c <= 0x3f) || (c >= 0x20 && c <= 0x2f)) continue;
					invalid = true;
					break;
				}
				if (finalAt !== -1) {
					const sequence = replyBuffer.slice(0, finalAt + 1);
					replyBuffer = replyBuffer.slice(finalAt + 1);
					handleSequence(sequence);
					continue;
				}
				if (invalid) {
					// Malformed CSI — drop the single ESC and rescan (no wedge).
					replyBuffer = replyBuffer.slice(1);
					continue;
				}
				// Incomplete CSI — wait for more, unless the buffer is runaway.
				if (replyBuffer.length > REPLY_BUFFER_CAP) {
					replyBuffer = replyBuffer.slice(1);
					continue;
				}
				return;
			}
			if (introducer === "]") {
				// OSC: ESC ] + payload + (BEL | ST).
				const bel = replyBuffer.indexOf("\x07", 2);
				const st = replyBuffer.indexOf("\x1b\\", 2);
				let end = -1;
				let termLen = 1;
				if (bel !== -1 && (st === -1 || bel < st)) {
					end = bel;
					termLen = 1;
				} else if (st !== -1) {
					end = st;
					termLen = 2;
				}
				if (end === -1) {
					if (replyBuffer.length > REPLY_BUFFER_CAP) {
						replyBuffer = replyBuffer.slice(1);
						continue;
					}
					return;
				}
				const sequence = replyBuffer.slice(0, end + termLen);
				replyBuffer = replyBuffer.slice(end + termLen);
				handleSequence(sequence);
				continue;
			}
			// ESC followed by something else — drop the single ESC and rescan.
			replyBuffer = replyBuffer.slice(1);
		}
	};

	const onChunk = (data: string): void => {
		replyBuffer += data;
		drain();
	};

	// Subscribe BEFORE writing so a fast terminal cannot race the listener.
	const off = io.onReply(onChunk);
	try {
		const send = (owner: Da1SentinelOwner, data: string, onTimeout: () => void): void => {
			fifo.push(owner);
			io.write(data);
			timers.push(setTimeout(onTimeout, timeoutMs));
		};
		send({ kind: "keyboard" }, "\x1b[?u\x1b[c", () => keyboard.resolve(false));
		send({ kind: "osc11" }, "\x1b]11;?\x07\x1b[c", () => background.resolve(undefined));
		send({ kind: "privateMode", mode: 2026 }, "\x1b[?2026$p\x1b[c", () => mode2026.resolve(undefined));
		send({ kind: "privateMode", mode: 2048 }, "\x1b[?2048$p\x1b[c", () => mode2048.resolve(undefined));
		send({ kind: "privateMode", mode: 2031 }, "\x1b[?2031$p\x1b[c", () => mode2031.resolve(undefined));

		const [kittyKeyboard, bg, syncOutput, inBandResize, appearancePush] = await Promise.all([
			keyboard.promise,
			background.promise,
			mode2026.promise,
			mode2048.promise,
			mode2031.promise,
		]);
		return { kittyKeyboard, syncOutput, inBandResize, appearancePush, background: bg };
	} finally {
		off();
		for (const timer of timers) clearTimeout(timer);
	}
}
