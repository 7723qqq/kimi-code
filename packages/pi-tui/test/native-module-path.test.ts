import assert from "node:assert";
import { dirname, join, resolve } from "node:path";
import { expect, describe, it } from "bun:test";
import { pathToFileURL } from "node:url";
import { getNativeModuleCandidates } from "../src/native-module-path.ts";

describe("getNativeModuleCandidates", () => {
	it("resolves native helpers from the installed TUI package when the module is bundled elsewhere", () => {
		const packageRoot = resolve("virtual", "node_modules", "@moonshot-ai", "pi-tui");
		const bundledModule = resolve("virtual", "pi-coding-agent", "dist", "bundle", "chunks", "chunk.js");
		const nativePath = join("native", "win32", "prebuilds", "win32-arm64", "win32-platform.node");

		const candidates = getNativeModuleCandidates(nativePath, {
			moduleUrl: pathToFileURL(bundledModule).href,
			execPath: resolve("virtual", "node", "node.exe"),
			resolvePackage: (specifier) => {
				expect(specifier).toBe("@moonshot-ai/pi-tui");
				return join(packageRoot, "dist", "index.js");
			},
		});

		expect(candidates[0]).toBe(join(packageRoot, nativePath));
		expect(candidates.includes(join(dirname(bundledModule), "..", nativePath))).toBeTruthy();
	});

	it("keeps standalone binary fallbacks when the TUI package is unavailable", () => {
		const bundledModule = resolve("virtual", "pi", "bundle", "chunks", "chunk.js");
		const execPath = resolve("virtual", "pi", "pi.exe");
		const nativePath = join("native", "darwin", "prebuilds", "darwin-arm64", "darwin-platform.node");

		const candidates = getNativeModuleCandidates(nativePath, {
			moduleUrl: pathToFileURL(bundledModule).href,
			execPath,
			resolvePackage: () => {
				throw new Error("not installed");
			},
		});

		expect(candidates).toStrictEqual([
			join(dirname(bundledModule), "..", nativePath),
			join(dirname(bundledModule), nativePath),
			join(dirname(execPath), nativePath),
		]);
	});
});
