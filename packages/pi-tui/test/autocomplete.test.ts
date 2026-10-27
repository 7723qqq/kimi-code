import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, afterEach, beforeEach, describe, it, test } from "bun:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";

const resolveFdPath = (): string | null => {
	const command = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(command, ["fd"], { encoding: "utf-8" });
	if (result.status !== 0 || !result.stdout) {
		return null;
	}

	const firstLine = result.stdout.split(/\r?\n/).find(Boolean);
	return firstLine ? firstLine.trim() : null;
};

type FolderStructure = {
	dirs?: string[];
	files?: Record<string, string>;
};

const setupFolder = (baseDir: string, structure: FolderStructure = {}): void => {
	const dirs = structure.dirs ?? [];
	const files = structure.files ?? {};

	dirs.forEach((dir) => {
		mkdirSync(join(baseDir, dir), { recursive: true });
	});
	Object.entries(files).forEach(([filePath, contents]) => {
		const fullPath = join(baseDir, filePath);
		mkdirSync(dirname(fullPath), { recursive: true });
		writeFileSync(fullPath, contents);
	});
};

const fdPath = resolveFdPath();
const isFdInstalled = Boolean(fdPath);

// Windows only grants SeCreateSymbolicLinkPrivilege to elevated processes and
// to machines with Developer Mode enabled; the symlink tests cannot be set up
// without it, so probe instead of assuming.
const canCreateSymlinks = (() => {
	const probeDir = mkdtempSync(join(tmpdir(), "pi-symlink-probe-"));
	try {
		writeFileSync(join(probeDir, "target.txt"), "");
		symlinkSync(join(probeDir, "target.txt"), join(probeDir, "link.txt"));
		return true;
	} catch {
		return false;
	} finally {
		rmSync(probeDir, { recursive: true, force: true });
	}
})();

const requireFdPath = (): string => {
	if (!fdPath) {
		throw new Error("fd is not available");
	}
	return fdPath;
};

const getSuggestions = (
	provider: CombinedAutocompleteProvider,
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	force: boolean = false,
) => provider.getSuggestions(lines, cursorLine, cursorCol, { signal: new AbortController().signal, force });

describe("CombinedAutocompleteProvider", () => {
	describe("extractPathPrefix", () => {
		it("extracts / from 'hey /' when forced", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["hey /"];
			const cursorLine = 0;
			const cursorCol = 5; // After the "/"

			const result = await getSuggestions(provider, lines, cursorLine, cursorCol, true);

			expect(result, "Should return suggestions for root directory").not.toBe(null);
			if (result) {
				expect(result.prefix, "Prefix should be '/'").toBe("/");
			}
		});

		it("extracts /A from '/A' when forced", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["/A"];
			const cursorLine = 0;
			const cursorCol = 2; // After the "A"

			const result = await getSuggestions(provider, lines, cursorLine, cursorCol, true);

			console.log("Result:", result);
			// This might return null if /A doesn't match anything, which is fine
			// We're mainly testing that the prefix extraction works
			if (result) {
				expect(result.prefix, "Prefix should be '/A'").toBe("/A");
			}
		});

		it("does not trigger for slash commands", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["/model"];
			const cursorLine = 0;
			const cursorCol = 6; // After "model"

			const result = await getSuggestions(provider, lines, cursorLine, cursorCol, true);

			console.log("Result:", result);
			expect(result, "Should not trigger for slash commands").toBe(null);
		});

		it("triggers for absolute paths after slash command argument", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["/command /"];
			const cursorLine = 0;
			const cursorCol = 10; // After the second "/"

			const result = await getSuggestions(provider, lines, cursorLine, cursorCol, true);

			console.log("Result:", result);
			expect(result, "Should trigger for absolute paths in command arguments").not.toBe(null);
			if (result) {
				expect(result.prefix, "Prefix should be '/'").toBe("/");
			}
		});
	});

	describe.skipIf(!isFdInstalled)("fd @ file suggestions", () => {
		let rootDir = "";
		let baseDir = "";
		let outsideDir = "";

		beforeEach(() => {
			rootDir = mkdtempSync(join(tmpdir(), "pi-autocomplete-root-"));
			baseDir = join(rootDir, "cwd");
			outsideDir = join(rootDir, "outside");
			mkdirSync(baseDir, { recursive: true });
			mkdirSync(outsideDir, { recursive: true });
		});

		afterEach(() => {
			rmSync(rootDir, { recursive: true, force: true });
		});

		test("returns all files and folders for empty @ query", async () => {
			setupFolder(baseDir, {
				dirs: ["src"],
				files: {
					"README.md": "readme",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value).sort();
			expect(values).toStrictEqual(["@README.md", "@src/"].sort());
		});

		test("matches file with extension in query", async () => {
			setupFolder(baseDir, {
				files: {
					"file.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@file.txt";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value);
			expect(values?.includes("@file.txt")).toBeTruthy();
		});

		test("filters are case insensitive", async () => {
			setupFolder(baseDir, {
				dirs: ["src"],
				files: {
					"README.md": "readme",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@re";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value).sort();
			expect(values).toStrictEqual(["@README.md"]);
		});

		test("ranks directories before files", async () => {
			setupFolder(baseDir, {
				dirs: ["src"],
				files: {
					"src.txt": "text",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@src";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const firstValue = result?.items[0]?.value;
			const hasSrcFile = result?.items?.some((item) => item.value === "@src.txt");
			expect(firstValue).toBe("@src/");
			expect(hasSrcFile).toBeTruthy();
		});

		test("returns nested file paths", async () => {
			setupFolder(baseDir, {
				files: {
					"src/index.ts": "export {};\n",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@index";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value);
			expect(values?.includes("@src/index.ts")).toBeTruthy();
		});

		test("matches deeply nested paths", async () => {
			setupFolder(baseDir, {
				files: {
					"packages/tui/src/autocomplete.ts": "export {};",
					"packages/ai/src/autocomplete.ts": "export {};",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@tui/src/auto";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value);
			expect(values?.includes("@packages/tui/src/autocomplete.ts")).toBeTruthy();
			expect(!values?.includes("@packages/ai/src/autocomplete.ts")).toBeTruthy();
		});

		test("searches additional base paths with fd for @ mentions", async () => {
			setupFolder(baseDir, {
				files: { "shared-cwd.ts": "export {};" },
			});
			setupFolder(outsideDir, {
				files: { "shared-extra.ts": "export {};" },
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath(), [outsideDir]);
			const result = await getSuggestions(provider, ["@shared"], 0, 7);

			const values = result?.items.map((item) => item.value) ?? [];
			expect(values.includes("@shared-cwd.ts")).toBeTruthy();
			expect(values.includes(`@${join(outsideDir, "shared-extra.ts").replace(/\\/g, "/")}`)).toBeTruthy();
		});

		test("scopes @dir/ queries across every root", async () => {
			setupFolder(baseDir, {
				files: { "sub/cwd-file.ts": "export {};" },
			});
			setupFolder(outsideDir, {
				files: { "sub/extra-file.ts": "export {};" },
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath(), [outsideDir]);
			const result = await getSuggestions(provider, ["@sub/file"], 0, 9);

			const values = result?.items.map((item) => item.value) ?? [];
			expect(values.includes("@sub/cwd-file.ts")).toBeTruthy();
			expect(values.includes(`@${join(outsideDir, "sub", "extra-file.ts").replace(/\\/g, "/")}`)).toBeTruthy();
		});

		test("deduplicates entries when an additional root is inside cwd", async () => {
			const nestedDir = join(baseDir, "extra");
			setupFolder(nestedDir, {
				files: { "Overlap.ts": "export {};" },
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath(), [nestedDir]);
			const result = await getSuggestions(provider, ["@overlap"], 0, 8);

			const values = result?.items.map((item) => item.value) ?? [];
			const absValue = `@${join(nestedDir, "Overlap.ts").replace(/\\/g, "/")}`;
			const relValue = "@extra/Overlap.ts";
			const overlapCount = values.filter((v) => v === absValue || v === relValue).length;
			expect(overlapCount).toBe(1);
		});

		test("merges empty @ query across roots within the result cap", async () => {
			const cwdFiles: Record<string, string> = {};
			for (let i = 0; i < 15; i++) cwdFiles[`f${i}.ts`] = "export {};";
			setupFolder(baseDir, { files: cwdFiles });
			const extraFiles: Record<string, string> = {};
			for (let i = 0; i < 15; i++) extraFiles[`g${i}.ts`] = "export {};";
			setupFolder(outsideDir, { files: extraFiles });

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath(), [outsideDir]);
			const result = await getSuggestions(provider, ["@"], 0, 1);

			const count = result?.items.length ?? 0;
			expect(count <= 20, `expected <= 20 items, got ${count}`).toBeTruthy();
			expect(count > 0).toBeTruthy();
		});

		test("falls back to full-path per root when another root has the scoped directory", async () => {
			setupFolder(baseDir, {
				files: { "packages/tui/src/autocomplete.ts": "export {};" },
			});
			// outsideDir has a top-level src/ but no matching file; a global fallback
			// would skip cwd's full-path search entirely and hide the cwd match.
			setupFolder(outsideDir, {
				files: { "src/other.ts": "export {};" },
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath(), [outsideDir]);
			const result = await getSuggestions(provider, ["@src/auto"], 0, 9);

			const values = result?.items.map((item) => item.value) ?? [];
			expect(values.includes("@packages/tui/src/autocomplete.ts")).toBeTruthy();
		});

		test("matches directory in middle of path with --full-path", async () => {
			setupFolder(baseDir, {
				files: {
					"src/components/Button.tsx": "export {};",
					"src/utils/helpers.ts": "export {};",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@components/";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value);
			expect(values?.includes("@src/components/Button.tsx")).toBeTruthy();
			expect(!values?.includes("@src/utils/helpers.ts")).toBeTruthy();
		});

		test("scopes fuzzy search to relative directories and searches recursively", async () => {
			setupFolder(outsideDir, {
				files: {
					"nested/alpha.ts": "export {};",
					"nested/deeper/also-alpha.ts": "export {};",
					"nested/deeper/zzz.ts": "export {};",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@../outside/a";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value);
			expect(values?.includes("@../outside/nested/alpha.ts")).toBeTruthy();
			expect(values?.includes("@../outside/nested/deeper/also-alpha.ts")).toBeTruthy();
			expect(!values?.includes("@../outside/nested/deeper/zzz.ts")).toBeTruthy();
		});

		test("ranks shallower same-score @ matches before deeper matches", async () => {
			setupFolder(baseDir, {
				dirs: ["scope/aaa/venv/lib/python3.12/site-packages/pkg/core/profile", "scope/projects"],
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@scope/pro";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value) ?? [];
			expect(values[0]).toBe("@scope/projects/");
			expect(values.includes("@scope/aaa/venv/lib/python3.12/site-packages/pkg/core/profile/")).toBeTruthy();
		});

		test("includes scoped direct children when recursive @ matches are flooded", async () => {
			const floodedDirs = Array.from(
				{ length: 250 },
				(_, index) =>
					`scope/a${String(index + 1).padStart(3, "0")}/venv/lib/python3.12/site-packages/pkg/core/profile`,
			);
			setupFolder(baseDir, {
				dirs: ["scope/projects", ...floodedDirs],
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@scope/pro";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value) ?? [];
			expect(values[0]).toBe("@scope/projects/");
			expect(values.some((value) => value.includes("/profile/")), "Should keep deep fuzzy matches after direct children").toBeTruthy();
		});

		test("quotes paths with spaces for @ suggestions", async () => {
			setupFolder(baseDir, {
				dirs: ["my folder"],
				files: {
					"my folder/test.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@my";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value);
			expect(values?.includes('@"my folder/"')).toBeTruthy();
		});

		test("includes hidden paths but excludes .git", async () => {
			setupFolder(baseDir, {
				dirs: [".pi", ".github", ".git"],
				files: {
					".pi/config.json": "{}",
					".github/workflows/ci.yml": "name: ci",
					".git/config": "[core]",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value) ?? [];
			expect(values.includes("@.pi/")).toBeTruthy();
			expect(values.includes("@.github/")).toBeTruthy();
			expect(!values.some((value) => value === "@.git" || value.startsWith("@.git/"))).toBeTruthy();
		});

		test.skipIf(!canCreateSymlinks)("follows symlinked directories for fuzzy @ search", async () => {
			setupFolder(baseDir, {
				files: {
					"dir/some_file.txt": "real",
				},
			});
			setupFolder(outsideDir, {
				files: {
					"some_file.txt": "symlinked",
				},
			});
			symlinkSync("../outside", join(baseDir, "symlinked_dir"));

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@some";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value) ?? [];
			expect(values.includes("@dir/some_file.txt")).toBeTruthy();
			expect(values.includes("@symlinked_dir/some_file.txt")).toBeTruthy();
		});

		test.skipIf(!canCreateSymlinks)("returns symlinked directories when matching their name", async () => {
			setupFolder(outsideDir, {
				files: {
					"nested/file.txt": "symlinked",
				},
			});
			symlinkSync("../outside", join(baseDir, "symlinked_dir"));

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@symlinked";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value) ?? [];
			expect(values.includes("@symlinked_dir/")).toBeTruthy();
		});

		test.skipIf(!canCreateSymlinks)("returns symlinked files without requiring type l", async () => {
			setupFolder(baseDir, {
				files: {
					"original.txt": "content",
				},
			});
			const linkPath = join(baseDir, "link.txt");
			symlinkSync("original.txt", linkPath);

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@link";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value) ?? [];
			expect(values.includes("@link.txt")).toBeTruthy();
		});

		test("returns the same @ suggestions when the cwd path contains the query", async () => {
			const normalBaseDir = join(rootDir, "cwd-normal");
			const queryInPathBaseDir = join(rootDir, "cwd-plan-repro");
			mkdirSync(normalBaseDir, { recursive: true });
			mkdirSync(queryInPathBaseDir, { recursive: true });

			const structure = {
				dirs: ["packages/coding-agent/examples/extensions/plan-mode"],
				files: {
					"packages/coding-agent/examples/extensions/plan-mode/README.md": "readme",
					"packages/tui/docs/plan.md": "plan",
				},
			};
			setupFolder(normalBaseDir, structure);
			setupFolder(queryInPathBaseDir, structure);

			const query = "@plan";
			const normalProvider = new CombinedAutocompleteProvider([], normalBaseDir, requireFdPath());
			const queryInPathProvider = new CombinedAutocompleteProvider([], queryInPathBaseDir, requireFdPath());

			const normalResult = await getSuggestions(normalProvider, [query], 0, query.length);
			const queryInPathResult = await getSuggestions(queryInPathProvider, [query], 0, query.length);

			const normalize = (result: Awaited<ReturnType<typeof getSuggestions>>) =>
				(result?.items ?? []).map((item) => `${item.label} :: ${item.description ?? ""}`).sort();

			expect(normalize(queryInPathResult)).toStrictEqual(normalize(normalResult));
			expect(normalize(normalResult).includes("plan-mode/ :: packages/coding-agent/examples/extensions/plan-mode")).toBeTruthy();
			expect(normalize(normalResult).includes("plan.md :: packages/tui/docs/plan.md")).toBeTruthy();
		});

		test("continues autocomplete inside quoted @ paths", async () => {
			setupFolder(baseDir, {
				files: {
					"my folder/test.txt": "content",
					"my folder/other.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = '@"my folder/"';
			const result = await getSuggestions(provider, [line], 0, line.length - 1);

			expect(result, "Should return suggestions for quoted folder path").not.toBe(null);
			const values = result?.items.map((item) => item.value);
			expect(values?.includes('@"my folder/test.txt"')).toBeTruthy();
			expect(values?.includes('@"my folder/other.txt"')).toBeTruthy();
		});

		test("applies quoted @ completion without duplicating closing quote", async () => {
			setupFolder(baseDir, {
				files: {
					"my folder/test.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = '@"my folder/te"';
			const cursorCol = line.length - 1;
			const result = await getSuggestions(provider, [line], 0, cursorCol);

			expect(result, "Should return suggestions for quoted @ path").not.toBe(null);
			const item = result?.items.find((entry) => entry.value === '@"my folder/test.txt"');
			expect(item, "Should find test.txt suggestion").toBeTruthy();

			const applied = provider.applyCompletion([line], 0, cursorCol, item!, result!.prefix);
			expect(applied.lines[0]).toBe('@"my folder/test.txt" ');
		});
	});

	describe("dot-slash path completion", () => {
		let baseDir = "";

		beforeEach(() => {
			baseDir = mkdtempSync(join(tmpdir(), "pi-autocomplete-"));
		});

		afterEach(() => {
			rmSync(baseDir, { recursive: true, force: true });
		});

		test("preserves ./ prefix when completing paths", async () => {
			setupFolder(baseDir, {
				files: {
					"update.sh": "#!/bin/bash",
					"utils.ts": "export {};",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "./up";
			const result = await getSuggestions(provider, [line], 0, line.length, true);

			expect(result, "Should return suggestions for ./ path").not.toBe(null);
			const values = result?.items.map((item) => item.value);
			expect(values?.includes("./update.sh"), `Expected ./update.sh in ${JSON.stringify(values)}`).toBeTruthy();
		});

		test("preserves ./ prefix for directory completions", async () => {
			setupFolder(baseDir, {
				dirs: ["src"],
				files: {
					"src/index.ts": "export {};",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "./sr";
			const result = await getSuggestions(provider, [line], 0, line.length, true);

			expect(result, "Should return suggestions for ./ directory path").not.toBe(null);
			const values = result?.items.map((item) => item.value);
			expect(values?.includes("./src/"), `Expected ./src/ in ${JSON.stringify(values)}`).toBeTruthy();
		});
	});

	describe("quoted path completion", () => {
		let baseDir = "";

		beforeEach(() => {
			baseDir = mkdtempSync(join(tmpdir(), "pi-autocomplete-"));
		});

		afterEach(() => {
			rmSync(baseDir, { recursive: true, force: true });
		});

		test("quotes paths with spaces for direct completion", async () => {
			setupFolder(baseDir, {
				dirs: ["my folder"],
				files: {
					"my folder/test.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "my";
			const result = await getSuggestions(provider, [line], 0, line.length, true);

			expect(result, "Should return suggestions for path completion").not.toBe(null);
			const values = result?.items.map((item) => item.value);
			expect(values?.includes('"my folder/"')).toBeTruthy();
		});

		test("continues completion inside quoted paths", async () => {
			setupFolder(baseDir, {
				files: {
					"my folder/test.txt": "content",
					"my folder/other.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = '"my folder/"';
			const result = await getSuggestions(provider, [line], 0, line.length - 1, true);

			expect(result, "Should return suggestions for quoted folder path").not.toBe(null);
			const values = result?.items.map((item) => item.value);
			expect(values?.includes('"my folder/test.txt"')).toBeTruthy();
			expect(values?.includes('"my folder/other.txt"')).toBeTruthy();
		});

		test("applies quoted completion without duplicating closing quote", async () => {
			setupFolder(baseDir, {
				files: {
					"my folder/test.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = '"my folder/te"';
			const cursorCol = line.length - 1;
			const result = await getSuggestions(provider, [line], 0, cursorCol, true);

			expect(result, "Should return suggestions for quoted path").not.toBe(null);
			const item = result?.items.find((entry) => entry.value === '"my folder/test.txt"');
			expect(item, "Should find test.txt suggestion").toBeTruthy();

			const applied = provider.applyCompletion([line], 0, cursorCol, item!, result!.prefix);
			expect(applied.lines[0]).toBe('"my folder/test.txt"');
		});
	});
});
