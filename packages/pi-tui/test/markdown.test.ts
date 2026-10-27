import { expect, afterEach, describe, it } from "bun:test";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import { Chalk } from "chalk";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import type { Component, TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// Force full color in CI so ANSI assertions are deterministic
const chalk = new Chalk({ level: 3 });

function getCell(terminal: VirtualTerminal, row: number, col: number) {
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	const buffer = xterm.buffer.active;
	const line = buffer.getLine(buffer.viewportY + row);
	expect(line, `Missing buffer line at row ${row}`).toBeTruthy();
	const cell = line.getCell(col);
	expect(cell, `Missing cell at row ${row} col ${col}`).toBeTruthy();
	return cell;
}

function stripAnsi(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("Markdown component", () => {
	describe("Transforms", () => {
		it("caches transformed Markdown by source and available width", () => {
			const calls: Array<{ source: string; availableWidth: number }> = [];
			const markdown = new Markdown("source", 2, 0, defaultMarkdownTheme, undefined, {
				transform: (source, availableWidth) => {
					calls.push({ source, availableWidth });
					return `${source} ${availableWidth}`;
				},
			});

			expect(markdown.render(80).map((line) => stripAnsi(line).trim())).toStrictEqual(["source 76"]);
			markdown.render(80);
			expect(markdown.render(60).map((line) => stripAnsi(line).trim())).toStrictEqual(["source 56"]);
			expect(calls).toStrictEqual([
				{ source: "source", availableWidth: 76 },
				{ source: "source", availableWidth: 56 },
			]);

			markdown.setText("updated");
			expect(markdown.render(60).map((line) => stripAnsi(line).trim())).toStrictEqual(["updated 56"]);
			expect(calls.at(-1)).toStrictEqual({ source: "updated", availableWidth: 56 });

			markdown.invalidate();
			markdown.render(60);
			expect(calls.at(-1)).toStrictEqual({ source: "updated", availableWidth: 56 });
			expect(calls.length).toBe(4);
		});
	});

	describe("Lists", () => {
		it("should render simple nested list", () => {
			const markdown = new Markdown(
				`- Item 1
  - Nested 1.1
  - Nested 1.2
- Item 2`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);

			// Check that we have content
			expect(lines.length > 0).toBeTruthy();

			// Strip ANSI codes for checking
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check structure
			expect(plainLines.some((line) => line.includes("- Item 1"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("    - Nested 1.1"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("    - Nested 1.2"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("- Item 2"))).toBeTruthy();
		});

		it("should render deeply nested list", () => {
			const markdown = new Markdown(
				`- Level 1
  - Level 2
    - Level 3
      - Level 4`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check proper indentation
			expect(plainLines.some((line) => line.includes("- Level 1"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("    - Level 2"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("        - Level 3"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("            - Level 4"))).toBeTruthy();
		});

		it("should render ordered nested list", () => {
			const markdown = new Markdown(
				`1. First
   1. Nested first
   2. Nested second
2. Second`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			expect(plainLines.some((line) => line.includes("1. First"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("    1. Nested first"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("    2. Nested second"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("2. Second"))).toBeTruthy();
		});

		it("should normalize ordered list markers by default", () => {
			const markdown = new Markdown("1. alpha\n1. beta\n1. gamma", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			expect(lines).toStrictEqual(["1. alpha", "2. beta", "3. gamma"]);
		});

		it("should preserve source list markers when configured", () => {
			const markdown = new Markdown(
				"  4. forth\n  3. third\n\n10) ten\n7) seven\n\n+ plus\n* star\n- minus\n+",
				0,
				0,
				defaultMarkdownTheme,
				undefined,
				{
					preserveOrderedListMarkers: true,
				},
			);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			expect(lines).toStrictEqual([
				"4. forth",
				"3. third",
				"",
				"10) ten",
				"7) seven",
				"",
				"+ plus",
				"* star",
				"- minus",
				"+",
			]);
		});

		it("should render mixed ordered and unordered nested lists", () => {
			const markdown = new Markdown(
				`1. Ordered item
   - Unordered nested
   - Another nested
2. Second ordered
   - More nested`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			expect(plainLines.some((line) => line.includes("1. Ordered item"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("    - Unordered nested"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("2. Second ordered"))).toBeTruthy();
		});

		it("should render blank lines between loose list items", () => {
			const markdown = new Markdown(
				`1. Lorem ipsum dolor sit amet.

   Ut enim ad minim veniam.

2. Duis aute irure dolor.

   Excepteur sint occaecat cupidatat.

3. Beep boop`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			expect(lines).toStrictEqual([
				"1. Lorem ipsum dolor sit amet.",
				"",
				"   Ut enim ad minim veniam.",
				"",
				"2. Duis aute irure dolor.",
				"",
				"   Excepteur sint occaecat cupidatat.",
				"",
				"3. Beep boop",
			]);
		});

		it("should render task list markers", () => {
			const markdown = new Markdown("- [ ] beep\n- [x] boop", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			expect(lines).toStrictEqual(["- [ ] beep", "- [x] boop"]);
		});

		it("should maintain numbering when code blocks are not indented (LLM output)", () => {
			// When code blocks aren't indented, marked parses each item as a separate list.
			// We use token.start to preserve the original numbering.
			const markdown = new Markdown(
				`1. First item

\`\`\`typescript
// code block
\`\`\`

2. Second item

\`\`\`typescript
// another code block
\`\`\`

3. Third item`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim());

			// Find all lines that start with a number and period
			const numberedLines = plainLines.filter((line) => /^\d+\./.test(line));

			// Should have 3 numbered items
			expect(numberedLines.length, `Expected 3 numbered items, got: ${numberedLines.join(", ")}`).toBe(3);

			// Check the actual numbers
			expect(numberedLines[0].startsWith("1."), `First item should be "1.", got: ${numberedLines[0]}`).toBeTruthy();
			expect(numberedLines[1].startsWith("2."), `Second item should be "2.", got: ${numberedLines[1]}`).toBeTruthy();
			expect(numberedLines[2].startsWith("3."), `Third item should be "3.", got: ${numberedLines[2]}`).toBeTruthy();
		});

		it("should indent wrapped unordered list lines", () => {
			const markdown = new Markdown("- alpha beta gamma delta epsilon", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(20).map((line) => stripAnsi(line).trimEnd());

			expect(lines).toStrictEqual(["- alpha beta gamma", "  delta epsilon"]);
		});

		it("should indent wrapped ordered list lines", () => {
			const markdown = new Markdown("1. alpha beta gamma delta epsilon", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(20).map((line) => stripAnsi(line).trimEnd());

			expect(lines).toStrictEqual(["1. alpha beta gamma", "   delta epsilon"]);
		});

		it("should indent wrapped ordered list lines with multi-digit markers", () => {
			const markdown = new Markdown("10. alpha beta gamma delta epsilon", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(21).map((line) => stripAnsi(line).trimEnd());

			expect(lines).toStrictEqual(["10. alpha beta gamma", "    delta epsilon"]);
		});

		it("should indent wrapped nested list lines", () => {
			const markdown = new Markdown(`- parent\n  - alpha beta gamma delta epsilon`, 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(24).map((line) => stripAnsi(line).trimEnd());

			expect(lines).toStrictEqual(["- parent", "    - alpha beta gamma", "      delta epsilon"]);
		});

		it("should indent wrapped nested list lines under ordered parents", () => {
			const markdown = new Markdown(`1. parent\n   - alpha beta gamma delta epsilon`, 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(24).map((line) => stripAnsi(line).trimEnd());

			expect(lines).toStrictEqual(["1. parent", "    - alpha beta gamma", "      delta epsilon"]);
		});

		it("should render and wrap blockquotes inside list items", () => {
			const markdown = new Markdown("- > alpha beta gamma delta epsilon zeta", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(24).map((line) => stripAnsi(line).trimEnd());

			expect(lines).toStrictEqual(["- │ alpha beta gamma", "  │ delta epsilon zeta"]);
		});

		it("should render and wrap code blocks inside list items", () => {
			const markdown = new Markdown(
				"- ```ts\n  alpha beta gamma delta epsilon zeta\n  ```",
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(24).map((line) => stripAnsi(line).trimEnd());

			expect(lines).toStrictEqual(["- ```ts", "    alpha beta gamma", "  delta epsilon zeta", "  ```"]);
		});
	});

	describe("Tables", () => {
		it("should render simple table", () => {
			const markdown = new Markdown(
				`| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check table structure
			expect(plainLines.some((line) => line.includes("Name"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("Age"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("Alice"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("Bob"))).toBeTruthy();
			// Check for table borders
			expect(plainLines.some((line) => line.includes("│"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("─"))).toBeTruthy();
		});

		it("should render row dividers between data rows", () => {
			const markdown = new Markdown(
				`| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const dividerLines = plainLines.filter((line) => line.includes("┼"));

			expect(dividerLines.length, "Expected header + row divider").toBe(2);
		});

		it("should keep column width at least the longest word", () => {
			const longestWord = "superlongword";
			const markdown = new Markdown(
				`| Column One | Column Two |
| --- | --- |
| ${longestWord} short | otherword |
| small | tiny |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(32);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const dataLine = plainLines.find((line) => line.includes(longestWord));
			expect(dataLine, "Expected data row containing longest word").toBeTruthy();

			const segments = dataLine.split("│").slice(1, -1);
			const [firstSegment] = segments;
			expect(firstSegment, "Expected first column segment").toBeTruthy();
			const firstColumnWidth = firstSegment.length - 2;

			expect(firstColumnWidth >= longestWord.length, `Expected first column width >= ${longestWord.length}, got ${firstColumnWidth}`).toBeTruthy();
		});

		it("should render table with alignment", () => {
			const markdown = new Markdown(
				`| Left | Center | Right |
| :--- | :---: | ---: |
| A | B | C |
| Long text | Middle | End |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check headers
			expect(plainLines.some((line) => line.includes("Left"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("Center"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("Right"))).toBeTruthy();
			// Check content
			expect(plainLines.some((line) => line.includes("Long text"))).toBeTruthy();
		});

		it("should handle tables with varying column widths", () => {
			const markdown = new Markdown(
				`| Short | Very long column header |
| --- | --- |
| A | This is a much longer cell content |
| B | Short |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);

			// Should render without errors
			expect(lines.length > 0).toBeTruthy();

			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			expect(plainLines.some((line) => line.includes("Very long column header"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("This is a much longer cell content"))).toBeTruthy();
		});

		it("should wrap table cells when table exceeds available width", () => {
			const markdown = new Markdown(
				`| Command | Description | Example |
| --- | --- | --- |
| npm install | Install all dependencies | npm install |
| npm run build | Build the project | npm run build |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Render at narrow width that forces wrapping
			const lines = markdown.render(50);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// All lines should fit within width
			for (const line of plainLines) {
				expect(line.length <= 50, `Line exceeds width 50: "${line}" (length: ${line.length})`).toBeTruthy();
			}

			// Content should still be present (possibly wrapped across lines)
			const allText = plainLines.join(" ");
			expect(allText.includes("Command"), "Should contain 'Command'").toBeTruthy();
			expect(allText.includes("Description"), "Should contain 'Description'").toBeTruthy();
			expect(allText.includes("npm install"), "Should contain 'npm install'").toBeTruthy();
			expect(allText.includes("Install"), "Should contain 'Install'").toBeTruthy();
		});

		it("should not leak wrapped link styles into table borders or plain cells", async () => {
			const source = `| Link | Plain |
| --- | --- |
| [**one two three four five six**](https://example.com) | normal text |`;

			try {
				for (const hyperlinks of [true, false]) {
					setCapabilities({ images: null, trueColor: false, hyperlinks });
					const terminal = new VirtualTerminal(24, 16);
					const tui: TUI = new TuiMainScreen(terminal);
					tui.addChild(new Markdown(source, 0, 0, defaultMarkdownTheme));
					tui.start();

					try {
						await terminal.waitForRender();
						const viewport = terminal.getViewport();
						const row = viewport.findIndex((line) => line.includes("one") && line.includes("norm"));
						expect(row, `Missing wrapped table row: ${JSON.stringify(viewport)}`).not.toBe(-1);
						const line = viewport[row];
						const linkCol = line.indexOf("one");
						const separatorCol = line.indexOf("│", linkCol);
						const plainCol = line.indexOf("norm");
						expect(linkCol >= 0 && separatorCol > linkCol && plainCol > separatorCol).toBeTruthy();
						expect(getCell(terminal, row, linkCol).isFgDefault()).toBe(false);
						expect(getCell(terminal, row, separatorCol).isFgDefault()).toBe(true);
						expect(getCell(terminal, row, plainCol).isFgDefault()).toBe(true);
						expect(getCell(terminal, row, linkCol).isBold()).not.toBe(0);
						expect(getCell(terminal, row, separatorCol).isBold()).toBe(0);
						expect(getCell(terminal, row, plainCol).isBold()).toBe(0);

						if (!hyperlinks) {
							const urlRow = viewport.findIndex((viewportLine) => viewportLine.includes("https"));
							expect(urlRow, `Missing fallback URL row: ${JSON.stringify(viewport)}`).not.toBe(-1);
							const urlLine = viewport[urlRow];
							const urlCol = urlLine.indexOf("https");
							const urlSeparatorCol = urlLine.indexOf("│", urlCol);
							const urlBorderCol = urlLine.lastIndexOf("│");
							expect(urlCol >= 0 && urlSeparatorCol > urlCol && urlBorderCol > urlSeparatorCol).toBeTruthy();
							expect(getCell(terminal, urlRow, urlCol).isDim()).not.toBe(0);
							expect(getCell(terminal, urlRow, urlSeparatorCol).isDim()).toBe(0);
							expect(getCell(terminal, urlRow, urlBorderCol).isDim()).toBe(0);
						}
					} finally {
						tui.stop();
					}
				}
			} finally {
				resetCapabilitiesCache();
			}
		});

		it("should restore the enclosing style after a wrapped table link", async () => {
			const quoteColor = 0x123456;
			const theme: MarkdownTheme = {
				...defaultMarkdownTheme,
				// Use a basic wrapper that does not automatically reopen itself after nested resets.
				quote: (text) => `\x1b[38;2;18;52;86m${text}\x1b[39m`,
				link: (text) => `\x1b[38;2;129;162;190m${text}\x1b[39m`,
			};
			const source = `> | Link | Plain |
> | --- | --- |
> | [one two three four five six](https://example.com) | normal text |`;

			setCapabilities({ images: null, trueColor: true, hyperlinks: true });
			const terminal = new VirtualTerminal(28, 10);
			const tui: TUI = new TuiMainScreen(terminal);
			tui.addChild(new Markdown(source, 0, 0, theme));
			tui.start();

			try {
				await terminal.waitForRender();
				const viewport = terminal.getViewport();
				const row = viewport.findIndex((line) => line.includes("one") && line.includes("normal"));
				expect(row, `Missing wrapped blockquote table row: ${JSON.stringify(viewport)}`).not.toBe(-1);
				const line = viewport[row];
				const linkCol = line.indexOf("one");
				const separatorCol = line.indexOf("│", linkCol);
				const plainCol = line.indexOf("normal");
				expect(linkCol >= 0 && separatorCol > linkCol && plainCol > separatorCol).toBeTruthy();

				expect(getCell(terminal, row, linkCol).getFgColor()).not.toBe(quoteColor);
				expect(getCell(terminal, row, separatorCol).getFgColor()).toBe(quoteColor);
				expect(getCell(terminal, row, plainCol).getFgColor()).toBe(quoteColor);

				const finalRow = viewport.findIndex((line) => line.includes("five six"));
				expect(finalRow, `Missing final wrapped link row: ${JSON.stringify(viewport)}`).not.toBe(-1);
				const finalLine = viewport[finalRow];
				const finalLinkCol = finalLine.indexOf("five six");
				const finalSeparatorCol = finalLine.indexOf("│", finalLinkCol);
				const finalBorderCol = finalLine.lastIndexOf("│");
				expect(finalLinkCol >= 0 && finalSeparatorCol > finalLinkCol && finalBorderCol > finalSeparatorCol).toBeTruthy();
				expect(getCell(terminal, finalRow, finalSeparatorCol).getFgColor()).toBe(quoteColor);
				expect(getCell(terminal, finalRow, finalBorderCol).getFgColor()).toBe(quoteColor);
			} finally {
				tui.stop();
				resetCapabilitiesCache();
			}
		});

		it("should wrap long cell content to multiple lines", () => {
			const markdown = new Markdown(
				`| Header |
| --- |
| This is a very long cell content that should wrap |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Render at width that forces the cell to wrap
			const lines = markdown.render(25);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Should have multiple data rows due to wrapping
			const dataRows = plainLines.filter((line) => line.startsWith("│") && !line.includes("─"));
			expect(dataRows.length > 2, `Expected wrapped rows, got ${dataRows.length} rows`).toBeTruthy();

			// All content should be preserved (may be split across lines)
			const allText = plainLines.join(" ");
			expect(allText.includes("very long"), "Should preserve 'very long'").toBeTruthy();
			expect(allText.includes("cell content"), "Should preserve 'cell content'").toBeTruthy();
			expect(allText.includes("should wrap"), "Should preserve 'should wrap'").toBeTruthy();
		});

		it("should wrap long unbroken tokens inside table cells (not only at line start)", () => {
			// Pin to no-hyperlinks so width checks work on plain text without OSC 8 sequences.
			setCapabilities({ images: null, trueColor: false, hyperlinks: false });
			const url = "https://example.com/this/is/a/very/long/url/that/should/wrap";
			const markdown = new Markdown(
				`| Value |
| --- |
| prefix ${url} |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const width = 30;
			const lines = markdown.render(width);
			resetCapabilitiesCache();
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			for (const line of plainLines) {
				expect(line.length <= width, `Line exceeds width ${width}: "${line}" (length: ${line.length})`).toBeTruthy();
			}

			// Borders should stay intact (exactly 2 vertical borders for a 1-col table)
			const tableLines = plainLines.filter((line) => line.startsWith("│"));
			expect(tableLines.length > 0, "Expected table rows to render").toBeTruthy();
			for (const line of tableLines) {
				const borderCount = line.split("│").length - 1;
				expect(borderCount, `Expected 2 borders, got ${borderCount}: "${line}"`).toBe(2);
			}

			// Strip box drawing characters + whitespace so we can assert the URL is preserved
			// even if it was split across multiple wrapped lines.
			const extracted = plainLines.join("").replace(/[│├┤─\s]/g, "");
			expect(extracted.includes("prefix"), "Should preserve 'prefix'").toBeTruthy();
			expect(extracted.includes(url), "Should preserve URL").toBeTruthy();
		});

		it("should wrap styled inline code inside table cells without breaking borders", () => {
			const markdown = new Markdown(
				`| Code |
| --- |
| \`averyveryveryverylongidentifier\` |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const width = 20;
			const lines = markdown.render(width);
			const joinedOutput = lines.join("\n");
			expect(joinedOutput.includes("\x1b[33m"), "Inline code should be styled (yellow)").toBeTruthy();

			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
			for (const line of plainLines) {
				expect(line.length <= width, `Line exceeds width ${width}: "${line}" (length: ${line.length})`).toBeTruthy();
			}

			const tableLines = plainLines.filter((line) => line.startsWith("│"));
			for (const line of tableLines) {
				const borderCount = line.split("│").length - 1;
				expect(borderCount, `Expected 2 borders, got ${borderCount}: "${line}"`).toBe(2);
			}
		});

		it("should handle extremely narrow width gracefully", () => {
			const markdown = new Markdown(
				`| A | B | C |
| --- | --- | --- |
| 1 | 2 | 3 |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Very narrow width
			const lines = markdown.render(15);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Should not crash and should produce output
			expect(lines.length > 0, "Should produce output").toBeTruthy();

			// Lines should not exceed width
			for (const line of plainLines) {
				expect(line.length <= 15, `Line exceeds width 15: "${line}" (length: ${line.length})`).toBeTruthy();
			}
		});

		it("should render table correctly when it fits naturally", () => {
			const markdown = new Markdown(
				`| A | B |
| --- | --- |
| 1 | 2 |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Wide width where table fits naturally
			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Should have proper table structure
			const headerLine = plainLines.find((line) => line.includes("A") && line.includes("B"));
			expect(headerLine, "Should have header row").toBeTruthy();
			expect(headerLine?.includes("│"), "Header should have borders").toBeTruthy();

			const separatorLine = plainLines.find((line) => line.includes("├") && line.includes("┼"));
			expect(separatorLine, "Should have separator row").toBeTruthy();

			const dataLine = plainLines.find((line) => line.includes("1") && line.includes("2"));
			expect(dataLine, "Should have data row").toBeTruthy();
		});

		it("should respect paddingX when calculating table width", () => {
			const markdown = new Markdown(
				`| Column One | Column Two |
| --- | --- |
| Data 1 | Data 2 |`,
				2, // paddingX = 2
				0,
				defaultMarkdownTheme,
			);

			// Width 40 with paddingX=2 means contentWidth=36
			const lines = markdown.render(40);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// All lines should respect width
			for (const line of plainLines) {
				expect(line.length <= 40, `Line exceeds width 40: "${line}" (length: ${line.length})`).toBeTruthy();
			}

			// Table rows should have left padding
			const tableRow = plainLines.find((line) => line.includes("│"));
			expect(tableRow?.startsWith("  "), "Table should have left padding").toBeTruthy();
		});

		it("should not add a trailing blank line when table is the last rendered block", () => {
			const markdown = new Markdown(
				`| Name |
| --- |
| Alice |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			expect(plainLines.at(-1), `Expected table to end without a blank line: ${JSON.stringify(plainLines)}`).not.toBe("");
		});
	});

	describe("Combined features", () => {
		it("should render lists and tables together", () => {
			const markdown = new Markdown(
				`# Test Document

- Item 1
  - Nested item
- Item 2

| Col1 | Col2 |
| --- | --- |
| A | B |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check heading
			expect(plainLines.some((line) => line.includes("Test Document"))).toBeTruthy();
			// Check list
			expect(plainLines.some((line) => line.includes("- Item 1"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("    - Nested item"))).toBeTruthy();
			// Check table
			expect(plainLines.some((line) => line.includes("Col1"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("│"))).toBeTruthy();
		});
	});

	describe("Backslash escapes", () => {
		it("should normalize escaped punctuation by default", () => {
			const markdown = new Markdown(String.raw`"\"`, 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			expect(lines).toStrictEqual([`""`]);
		});

		it("should preserve source backslash escapes when configured", () => {
			const markdown = new Markdown(String.raw`"\"`, 0, 0, defaultMarkdownTheme, undefined, {
				preserveBackslashEscapes: true,
			});

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			expect(lines).toStrictEqual([String.raw`"\"`]);
		});
	});

	describe("LaTeX math", () => {
		it("renders inline dollar and parenthesis delimiters", () => {
			const markdown = new Markdown(
				String.raw`A map $\mathbb{C}^3 \to \mathbb{C}^3$, $xy$, $x-y$, $-x$, $\frac{1}{2}$, and \(s \to \infty\).`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			expect(lines).toStrictEqual(["A map ℂ³ → ℂ³, xy, x-y, -x, 1/2, and s → ∞."]);
		});

		it("falls back to raw source for pathologically deep LaTeX nesting", () => {
			// Deeply nested braces make renderLatex bail out (documented contract);
			// the Markdown renderer must not throw and must keep the raw text.
			const depth = 8_000;
			const source = `$$${"{".repeat(depth)}x${"}".repeat(depth)}$$`;
			const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);

			expect(() => markdown.render(80)).not.toThrow();
		});

		it("renders display dollar delimiters without Markdown escape corruption", () => {
			const markdown = new Markdown(
				String.raw`Before

$$\{3x+2y,\; x \in \{0, \pm 1\}\}$$

after`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			expect(lines).toStrictEqual(["Before", "", "{3x+2y, x ∈ {0, ± 1}}", "", "after"]);
		});

		it("renders display bracket delimiters", () => {
			const markdown = new Markdown(
				String.raw`Before

\[
E \approx \frac{0.1\ \text{lux}}{100\ \text{lm/W}}
\]

after`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			expect(lines).toStrictEqual(["Before", "", "    0.1 lux", "E ≈ ────────", "    100 lm/W", "", "after"]);
		});

		it("aligns matrix rows with the opening delimiter", () => {
			const markdown = new Markdown(
				String.raw`Consider the matrix

\[
A=
\begin{pmatrix}
\pi & 0\\
0 & \frac{1}{\pi}
\end{pmatrix}.
\]`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			expect(lines).toStrictEqual(["Consider the matrix", "", "A = ⎛ π │ 0   ⎞", "    ⎝ 0 │ 1/π ⎠."]);
		});

		it("renders lower limits beneath display operators", () => {
			const markdown = new Markdown(
				String.raw`\[
\lim_{x\to 0}\frac{\frac{\sin x}{x}-1}{\frac{e^x-1}{x}-1}=0
\]`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			expect(lines).toStrictEqual(["     (sin x)/x-1", "lim  ─────────── = 0", "x→0  (eˣ-1)/x-1"]);
		});

		it("renders math inside lists and tables", () => {
			const markdown = new Markdown(
				String.raw`- Formula: $F_1 = u^2$

| Value |
| --- |
| $\mathbb{C}^3$ |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());
			const output = lines.join("\n");

			expect(output.includes("- Formula: F₁ = u²")).toBeTruthy();
			expect(output.includes("│ ℂ³")).toBeTruthy();
		});

		it("does not treat currency, shell variables, or code spans as math", () => {
			const source = "Costs $5 and $10 or $8k–$12k; use `$x$`, $HOME, and $" + "{PATH}.";
			const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			expect(lines).toStrictEqual(["Costs $5 and $10 or $8k–$12k; use $x$, $HOME, and $" + "{PATH}."]);

			const shellVariables = "Paths: $HOME/$USER and $XDG_CONFIG_HOME/$APP_CONFIG";
			const shellLines = new Markdown(shellVariables, 0, 0, defaultMarkdownTheme)
				.render(80)
				.map((line) => stripAnsi(line).trimEnd());
			expect(shellLines).toStrictEqual([shellVariables]);
		});

		it("preserves unsupported and incomplete LaTeX exactly", () => {
			const cases = [String.raw`Unknown $x + \unknown{y}$ after`, String.raw`Streaming $\mathbb{C}^3`];

			for (const source of cases) {
				const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);
				const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());
				expect(lines).toStrictEqual([source]);
			}
		});

		it("preserves incomplete backslash delimiters while streaming", () => {
			const inline = new Markdown(String.raw`Map \(\mathbb{C}^3`, 0, 0, defaultMarkdownTheme);
			expect(inline.render(80).map((line) => stripAnsi(line).trimEnd())).toStrictEqual([String.raw`Map \(\mathbb{C}^3`]);

			const display = new Markdown("\\[\nx^2", 0, 0, defaultMarkdownTheme);
			expect(display.render(80).map((line) => stripAnsi(line).trimEnd())).toStrictEqual(["\\[", "x^2"]);
		});

		it("does not render LaTeX inside escaped delimiters or code fences", () => {
			const source = [String.raw`Escaped \$x-y\$.`, "", "```text", String.raw`$\mathbb{C}^3$`, "```"].join("\n");
			const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);
			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			expect(lines).toStrictEqual(["Escaped $x-y$.", "", "```text", "  $\\mathbb{C}^3$", "```"]);
		});

		it("allows LaTeX rendering to be disabled", () => {
			const markdown = new Markdown(
				String.raw`Map $\mathbb{C}^3 \to \mathbb{C}^3$`,
				0,
				0,
				defaultMarkdownTheme,
				undefined,
				{
					renderLatex: false,
				},
			);

			expect(markdown.render(80).map((line) => stripAnsi(line).trimEnd())).toStrictEqual([String.raw`Map $\mathbb{C}^3 \to \mathbb{C}^3$`]);
		});

		it("switches from raw to rendered math when a streamed delimiter closes", () => {
			const markdown = new Markdown(String.raw`Map $\mathbb{C}^3`, 0, 0, defaultMarkdownTheme);
			expect(markdown.render(80).map((line) => stripAnsi(line).trimEnd())).toStrictEqual([String.raw`Map $\mathbb{C}^3`]);

			markdown.setText(String.raw`Map $\mathbb{C}^3$`);

			expect(markdown.render(80).map((line) => stripAnsi(line).trimEnd())).toStrictEqual(["Map ℂ³"]);
		});
	});

	describe("Backslash escapes", () => {
		it("should normalize escaped punctuation by default", () => {
			const markdown = new Markdown(String.raw`"\"`, 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			expect(lines).toStrictEqual([`""`]);
		});

		it("should preserve source backslash escapes when configured", () => {
			const markdown = new Markdown(String.raw`"\"`, 0, 0, defaultMarkdownTheme, undefined, {
				preserveBackslashEscapes: true,
			});

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			expect(lines).toStrictEqual([String.raw`"\"`]);
		});
	});

	describe("Pre-styled text (thinking traces)", () => {
		it("should preserve gray italic styling after inline code", () => {
			// This replicates how thinking content is rendered in assistant-message.ts
			const markdown = new Markdown(
				"This is thinking with `inline code` and more text after",
				1,
				0,
				defaultMarkdownTheme,
				{
					color: (text) => chalk.gray(text),
					italic: true,
				},
			);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			// Should contain the inline code block
			expect(joinedOutput.includes("inline code")).toBeTruthy();

			// The output should have ANSI codes for gray (90) and italic (3)
			expect(joinedOutput.includes("\x1b[90m"), "Should have gray color code").toBeTruthy();
			expect(joinedOutput.includes("\x1b[3m"), "Should have italic code").toBeTruthy();

			// Verify that inline code is styled (theme uses yellow)
			const hasCodeColor = joinedOutput.includes("\x1b[33m");
			expect(hasCodeColor, "Should style inline code").toBeTruthy();
		});

		it("should preserve gray italic styling after bold text", () => {
			const markdown = new Markdown(
				"This is thinking with **bold text** and more after",
				1,
				0,
				defaultMarkdownTheme,
				{
					color: (text) => chalk.gray(text),
					italic: true,
				},
			);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			// Should contain bold text
			expect(joinedOutput.includes("bold text")).toBeTruthy();

			// The output should have ANSI codes for gray (90) and italic (3)
			expect(joinedOutput.includes("\x1b[90m"), "Should have gray color code").toBeTruthy();
			expect(joinedOutput.includes("\x1b[3m"), "Should have italic code").toBeTruthy();

			// Should have bold codes (1 or 22 for bold on/off)
			expect(joinedOutput.includes("\x1b[1m"), "Should have bold code").toBeTruthy();
		});

		it("should not leak styles into following lines when rendered in TUI", async () => {
			class MarkdownWithInput implements Component {
				public markdownLineCount = 0;
				private readonly markdown: Markdown;

				constructor(markdown: Markdown) {
					this.markdown = markdown;
				}

				render(width: number): string[] {
					const lines = this.markdown.render(width);
					this.markdownLineCount = lines.length;
					return [...lines, "INPUT"];
				}

				invalidate(): void {
					this.markdown.invalidate();
				}
			}

			const markdown = new Markdown("This is thinking with `inline code`", 1, 0, defaultMarkdownTheme, {
				color: (text) => chalk.gray(text),
				italic: true,
			});

			const terminal = new VirtualTerminal(80, 6);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new MarkdownWithInput(markdown);
			tui.addChild(component);
			tui.start();
			await terminal.waitForRender();

			expect(component.markdownLineCount > 0).toBeTruthy();
			const inputRow = component.markdownLineCount;
			expect(getCell(terminal, inputRow, 0).isItalic()).toBe(0);
			tui.stop();
		});
	});

	describe("Spacing after code blocks", () => {
		it("should have only one blank line between code block and following paragraph", () => {
			const markdown = new Markdown(
				`hello world

\`\`\`js
const hello = "world";
\`\`\`

again, hello world`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			const closingBackticksIndex = plainLines.indexOf("```");
			expect(closingBackticksIndex !== -1, "Should have closing backticks").toBeTruthy();

			const afterBackticks = plainLines.slice(closingBackticksIndex + 1);
			const emptyLineCount = afterBackticks.findIndex((line) => line !== "");

			expect(emptyLineCount, `Expected 1 empty line after code block, but found ${emptyLineCount}. Lines after backticks: ${JSON.stringify(afterBackticks.slice(0, 5))}`).toBe(1);
		});

		it("should normalize paragraph and code block spacing to one blank line", () => {
			const cases = [
				`hello this is text
\`\`\`
code block
\`\`\`
more text`,
				`hello this is text

\`\`\`
code block
\`\`\`

more text`,
			];
			const expectedLines = ["hello this is text", "", "```", "  code block", "```", "", "more text"];

			for (const text of cases) {
				const markdown = new Markdown(text, 0, 0, defaultMarkdownTheme);
				const lines = markdown.render(80);
				const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

				expect(plainLines, `Unexpected spacing for markdown: ${JSON.stringify(text)}`).toStrictEqual(expectedLines);
			}
		});

		it("should not add a trailing blank line when code block is the last rendered block", () => {
			const cases = ["```js\nconst hello = 'world';\n```", "hello world\n\n```js\nconst hello = 'world';\n```"];

			for (const text of cases) {
				const markdown = new Markdown(text, 0, 0, defaultMarkdownTheme);
				const lines = markdown.render(80);
				const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

				expect(plainLines.at(-1), `Expected code block to end without a blank line: ${JSON.stringify(plainLines)}`).not.toBe("");
			}
		});
	});

	describe("Spacing after dividers", () => {
		it("should have only one blank line between divider and following paragraph", () => {
			const markdown = new Markdown(
				`hello world

---

again, hello world`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			const dividerIndex = plainLines.findIndex((line) => line.includes("─"));
			expect(dividerIndex !== -1, "Should have divider").toBeTruthy();

			const afterDivider = plainLines.slice(dividerIndex + 1);
			const emptyLineCount = afterDivider.findIndex((line) => line !== "");

			expect(emptyLineCount, `Expected 1 empty line after divider, but found ${emptyLineCount}. Lines after divider: ${JSON.stringify(afterDivider.slice(0, 5))}`).toBe(1);
		});

		it("should not add a trailing blank line when divider is the last rendered block", () => {
			const markdown = new Markdown("---", 0, 0, defaultMarkdownTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			expect(plainLines.at(-1), `Expected divider to end without a blank line: ${JSON.stringify(plainLines)}`).not.toBe("");
		});
	});

	describe("Spacing after headings", () => {
		it("should have only one blank line between heading and following paragraph", () => {
			const markdown = new Markdown(
				`# Hello

This is a paragraph`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			const headingIndex = plainLines.findIndex((line) => line.includes("Hello"));
			expect(headingIndex !== -1, "Should have heading").toBeTruthy();

			const afterHeading = plainLines.slice(headingIndex + 1);
			const emptyLineCount = afterHeading.findIndex((line) => line !== "");

			expect(emptyLineCount, `Expected 1 empty line after heading, but found ${emptyLineCount}. Lines after heading: ${JSON.stringify(afterHeading.slice(0, 5))}`).toBe(1);
		});

		it("should not add a trailing blank line when heading is the last rendered block", () => {
			const markdown = new Markdown("# Hello", 0, 0, defaultMarkdownTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			expect(plainLines.at(-1), `Expected heading to end without a blank line: ${JSON.stringify(plainLines)}`).not.toBe("");
		});
	});

	describe("Spacing after blockquotes", () => {
		it("should have only one blank line between blockquote and following paragraph", () => {
			const markdown = new Markdown(
				`hello world

> This is a quote

again, hello world`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			const quoteIndex = plainLines.findIndex((line) => line.includes("This is a quote"));
			expect(quoteIndex !== -1, "Should have blockquote").toBeTruthy();

			const afterQuote = plainLines.slice(quoteIndex + 1);
			const emptyLineCount = afterQuote.findIndex((line) => line !== "");

			expect(emptyLineCount, `Expected 1 empty line after blockquote, but found ${emptyLineCount}. Lines after quote: ${JSON.stringify(afterQuote.slice(0, 5))}`).toBe(1);
		});

		it("should not add a trailing blank line when blockquote is the last rendered block", () => {
			const markdown = new Markdown("> This is a quote", 0, 0, defaultMarkdownTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			expect(plainLines.at(-1), `Expected blockquote to end without a blank line: ${JSON.stringify(plainLines)}`).not.toBe("");
		});
	});

	describe("Blockquotes with multiline content", () => {
		it("should apply consistent styling to all lines in lazy continuation blockquote", () => {
			// Markdown "lazy continuation" - second line without > is still part of the quote
			const markdown = new Markdown(
				`>Foo
bar`,
				0,
				0,
				defaultMarkdownTheme,
				{
					color: (text) => chalk.magenta(text), // This should NOT be applied to blockquotes
				},
			);

			const lines = markdown.render(80);

			// Both lines should have the quote border
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const quotedLines = plainLines.filter((line) => line.startsWith("│ "));
			expect(quotedLines.length, `Expected 2 quoted lines, got: ${JSON.stringify(plainLines)}`).toBe(2);

			// Both lines should have italic (from theme.quote styling)
			const fooLine = lines.find((line) => line.includes("Foo"));
			const barLine = lines.find((line) => line.includes("bar"));
			expect(fooLine, "Should have Foo line").toBeTruthy();
			expect(barLine, "Should have bar line").toBeTruthy();

			// Check that both have italic (\x1b[3m) - blockquotes use theme styling, not default message color
			expect(fooLine?.includes("\x1b[3m"), `Foo line should have italic: ${fooLine}`).toBeTruthy();
			expect(barLine?.includes("\x1b[3m"), `bar line should have italic: ${barLine}`).toBeTruthy();

			// Blockquotes should NOT have the default message color (magenta)
			expect(!fooLine?.includes("\x1b[35m"), `Foo line should NOT have magenta color: ${fooLine}`).toBeTruthy();
			expect(!barLine?.includes("\x1b[35m"), `bar line should NOT have magenta color: ${barLine}`).toBeTruthy();
		});

		it("should apply consistent styling to explicit multiline blockquote", () => {
			const markdown = new Markdown(
				`>Foo
>bar`,
				0,
				0,
				defaultMarkdownTheme,
				{
					color: (text) => chalk.cyan(text), // This should NOT be applied to blockquotes
				},
			);

			const lines = markdown.render(80);

			// Both lines should have the quote border
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const quotedLines = plainLines.filter((line) => line.startsWith("│ "));
			expect(quotedLines.length, `Expected 2 quoted lines, got: ${JSON.stringify(plainLines)}`).toBe(2);

			// Both lines should have italic (from theme.quote styling)
			const fooLine = lines.find((line) => line.includes("Foo"));
			const barLine = lines.find((line) => line.includes("bar"));
			expect(fooLine?.includes("\x1b[3m"), `Foo line should have italic: ${fooLine}`).toBeTruthy();
			expect(barLine?.includes("\x1b[3m"), `bar line should have italic: ${barLine}`).toBeTruthy();

			// Blockquotes should NOT have the default message color (cyan)
			expect(!fooLine?.includes("\x1b[36m"), `Foo line should NOT have cyan color: ${fooLine}`).toBeTruthy();
			expect(!barLine?.includes("\x1b[36m"), `bar line should NOT have cyan color: ${barLine}`).toBeTruthy();
		});

		it("should render list content inside blockquotes", () => {
			const markdown = new Markdown(
				`> 1. bla bla
> - nested bullet`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const quotedLines = plainLines.filter((line) => line.startsWith("│ "));

			expect(quotedLines.some((line) => line.includes("1. bla bla")), `Missing ordered list item: ${JSON.stringify(quotedLines)}`).toBeTruthy();
			expect(quotedLines.some((line) => line.includes("- nested bullet")), `Missing unordered list item: ${JSON.stringify(quotedLines)}`).toBeTruthy();
		});

		it("should wrap long blockquote lines and add border to each wrapped line", () => {
			const longText = "This is a very long blockquote line that should wrap to multiple lines when rendered";
			const markdown = new Markdown(`> ${longText}`, 0, 0, defaultMarkdownTheme);

			// Render at narrow width to force wrapping
			const lines = markdown.render(30);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Filter to non-empty lines (exclude trailing blank line after blockquote)
			const contentLines = plainLines.filter((line) => line.length > 0);

			// Should have multiple lines due to wrapping
			expect(contentLines.length > 1, `Expected multiple wrapped lines, got: ${JSON.stringify(contentLines)}`).toBeTruthy();

			// Every content line should start with the quote border
			for (const line of contentLines) {
				expect(line.startsWith("│ "), `Wrapped line should have quote border: "${line}"`).toBeTruthy();
			}

			// All content should be preserved
			const allText = contentLines.join(" ");
			expect(allText.includes("very long"), "Should preserve 'very long'").toBeTruthy();
			expect(allText.includes("blockquote"), "Should preserve 'blockquote'").toBeTruthy();
			expect(allText.includes("multiple"), "Should preserve 'multiple'").toBeTruthy();
		});

		it("should properly indent wrapped blockquote lines with styling", () => {
			const markdown = new Markdown(
				"> This is styled text that is long enough to wrap",
				0,
				0,
				defaultMarkdownTheme,
				{
					color: (text) => chalk.yellow(text), // This should NOT be applied to blockquotes
					italic: true,
				},
			);

			const lines = markdown.render(25);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Filter to non-empty lines
			const contentLines = plainLines.filter((line) => line.length > 0);

			// All lines should have the quote border
			for (const line of contentLines) {
				expect(line.startsWith("│ "), `Line should have quote border: "${line}"`).toBeTruthy();
			}

			// Check that italic is applied (from theme.quote)
			const allOutput = lines.join("\n");
			expect(allOutput.includes("\x1b[3m"), "Should have italic").toBeTruthy();

			// Blockquotes should NOT have the default message color (yellow)
			expect(!allOutput.includes("\x1b[33m"), "Should NOT have yellow color from default style").toBeTruthy();
		});

		it("should render inline formatting inside blockquotes and reapply quote styling after", () => {
			const markdown = new Markdown("> Quote with **bold** and `code`", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Should have the quote border
			expect(plainLines.some((line) => line.startsWith("│ ")), "Should have quote border").toBeTruthy();

			// Content should be preserved
			const allPlain = plainLines.join(" ");
			expect(allPlain.includes("Quote with"), "Should preserve 'Quote with'").toBeTruthy();
			expect(allPlain.includes("bold"), "Should preserve 'bold'").toBeTruthy();
			expect(allPlain.includes("code"), "Should preserve 'code'").toBeTruthy();

			const allOutput = lines.join("\n");

			// Should have bold styling (\x1b[1m)
			expect(allOutput.includes("\x1b[1m"), "Should have bold styling").toBeTruthy();

			// Should have code styling (yellow = \x1b[33m from defaultMarkdownTheme)
			expect(allOutput.includes("\x1b[33m"), "Should have code styling (yellow)").toBeTruthy();

			// Should have italic from quote styling (\x1b[3m)
			expect(allOutput.includes("\x1b[3m"), "Should have italic from quote styling").toBeTruthy();
		});
	});

	describe("Heading with inline code", () => {
		it("should preserve heading styling after inline code", () => {
			const markdown = new Markdown("### Why `sourceInfo` should not be optional", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			// The heading theme is bold+cyan. After the yellow inline code, the heading
			// styling (bold+cyan) must be restored so subsequent text is styled correctly.
			// bold = \x1b[1m, cyan = \x1b[36m, yellow = \x1b[33m
			expect(joinedOutput.includes("\x1b[33m"), "Should have yellow for inline code").toBeTruthy();

			// Find the position of "should not be optional" in the raw output.
			// It must be preceded by heading style codes (bold+cyan), not appear unstyled.
			const afterCodeIndex = joinedOutput.indexOf("should not be optional");
			expect(afterCodeIndex > 0, "Should contain text after inline code").toBeTruthy();

			// Look at the ANSI codes between the code span end and "should not be optional".
			// There should be bold (\x1b[1m) and cyan (\x1b[36m) re-applied.
			const precedingChunk = joinedOutput.slice(Math.max(0, afterCodeIndex - 40), afterCodeIndex);
			expect(precedingChunk.includes("\x1b[1m"), `Should re-apply bold before text after code: ${precedingChunk}`).toBeTruthy();
			expect(precedingChunk.includes("\x1b[36m"), `Should re-apply cyan before text after code: ${precedingChunk}`).toBeTruthy();
		});

		it("should preserve heading styling after inline code for h1", () => {
			const markdown = new Markdown("# Title with `code` inside", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			const afterCodeIndex = joinedOutput.indexOf("inside");
			expect(afterCodeIndex > 0, "Should contain text after inline code").toBeTruthy();

			const precedingChunk = joinedOutput.slice(Math.max(0, afterCodeIndex - 40), afterCodeIndex);
			// H1 uses heading + bold + underline
			expect(precedingChunk.includes("\x1b[1m"), `Should re-apply bold for h1: ${precedingChunk}`).toBeTruthy();
			expect(precedingChunk.includes("\x1b[36m"), `Should re-apply cyan for h1: ${precedingChunk}`).toBeTruthy();
			expect(precedingChunk.includes("\x1b[4m"), `Should re-apply underline for h1: ${precedingChunk}`).toBeTruthy();
		});

		it("should not leak h1 underline into padding when inline code is the last token", async () => {
			const markdown = new Markdown("# Important distinction from `open()`", 0, 0, defaultMarkdownTheme);
			const terminal = new VirtualTerminal(80, 4);
			const tui: TUI = new TuiMainScreen(terminal);
			tui.addChild(markdown);
			tui.start();
			await terminal.waitForRender();

			const renderedLine = markdown.render(80)[0];
			expect(renderedLine, "Should render heading line").toBeTruthy();
			const contentWidth = renderedLine.replace(/\x1b\[[0-9;]*m/g, "").trimEnd().length;
			expect(contentWidth > 0, "Should have visible heading content").toBeTruthy();

			for (let col = contentWidth; col < 80; col++) {
				expect(getCell(terminal, 0, col).isUnderline(), `Expected no underline in padding at col ${col}`).toBe(0);
			}

			tui.stop();
		});

		it("should preserve heading styling after bold text", () => {
			const markdown = new Markdown("## Heading with **bold** and more", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			const afterBoldIndex = joinedOutput.indexOf("and more");
			expect(afterBoldIndex > 0, "Should contain text after bold").toBeTruthy();

			const precedingChunk = joinedOutput.slice(Math.max(0, afterBoldIndex - 40), afterBoldIndex);
			expect(precedingChunk.includes("\x1b[1m"), `Should re-apply bold for h2: ${precedingChunk}`).toBeTruthy();
			expect(precedingChunk.includes("\x1b[36m"), `Should re-apply cyan for h2: ${precedingChunk}`).toBeTruthy();
		});
	});

	describe("Strikethrough syntax", () => {
		it("should render ~~text~~ as strikethrough", () => {
			const markdown = new Markdown("Use ~~strikethrough~~ here", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");
			const joinedPlain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join(" ");

			expect(joinedOutput.includes("\x1b[9m"), "Should apply strikethrough styling").toBeTruthy();
			expect(joinedPlain.includes("strikethrough"), "Should include struck text content").toBeTruthy();
			expect(!joinedPlain.includes("~~strikethrough~~"), "Should not render delimiters as text").toBeTruthy();
		});

		it("should keep ~text~ as plain text", () => {
			const markdown = new Markdown("Use ~strikethrough~ literally", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");
			const joinedPlain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join(" ");

			expect(joinedPlain.includes("~strikethrough~"), "Single-tilde delimiters should remain visible").toBeTruthy();
			expect(!joinedOutput.includes("\x1b[9m"), "Single-tilde text should not use strikethrough styling").toBeTruthy();
		});
	});

	describe("Links", () => {
		afterEach(() => {
			resetCapabilitiesCache();
		});

		it("should not duplicate URL for autolinked emails", () => {
			// Hyperlinks capability does not affect the mailto: display check.
			setCapabilities({ images: null, trueColor: false, hyperlinks: false });
			const markdown = new Markdown("Contact user@example.com for help", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join(" ");

			// Should contain the email once, not duplicated with mailto:
			expect(joinedPlain.includes("user@example.com"), "Should contain email").toBeTruthy();
			expect(!joinedPlain.includes("mailto:"), "Should not show mailto: prefix for autolinked emails").toBeTruthy();
		});

		it("should not duplicate URL for bare URLs", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: false });
			const markdown = new Markdown("Visit https://example.com for more", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join(" ");

			// URL should appear only once
			const urlCount = (joinedPlain.match(/https:\/\/example\.com/g) || []).length;
			expect(urlCount, "URL should appear exactly once").toBe(1);
		});

		it("should show URL in parentheses when hyperlinks are not supported", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: false });
			const markdown = new Markdown("[click here](https://example.com)", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join(" ");

			expect(joinedPlain.includes("click here"), "Should contain link text").toBeTruthy();
			expect(joinedPlain.includes("(https://example.com)"), "Should show URL in parentheses").toBeTruthy();
		});

		it("should show mailto URL in parentheses when hyperlinks are not supported", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: false });
			const markdown = new Markdown("[Email me](mailto:test@example.com)", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join(" ");

			expect(joinedPlain.includes("Email me"), "Should contain link text").toBeTruthy();
			expect(joinedPlain.includes("(mailto:test@example.com)"), "Should show mailto URL in parentheses").toBeTruthy();
		});

		it("should emit OSC 8 hyperlink sequence when terminal supports hyperlinks", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: true });
			const markdown = new Markdown("[click here](https://example.com)", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joined = lines.join("");

			// OSC 8 open: ESC ] 8 ; ; <url> ESC \
			expect(joined.includes("\x1b]8;;https://example.com\x1b\\"), "Should contain OSC 8 open sequence").toBeTruthy();
			// OSC 8 close: ESC ] 8 ; ; ESC \
			expect(joined.includes("\x1b]8;;\x1b\\"), "Should contain OSC 8 close sequence").toBeTruthy();
			// Visible text is present
			const plainLines = lines.map((line) => line.replace(/\x1b[^a-zA-Z]*[a-zA-Z]|\x1b\].*?\x1b\\/g, ""));
			expect(plainLines.join("").includes("click here"), "Should contain link text").toBeTruthy();
			// URL is NOT printed inline as plain text
			const rawPlain = lines.map((line) =>
				line.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, ""),
			);
			expect(!rawPlain.join("").includes("(https://example.com)"), "URL should not appear inline in parentheses").toBeTruthy();
		});

		it("should not emit OSC 8 when the href carries control bytes", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: true });
			const href = "https://example.com/\u001b]2;pwned\u0007";
			const markdown = new Markdown(`[click here](${href})`, 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joined = lines.join("");

			expect(!joined.includes("\x1b]8;;"), "A href with control bytes must not become a hyperlink").toBeTruthy();
			expect(joined.includes("click here"), "The visible link text still renders").toBeTruthy();
		});

		it("should use OSC 8 for mailto links when terminal supports hyperlinks", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: true });
			const markdown = new Markdown("[Email me](mailto:test@example.com)", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joined = lines.join("");

			expect(joined.includes("\x1b]8;;mailto:test@example.com\x1b\\"), "Should contain OSC 8 open with mailto URL").toBeTruthy();
			expect(joined.includes("\x1b]8;;\x1b\\"), "Should contain OSC 8 close sequence").toBeTruthy();
		});

		it("should use OSC 8 for bare URLs when terminal supports hyperlinks", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: true });
			const markdown = new Markdown("Visit https://example.com for more", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joined = lines.join("");

			expect(joined.includes("\x1b]8;;https://example.com\x1b\\"), "Should contain OSC 8 hyperlink").toBeTruthy();
			// URL should not also appear as raw parenthetical text
			const rawPlain = lines.map((line) =>
				line.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, ""),
			);
			expect(!rawPlain.join("").includes("(https://example.com)"), "URL should not appear twice").toBeTruthy();
		});

		it("should not absorb CJK punctuation after bare URLs into the link", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: true });
			const markdown = new Markdown(
				"PR 已开：https://example.com/app/pull/232（本地 main 已退回 origin/main 保持干净）。",
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const joined = lines.join("");

			// The hyperlink target must stop at the CJK boundary…
			expect(joined.includes("\x1b]8;;https://example.com/app/pull/232\x1b\\"), "OSC 8 target should end at the URL, before the full-width parenthesis").toBeTruthy();
			// …and the CJK text must not be part of any hyperlink target.
			expect(!joined.includes("%EF%BC%88"), "OSC 8 target should not contain encoded CJK").toBeTruthy();
			expect(!/\x1b\]8;;[^\x1b]*（/.test(joined), "No hyperlink target should contain CJK characters").toBeTruthy();
			// The full source text still renders visibly.
			const rawPlain = lines.map((line) =>
				line.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, ""),
			);
			expect(rawPlain.join("").includes("https://example.com/app/pull/232（本地 main 已退回"), "URL and following CJK text should both render").toBeTruthy();
		});

		it("should strip a trailing full-width parenthesis after a bare URL", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: true });
			const markdown = new Markdown("看这个（https://example.com/page）就知道", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joined = lines.join("");

			expect(joined.includes("\x1b]8;;https://example.com/page\x1b\\"), "OSC 8 target should exclude the wrapping full-width parenthesis").toBeTruthy();
		});

		it("should keep CJK characters inside the URL path", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: true });
			const markdown = new Markdown("见 https://example.com/wiki/测试页面 的说明", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joined = lines.join("");

			expect(joined.includes("\x1b]8;;https://example.com/wiki/测试页面\x1b\\"), "CJK path characters remain part of the hyperlink target").toBeTruthy();
		});

		it("should keep balanced full-width parentheses inside the URL path", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: true });
			const markdown = new Markdown(
				"见 https://example.com/wiki/中华人民共和国（1949年） 的说明",
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const joined = lines.join("");

			expect(joined.includes("\x1b]8;;https://example.com/wiki/中华人民共和国（1949年）\x1b\\"), "Balanced full-width parens remain part of the hyperlink target").toBeTruthy();
		});

		it("should keep CJK punctuation inside balanced full-width parentheses", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: true });
			const markdown = new Markdown(
				"见 https://example.com/wiki/中华人民共和国（北京，1949年） 的说明",
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const joined = lines.join("");

			expect(joined.includes("\x1b]8;;https://example.com/wiki/中华人民共和国（北京，1949年）\x1b\\"), "Punctuation inside balanced full-width parens remains part of the hyperlink target").toBeTruthy();
		});
	});

	describe("HTML-like tags in text", () => {
		it("should render content with HTML-like tags as text", () => {
			// When the model emits something like <thinking>content</thinking> in regular text,
			// marked might treat it as HTML and hide the content
			const markdown = new Markdown(
				"This is text with <thinking>hidden content</thinking> that should be visible",
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join(" ");

			// The content inside the tags should be visible
			expect(joinedPlain.includes("hidden content") || joinedPlain.includes("<thinking>"), "Should render HTML-like tags or their content as text, not hide them").toBeTruthy();
		});

		it("should render HTML tags in code blocks correctly", () => {
			const markdown = new Markdown("```html\n<div>Some HTML</div>\n```", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join("\n");

			// HTML in code blocks should be visible
			expect(joinedPlain.includes("<div>") && joinedPlain.includes("</div>"), "Should render HTML in code blocks").toBeTruthy();
		});
	});

	describe("Streaming code fences", () => {
		it("stabilizes partial closing fence rendering", () => {
			const cases = [
				{
					input: "```ts\nconst x = 1;\n``",
					expected: ["```ts", "  const x = 1;", "```"],
				},
				{
					input: "```md\nnot a closing fence:\n``\n```",
					expected: ["```md", "  not a closing fence:", "  ``", "```"],
				},
				{
					input: "```ts\n``",
					expected: ["```ts", "", "```"],
				},
				{
					input: "````\n```",
					expected: ["```", "", "```"],
				},
				{
					input: "~~~~~\n~~~~",
					expected: ["```", "", "```"],
				},
				{
					input: "```md\nnot a closing fence:\n``\n```\n\nafter",
					expected: ["```md", "  not a closing fence:", "  ``", "```", "", "after"],
				},
			];

			for (const { input, expected } of cases) {
				const markdown = new Markdown(input, 0, 0, defaultMarkdownTheme);
				const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

				expect(lines).toStrictEqual(expected);
			}

			const partial = new Markdown("```ts\nconst x = 1;\n``", 0, 0, defaultMarkdownTheme);
			const complete = new Markdown("```ts\nconst x = 1;\n```", 0, 0, defaultMarkdownTheme);

			expect(partial.render(80).length).toBe(complete.render(80).length);
		});
	});
});

describe("Markdown negative width safety", () => {
	it("does not throw at zero or negative widths", () => {
		const markdown = new Markdown("# Title\n\ntext\n\n---", 1, 1, defaultMarkdownTheme);
		expect(() => markdown.render(0)).not.toThrow();
		expect(() => markdown.render(-1)).not.toThrow();
	});
});
