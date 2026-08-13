import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digestPath } from "../../src/external-evals/hash.ts";

describe("digestPath", () => {
	it("orders directory entries by UTF-8 bytes across runtimes", async () => {
		const root = await mkdtemp(join(tmpdir(), "ever-digest-"));
		await mkdir(join(root, "files"));
		await writeFile(join(root, "files", "\u{10000}"), "astral");
		await writeFile(join(root, "files", "\uE000"), "private-use");

		const expected = createHash("sha256")
			.update("files/\uE000")
			.update("\0")
			.update("private-use")
			.update("files/\u{10000}")
			.update("\0")
			.update("astral")
			.digest("hex");
		expect(await digestPath(root)).toBe(expected);
	});
});
