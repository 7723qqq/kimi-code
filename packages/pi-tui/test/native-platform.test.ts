import { readFileSync } from "node:fs";
import { createRequire, Module } from "node:module";
import { expect, mock, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { getNativeClipboard, getNativePlatformHelper } from "../src/native-platform.ts";

test("Linux ARM64 prebuild supports 64 KB system pages", () => {
	const binary = readFileSync(
		new URL("../native/linux/prebuilds/linux-arm64/linux-platform-x11.node", import.meta.url),
	);
	expect(binary.subarray(0, 4).toString()).toBe("\x7fELF");
	const offset = Number(binary.readBigUInt64LE(32));
	const entrySize = binary.readUInt16LE(54);
	const count = binary.readUInt16LE(56);
	let loadSegments = 0;
	for (let index = 0; index < count; index++) {
		const entry = offset + index * entrySize;
		if (binary.readUInt32LE(entry) !== 1) continue;
		loadSegments++;
		const fileOffset = binary.readBigUInt64LE(entry + 8);
		const address = binary.readBigUInt64LE(entry + 16);
		expect((address - fileOffset) % 65536n).toBe(0n);
		expect(binary.readBigUInt64LE(entry + 48) >= 65536n).toBeTruthy();
	}
	expect(loadSegments > 0).toBeTruthy();
});

// Opt in on a Windows test desktop: this replaces the system clipboard contents.
test.skipIf(process.platform !== "win32" || process.env.PI_TEST_NATIVE_CLIPBOARD !== "1")(
	"writes Windows clipboard text through the native helper without command fallbacks",
	async () => {
		const clipboard = getNativeClipboard();
		expect(clipboard?.setText).toBeTruthy();
		for (const text of ["clipboard café 日本語", "", "second write"]) {
			await clipboard.setText(text);
			expect(await clipboard.getText()).toBe(text);
			expect(await clipboard.getImage()).toBe(null);
		}
	},
);

test.skipIf(!["darwin", "win32"].includes(process.platform) || !["arm64", "x64"].includes(process.arch))(
	"uses the native platform helper directly as the clipboard API",
	() => {
		const clipboard = getNativeClipboard();
		expect(clipboard).toBeTruthy();
		expect(typeof clipboard.getText).toBe("function");
		expect(typeof clipboard.getImage).toBe("function");
		expect(typeof clipboard.setText).toBe("function");
		expect(clipboard).toBe(getNativePlatformHelper());
		expect(clipboard).toBe(getNativeClipboard());
	},
);

test.skipIf(!["arm64", "x64"].includes(process.arch))(
	"Linux loads X11 lazily and rechecks DISPLAY",
	async () => {
		const require = createRequire(import.meta.url);
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		const display = process.env.DISPLAY;
		const waylandDisplay = process.env.WAYLAND_DISPLAY;
		const modulePath = fileURLToPath(
			new URL(`../native/linux/prebuilds/linux-${process.arch}/linux-platform-x11.node`, import.meta.url),
		);
		const previous = require.cache[modulePath];
		try {
			Object.defineProperty(process, "platform", { value: "linux" });
			delete process.env.DISPLAY;
			process.env.WAYLAND_DISPLAY = "wayland-0";
			expect(getNativeClipboard()).toBe(undefined); // Wayland paste uses wl-paste.
			let available = false;
			const helper = {
				getText: mock(async () => (available ? "X11" : undefined)),
				getImage: mock(async () => null),
			};
			const module = new Module(modulePath);
			module.exports = helper;
			require.cache[modulePath] = module;
			process.env.DISPLAY = ":0";
			const clipboard = getNativeClipboard()!;
			expect(clipboard).toBe(helper);
			expect(helper.getText.mock.calls.length).toBe(0);
			expect(await clipboard.getText()).toBe(undefined);
			available = true;
			expect(await clipboard.getText()).toBe("X11");
			expect(await clipboard.getImage()).toBe(null);
			delete process.env.DISPLAY;
			expect(getNativeClipboard()).toBe(undefined);
			process.env.DISPLAY = ":1";
			expect(getNativeClipboard()).toBe(clipboard);
		} finally {
			Object.defineProperty(process, "platform", platform);
			if (display === undefined) delete process.env.DISPLAY;
			else process.env.DISPLAY = display;
			if (waylandDisplay === undefined) delete process.env.WAYLAND_DISPLAY;
			else process.env.WAYLAND_DISPLAY = waylandDisplay;
			if (previous) require.cache[modulePath] = previous;
			else delete require.cache[modulePath];
		}
	},
);
