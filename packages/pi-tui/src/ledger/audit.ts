import { SGR_SEQUENCE } from "./types.ts";

const RESYNC_TAIL_LOOKBACK = 24;
const RESYNC_TAIL_SAMPLES = 8;

// OMP: 795-798
function rowsEquivalent(a: string, b: string): boolean {
	if (a === b) return true;
	return a.replace(SGR_SEQUENCE, "") === b.replace(SGR_SEQUENCE, "");
}

// OMP: 800-803
function isBlankRow(row: string): boolean {
	if (row.length === 0) return true;
	return row.replace(SGR_SEQUENCE, "").trim().length === 0;
}

// OMP: 848-906
export function findCommittedPrefixResync(
	frame: readonly string[],
	prefix: readonly string[],
	auditTo: number = prefix.length,
	exemptFrom: number = auditTo,
	exemptTo: number = exemptFrom,
	permanentEnd = 0,
): number {
	const committed = Math.min(prefix.length, Math.max(0, Math.trunc(auditTo)));
	if (committed === 0) return -1;
	const exFrom = Math.max(0, Math.min(committed, Math.trunc(exemptFrom)));
	const exTo = Math.max(exFrom, Math.min(committed, Math.trunc(exemptTo)));
	const audited = (i: number): boolean => i < exFrom || i >= exTo;
	if (frame.length >= committed) {
		const hardEnd = Math.min(committed, Math.max(0, Math.trunc(permanentEnd)));
		let hardMismatch = false;
		for (let i = exTo; i < hardEnd; i++) {
			if (!rowsEquivalent(frame[i]!, prefix[i]!)) {
				hardMismatch = true;
				break;
			}
		}
		if (!hardMismatch) {
			let samples = 0;
			let mismatches = 0;
			let scanned = 0;
			for (let j = 1; j <= committed && scanned < RESYNC_TAIL_LOOKBACK && samples < RESYNC_TAIL_SAMPLES; j++) {
				const idx = committed - j;
				if (!audited(idx)) continue;
				scanned++;
				const row = frame[idx]!;
				const old = prefix[idx]!;
				if (row === old) {
					if (!isBlankRow(row)) samples++;
					continue;
				}
				if (isBlankRow(row) && isBlankRow(old)) continue;
				samples++;
				if (!rowsEquivalent(row, old)) mismatches++;
			}
			if (samples === 0 || mismatches <= 1) return -1;
		}
	}
	const limit = Math.min(committed, frame.length);
	for (let i = 0; i < limit; i++) {
		if (!audited(i)) continue;
		if (!rowsEquivalent(frame[i]!, prefix[i]!)) return i;
	}
	return limit < committed ? limit : -1;
}
