import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

const run = promisify(execFile);

test("provider auth isolation list covers every known credential family", async () => {
	const { stdout } = await run("node_modules/.bin/tsx", ["scripts/list-provider-auth-env.ts"], {
		cwd: new URL("../", import.meta.url),
	});
	const names = new Set(stdout.trim().split("\n"));
	for (const name of [
		"OPENAI_API_KEY",
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_AUTH_TOKEN",
		"RADIUS_API_KEY",
		"NVIDIA_API_KEY",
		"GOOGLE_CLOUD_API_KEY",
		"CLOUDFLARE_API_KEY",
		"AWS_WEB_IDENTITY_TOKEN_FILE",
	]) {
		assert(names.has(name), `missing ${name}`);
	}
});
