import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { formatProgramResume, formatProgramResumeClear, takeProgramResumeToken } from "../src/index.ts";

function decodeOsc7577(sequence: string) {
	const prefix = "\x1b]7577;";
	const suffix = "\x1b\\";
	expect(sequence.startsWith(prefix)).toBe(true);
	expect(sequence.endsWith(suffix)).toBe(true);
	const body = sequence.slice(prefix.length, -suffix.length);
	const fields: Record<string, string> = {};
	for (const part of body.split(":")) {
		const eq = part.indexOf("=");
		expect(eq).toBeGreaterThan(0);
		fields[part.slice(0, eq)] = part.slice(eq + 1);
	}
	return fields;
}

describe("OSC 7577 program resume", () => {
	const sender = { token: "secret-token", pid: 4242, time: 1_700_000_000 };

	it("takes OSC7577_TOKEN out of the environment once", () => {
		const env: NodeJS.ProcessEnv = { OSC7577_TOKEN: "abc123", KEEP: "1" };
		expect(takeProgramResumeToken(env)).toBe("abc123");
		expect(env.OSC7577_TOKEN).toBeUndefined();
		expect(env.KEEP).toBe("1");
		expect(takeProgramResumeToken(env)).toBeUndefined();
		expect(takeProgramResumeToken({ OSC7577_TOKEN: "" })).toBeUndefined();
	});

	it("encodes base64 argv/cwd and authenticates the report body with SHA-256", () => {
		const seq = formatProgramResume(
			{ argv: ["kimi", "-r", "session-1"], cwd: "/tmp/work dir" },
			sender,
		);
		expect(seq).toBeDefined();
		const fields = decodeOsc7577(seq!);
		expect(fields.pid).toBe("4242");
		expect(fields.time).toBe("1700000000");
		expect(fields.argv!.split(",").map((part) => Buffer.from(part, "base64").toString("utf8"))).toEqual([
			"kimi",
			"-r",
			"session-1",
		]);
		expect(Buffer.from(fields.cwd!, "base64").toString("utf8")).toBe("/tmp/work dir");
		const payloadWithoutMac = seq!.slice("\x1b]7577;".length, seq!.lastIndexOf(":mac="));
		const expectedMac = createHash("sha256").update(`${payloadWithoutMac}:secret-token`, "utf8").digest("hex");
		expect(fields.mac).toBe(expectedMac);
	});

	it("encodes clear=1 reports", () => {
		const seq = formatProgramResumeClear(sender);
		const fields = decodeOsc7577(seq);
		expect(fields.clear).toBe("1");
		expect(fields.pid).toBe("4242");
	});

	it("returns undefined for non-reportable commands or oversized reports", () => {
		expect(formatProgramResume({ argv: [] }, sender)).toBeUndefined();
		expect(formatProgramResume({ argv: ["./local-bin"] }, sender)).toBeUndefined();
		expect(formatProgramResume({ argv: ["-bad"] }, sender)).toBeUndefined();
		expect(formatProgramResume({ argv: ["kimi"], cwd: "relative/dir" }, sender)).toBeUndefined();
		expect(formatProgramResume({ argv: ["kimi", "bad\narg"] }, sender)).toBeUndefined();
		expect(formatProgramResume({ argv: Array.from({ length: 65 }, (_, i) => `a${i}`) }, sender)).toBeUndefined();
		expect(formatProgramResume({ argv: ["kimi", "x".repeat(2000)] }, sender)).toBeUndefined();
	});
});
