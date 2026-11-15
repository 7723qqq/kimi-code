import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { type AnimationClock, AnimationFrameScheduler } from '../src/animation-frame.ts';
import type { TUI } from '../src/tui.ts';
import { TuiMainScreen } from '../src/tui-main-screen.ts';
import { VirtualTerminal } from './virtual-terminal.ts';

class ManualClock implements AnimationClock {
	private time = 0;
	private nextId = 1;
	private readonly timers = new Map<number, { readonly due: number; readonly callback: () => void }>();

	get pendingTimers(): number {
		return this.timers.size;
	}

	now(): number {
		return this.time;
	}

	setTimeout(callback: () => void, delayMs: number): unknown {
		const id = this.nextId++;
		this.timers.set(id, { due: this.time + delayMs, callback });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.timers.delete(handle as number);
	}

	advance(ms: number): void {
		const end = this.time + ms;
		for (let next = this.earliest(); next !== undefined && next[1].due <= end; next = this.earliest()) {
			this.timers.delete(next[0]);
			this.time = Math.max(this.time, next[1].due);
			next[1].callback();
		}
		this.time = end;
	}

	/** Fires the earliest timer at `time`, which may be before its due time or long after it. */
	runNextTimerAt(time: number): void {
		const next = this.earliest();
		if (next === undefined) throw new Error('no pending timer');
		this.timers.delete(next[0]);
		this.time = time;
		next[1].callback();
	}

	private earliest(): [number, { readonly due: number; readonly callback: () => void }] | undefined {
		let earliest: [number, { readonly due: number; readonly callback: () => void }] | undefined;
		for (const entry of this.timers) {
			if (earliest === undefined || entry[1].due < earliest[1].due) earliest = entry;
		}
		return earliest;
	}
}

function animatedTui(): { clock: ManualClock; tui: TUI } {
	const clock = new ManualClock();
	return { clock, tui: new TuiMainScreen(new VirtualTerminal(40, 10), undefined, undefined, clock) };
}

describe('TUI animation frames', () => {
	it('runs every request of a frame once with the same timestamp on the frame grid', () => {
		const { clock, tui } = animatedTui();
		clock.advance(50);
		const times: number[] = [];
		tui.requestAnimationFrame((time) => times.push(time));
		tui.requestAnimationFrame((time) => times.push(time));

		clock.advance(69);
		expect(times).toEqual([]);
		clock.advance(1);
		expect(times).toEqual([120, 120]);
		clock.advance(1000);
		expect(times).toEqual([120, 120]);
		expect(clock.pendingTimers).toBe(0);
	});

	it('runs a request made inside a callback on the next frame', () => {
		const { clock, tui } = animatedTui();
		const times: number[] = [];
		const step = (time: number): void => {
			times.push(time);
			if (times.length < 3) tui.requestAnimationFrame(step);
		};
		tui.requestAnimationFrame(step);

		clock.advance(120);
		expect(times).toEqual([120]);
		clock.advance(240);
		expect(times).toEqual([120, 240, 360]);
		expect(clock.pendingTimers).toBe(0);
	});

	it('keeps no timer without requests and ignores repeated and unknown cancels', () => {
		const { clock, tui } = animatedTui();
		const calls: string[] = [];
		expect(clock.pendingTimers).toBe(0);

		const first = tui.requestAnimationFrame(() => calls.push('first'));
		let third = 0;
		tui.requestAnimationFrame(() => {
			calls.push('second');
			tui.cancelAnimationFrame(third);
		});
		third = tui.requestAnimationFrame(() => calls.push('third'));
		expect(clock.pendingTimers).toBe(1);
		tui.cancelAnimationFrame(first);
		tui.cancelAnimationFrame(first);
		tui.cancelAnimationFrame(12345);
		clock.advance(120);
		expect(calls).toEqual(['second']);
		expect(clock.pendingTimers).toBe(0);

		tui.cancelAnimationFrame(tui.requestAnimationFrame(() => calls.push('fourth')));
		expect(clock.pendingTimers).toBe(0);
		clock.advance(1000);
		expect(calls).toEqual(['second']);
	});

	it('keeps the grid timestamp when a timer fires early or late and skips missed frames', () => {
		const { clock, tui } = animatedTui();
		const times: number[] = [];
		const step = (time: number): void => {
			times.push(time);
			if (times.length < 3) tui.requestAnimationFrame(step);
		};
		tui.requestAnimationFrame(step);

		clock.runNextTimerAt(118);
		expect(times).toEqual([120]);
		clock.runNextTimerAt(370);
		expect(times).toEqual([120, 360]);
		clock.advance(109);
		expect(times).toEqual([120, 360]);
		clock.advance(1);
		expect(times).toEqual([120, 360, 480]);
	});

	it('pauses on stop and resumes on the next frame after start without replaying missed frames', () => {
		const { clock, tui } = animatedTui();
		tui.start();
		const times: number[] = [];
		const step = (time: number): void => {
			times.push(time);
			tui.requestAnimationFrame(step);
		};
		tui.requestAnimationFrame(step);
		clock.advance(120);
		expect(times).toEqual([120]);

		tui.stop();
		expect(clock.pendingTimers).toBe(0);
		clock.advance(1000);
		expect(times).toEqual([120]);

		tui.start();
		clock.advance(79);
		expect(times).toEqual([120]);
		clock.advance(1);
		expect(times).toEqual([120, 1200]);
		tui.stop();
	});

	it('runs the other callbacks and later frames when a callback throws, then rethrows the first error', () => {
		const queued: (() => void)[] = [];
		const originalQueueMicrotask = globalThis.queueMicrotask;
		globalThis.queueMicrotask = (callback: () => void) => {
			queued.push(callback);
		};
		try {
			const { clock, tui } = animatedTui();
			const calls: string[] = [];
			tui.requestAnimationFrame(() => {
				throw new Error('first failure');
			});
			tui.requestAnimationFrame(() => {
				throw new Error('second failure');
			});
			tui.requestAnimationFrame((time) => {
				calls.push(`frame ${time}`);
				tui.requestAnimationFrame((next) => calls.push(`frame ${next}`));
			});

			clock.advance(120);
			expect(calls).toEqual(['frame 120']);
			expect(queued).toHaveLength(1);
			expect(() => queued[0]?.()).toThrow('first failure');
			clock.advance(120);
			expect(calls).toEqual(['frame 120', 'frame 240']);
		} finally {
			globalThis.queueMicrotask = originalQueueMicrotask;
		}
	});

	it('lets the process exit while a callback keeps requesting frames', () => {
		const scheduler = new URL('../src/animation-frame.ts', import.meta.url).href;
		const dir = mkdtempSync(join(tmpdir(), 'pi-tui-animation-'));
		const scriptPath = join(dir, 'frames.ts');
		writeFileSync(
			scriptPath,
			`import { AnimationFrameScheduler } from ${JSON.stringify(scheduler)};
const frames = new AnimationFrameScheduler();
let count = 0;
const step = (): void => {
	count += 1;
	frames.requestAnimationFrame(step);
};
frames.requestAnimationFrame(step);
setTimeout(() => console.log(count), 500);
`,
		);
		try {
			const child = spawnSync(process.execPath, [scriptPath], {
				encoding: 'utf8',
				timeout: 10_000,
			});

			expect(child.signal).toBeNull();
			expect(child.status).toBe(0);
			expect(Number(child.stdout)).toBeGreaterThanOrEqual(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('keeps the timers and clock it was created with when the globals are replaced later', async () => {
		const frames = new AnimationFrameScheduler();
		const originalSetTimeout = globalThis.setTimeout;
		const originalNow = performance.now;
		let replacedSetTimeoutCalls = 0;
		let replacedNowCalls = 0;
		globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
			replacedSetTimeoutCalls += 1;
			return originalSetTimeout(...args);
		}) as typeof setTimeout;
		performance.now = () => {
			replacedNowCalls += 1;
			return originalNow.call(performance);
		};
		try {
			await new Promise((resolve) => frames.requestAnimationFrame(resolve));
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			performance.now = originalNow;
		}

		expect(replacedSetTimeoutCalls).toBe(0);
		expect(replacedNowCalls).toBe(0);
	});
});
