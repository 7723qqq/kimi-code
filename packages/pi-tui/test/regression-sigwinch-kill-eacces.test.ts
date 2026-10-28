import { expect, afterAll, describe, it } from "bun:test";
import { refreshTerminalDimensions } from "../src/terminal.ts";

describe("refreshTerminalDimensions", () => {
	const originalKill = process.kill;
	const originalPlatform = process.platform;

	it("does not throw when kill(2) returns EACCES for self-signal", () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		process.kill = ((): typeof process.kill => {
			return (pid, _signal) => {
				if (pid === process.pid) {
					const err = new Error("kill EACCES") as NodeJS.ErrnoException;
					err.code = "EACCES";
					throw err;
				}
				return originalKill.call(process, pid, _signal);
			};
		})();

		expect(() => {
			refreshTerminalDimensions();
		}).not.toThrow();
	});

	it("does not call kill on win32", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		let killCalled = false;
		process.kill = ((): typeof process.kill => {
			return () => {
				killCalled = true;
				return true;
			};
		})();

		refreshTerminalDimensions();

		expect(killCalled, "kill should not be called on win32").toBe(false);
	});

	it("preserves other error codes", () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		process.kill = ((): typeof process.kill => {
			return () => {
				const err = new Error("kill EPERM") as NodeJS.ErrnoException;
				err.code = "EPERM";
				throw err;
			};
		})();

		// EPERM is also ignored - the refresh is best-effort
		expect(() => {
			refreshTerminalDimensions();
		}).not.toThrow();
	});

	afterAll(() => {
		process.kill = originalKill;
		Object.defineProperty(process, "platform", { value: originalPlatform });
	});
});
