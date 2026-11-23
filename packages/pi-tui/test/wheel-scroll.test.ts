import { describe, it, expect } from "bun:test";
import { WheelScrollAccelerator } from "../src/wheel-scroll.ts";

function scroll(accelerator: WheelScrollAccelerator, times: number[], direction: -1 | 1 = 1): number[] {
	return times.map((time) => accelerator.next(direction, time));
}

// #9758: fullscreen wheel scrolling was one line per notch on terminals that do not accelerate wheels.
describe("WheelScrollAccelerator", () => {
	it("uses fixed line counts regardless of timing", () => {
		const accelerator = new WheelScrollAccelerator(3, true);
		expect(scroll(accelerator, [0, 10, 20, 1000])).toEqual([3, 3, 3, 3]);
		accelerator.setLines(0.5);
		expect(accelerator.next(1, 2000)).toBe(1);
	});

	it("keeps one line per event in auto mode when the terminal already accelerates", () => {
		const accelerator = new WheelScrollAccelerator("auto", false);
		expect(scroll(accelerator, [0, 10, 20, 30])).toEqual([1, 1, 1, 1]);
	});

	it("scales auto mode with wheel velocity", () => {
		const accelerator = new WheelScrollAccelerator("auto", true);
		expect(scroll(accelerator, [0, 150, 300, 450])).toEqual([1, 1, 1, 1]);
		expect(scroll(accelerator, [1000, 1050, 1100, 1150])).toEqual([1, 2, 2, 2]);
		expect(scroll(accelerator, [2000, 2020, 2040, 2060])).toEqual([1, 5, 5, 5]);
		expect(scroll(accelerator, [3000, 3010, 3020, 3030])).toEqual([1, 6, 6, 6]);
	});

	it("does not accelerate bursts of events for a single notch", () => {
		const accelerator = new WheelScrollAccelerator("auto", true);
		expect(scroll(accelerator, [0, 3, 6, 9])).toEqual([1, 1, 1, 1]);
	});

	it("resets acceleration on direction changes and pauses", () => {
		const accelerator = new WheelScrollAccelerator("auto", true);
		expect(scroll(accelerator, [0, 20, 40])).toEqual([1, 5, 5]);
		expect(accelerator.next(-1, 60)).toBe(1);
		expect(scroll(accelerator, [500, 520])).toEqual([1, 5]);
	});

	it("carries fractional lines between events", () => {
		const accelerator = new WheelScrollAccelerator("auto", true);
		expect(scroll(accelerator, [0, 40, 80, 120, 160])).toEqual([1, 2, 3, 2, 3]);
	});
});
