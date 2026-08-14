import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getLockstepWorkspacePackages, getReleasePackages } from "./release-packages.mjs";

test("selects only packages explicitly marked for Ever publication", () => {
	const root = mkdtempSync(join(tmpdir(), "ever-release-packages-"));
	try {
		const everDirectory = join(root, "ever");
		const internalDirectory = join(root, "internal");
		mkdirSync(everDirectory);
		mkdirSync(internalDirectory);
		writeFileSync(
			join(everDirectory, "package.json"),
			JSON.stringify({
				name: "@lioooooo123/ever-cli",
				version: "0.0.1",
				everRelease: true,
				everVersionPolicy: "independent",
			}),
		);
		writeFileSync(
			join(internalDirectory, "package.json"),
			JSON.stringify({ name: "@lioooooo123/ever-agent-core", version: "1.2.3" }),
		);

		assert.deepEqual(getReleasePackages(root), [
			{ directory: everDirectory, name: "@lioooooo123/ever-cli", version: "0.0.1" },
		]);
		assert.deepEqual(getLockstepWorkspacePackages(root), [
			{ directory: internalDirectory, name: "@lioooooo123/ever-agent-core", version: "1.2.3" },
		]);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});
