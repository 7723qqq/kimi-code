import assert from "node:assert";
import { expect, describe, it } from "bun:test";
import { fuzzyFilter, fuzzyMatch } from "../src/fuzzy.ts";

describe("fuzzyMatch", () => {
	it("empty query matches everything with score 0", () => {
		const result = fuzzyMatch("", "anything");
		expect(result.matches).toBe(true);
		expect(result.score).toBe(0);
	});

	it("query longer than text does not match", () => {
		const result = fuzzyMatch("longquery", "short");
		expect(result.matches).toBe(false);
	});

	it("exact match has good score", () => {
		const result = fuzzyMatch("test", "test");
		expect(result.matches).toBe(true);
		expect(result.score < 0).toBeTruthy(); // Should be negative due to consecutive bonuses
	});

	it("characters must appear in order", () => {
		const matchInOrder = fuzzyMatch("abc", "aXbXc");
		expect(matchInOrder.matches).toBe(true);

		const matchOutOfOrder = fuzzyMatch("abc", "cba");
		expect(matchOutOfOrder.matches).toBe(false);
	});

	it("case insensitive matching", () => {
		const result = fuzzyMatch("ABC", "abc");
		expect(result.matches).toBe(true);

		const result2 = fuzzyMatch("abc", "ABC");
		expect(result2.matches).toBe(true);
	});

	it("consecutive matches score better than scattered matches", () => {
		const consecutive = fuzzyMatch("foo", "foobar");
		const scattered = fuzzyMatch("foo", "f_o_o_bar");

		expect(consecutive.matches).toBe(true);
		expect(scattered.matches).toBe(true);
		expect(consecutive.score < scattered.score).toBeTruthy();
	});

	it("word boundary matches score better", () => {
		const atBoundary = fuzzyMatch("fb", "foo-bar");
		const notAtBoundary = fuzzyMatch("fb", "afbx");

		expect(atBoundary.matches).toBe(true);
		expect(notAtBoundary.matches).toBe(true);
		expect(atBoundary.score < notAtBoundary.score).toBeTruthy();
	});

	it("matches swapped alpha numeric tokens", () => {
		const result = fuzzyMatch("codex52", "gpt-5.2-codex");
		expect(result.matches).toBe(true);
	});
});

describe("fuzzyFilter", () => {
	it("empty query returns all items unchanged", () => {
		const items = ["apple", "banana", "cherry"];
		const result = fuzzyFilter(items, "", (x: string) => x);
		expect(result).toStrictEqual(items);
	});

	it("filters out non-matching items", () => {
		const items = ["apple", "banana", "cherry"];
		const result = fuzzyFilter(items, "an", (x: string) => x);
		expect(result.includes("banana")).toBeTruthy();
		expect(!result.includes("apple")).toBeTruthy();
		expect(!result.includes("cherry")).toBeTruthy();
	});

	it("sorts results by match quality", () => {
		const items = ["a_p_p", "app", "application"];
		const result = fuzzyFilter(items, "app", (x: string) => x);

		// "app" should be first (exact consecutive match at start)
		expect(result[0]).toBe("app");
	});

	it("prioritizes exact matches over longer prefix matches", () => {
		const items = ["clone", "cl"];
		const result = fuzzyFilter(items, "cl", (x: string) => x);

		expect(result).toStrictEqual(["cl", "clone"]);
	});

	it("works with custom getText function", () => {
		const items = [
			{ name: "foo", id: 1 },
			{ name: "bar", id: 2 },
			{ name: "foobar", id: 3 },
		];
		const result = fuzzyFilter(items, "foo", (item: { name: string; id: number }) => item.name);

		expect(result.length).toBe(2);
		expect(result.map((r) => r.name).includes("foo")).toBeTruthy();
		expect(result.map((r) => r.name).includes("foobar")).toBeTruthy();
	});

	it("matches slash-separated provider/model queries against reordered text", () => {
		const item = { id: "gpt-5.5", provider: "openai-codex" };
		const result = fuzzyFilter([item], "openai-codex/gpt-5.5", (model) => `${model.id} ${model.provider}`);

		expect(result).toStrictEqual([item]);
	});
});
