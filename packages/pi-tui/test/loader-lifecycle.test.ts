import assert from "node:assert";
import { expect, describe, it } from "bun:test";
import { Loader } from "../src/components/loader.ts";
import type { TUI } from "../src/tui.ts";

/**
 * `Loader` arms its frame interval from the constructor (`setIndicator` calls `start`), so an
 * owner gets two guarantees from the component: the timer can never pin the host process open,
 * and there is a way to end the frames without waiting for the loader to be garbage collected.
 * These tests pin both. They use real timers on purpose — the handle captured here is the one
 * the runtime created, which is the object `unref()` has to have been called on.
 */

function createLoader(intervalMs = 5): { loader: Loader; repaints: { count: number } } {
	const repaints = { count: 0 };
	const ui = { requestRender: () => (repaints.count += 1) } as unknown as TUI;
	const loader = new Loader(ui, (s) => s, (s) => s, "Loading...", { intervalMs });
	return { loader, repaints };
}

/** Runs `build` with `setInterval` captured, and returns the timer the loader armed. */
function captureInterval(build: () => void): NodeJS.Timeout {
	type SetInterval = typeof globalThis.setInterval;
	const realSetInterval: SetInterval = globalThis.setInterval;
	let captured: NodeJS.Timeout | undefined;
	globalThis.setInterval = ((handler: () => void, timeout?: number) => {
		captured = realSetInterval(handler, timeout);
		return captured;
	}) as SetInterval;
	try {
		build();
	} finally {
		globalThis.setInterval = realSetInterval;
	}
	expect(captured, "the loader should have armed a frame interval").toBeTruthy();
	return captured;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("Loader frame-timer lifecycle", () => {
	it("arms a frame interval that does not keep the process alive", () => {
		let loader: Loader | undefined;
		const timer = captureInterval(() => {
			loader = createLoader().loader;
		});
		try {
			expect(timer.hasRef(), "a spinner must not be the reason its host process stays alive").toBe(false);
		} finally {
			loader?.dispose();
		}
	});

	it("stops repainting after dispose()", async () => {
		const { loader, repaints } = createLoader();
		await delay(30);
		expect(repaints.count > 0, "the loader should paint frames while it is running").toBeTruthy();

		loader.dispose();
		const painted = repaints.count;
		await delay(30);

		expect(repaints.count, "a disposed loader must not repaint").toBe(painted);
	});

	it("does not stack frame intervals when the indicator is replaced", async () => {
		type SetInterval = typeof globalThis.setInterval;
		type ClearInterval = typeof globalThis.clearInterval;
		const realSetInterval: SetInterval = globalThis.setInterval;
		const realClearInterval: ClearInterval = globalThis.clearInterval;
		let armed = 0;
		globalThis.setInterval = ((handler: () => void, timeout?: number) => {
			armed += 1;
			return realSetInterval(handler, timeout);
		}) as SetInterval;
		globalThis.clearInterval = ((timer) => {
			if (timer !== undefined) armed -= 1;
			return realClearInterval(timer);
		}) as ClearInterval;

		let loader: Loader;
		try {
			loader = createLoader().loader;
			loader.setIndicator({ frames: ["a", "b"], intervalMs: 5 });
			loader.setIndicator({ frames: ["a", "b", "c"], intervalMs: 5 });
		} finally {
			globalThis.setInterval = realSetInterval;
			globalThis.clearInterval = realClearInterval;
		}
		const live = armed;

		try {
			expect(live, "each new indicator must clear the interval it replaces").toBe(1);
			await delay(30);
		} finally {
			loader!.dispose();
		}
	});
});
