import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

function gitValue(cwd: string, args: string[]): string | undefined {
	try {
		return (
			execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined
		);
	} catch {
		return undefined;
	}
}

/** Stable identity shared by ordinary Sessions and persisted Tasks. */
export function workspaceIdentity(cwd: string): { root: string; fingerprint: string; head?: string } {
	const root = gitValue(cwd, ["rev-parse", "--show-toplevel"]) ?? realpathSync(cwd);
	const remote =
		gitValue(root, ["remote", "get-url", "origin"]) ??
		gitValue(root, ["remote", "get-url", "upstream"]) ??
		"no-remote";
	const branch = gitValue(root, ["branch", "--show-current"]) ?? "detached";
	const head = gitValue(root, ["rev-parse", "HEAD"]);
	return {
		root,
		fingerprint: createHash("sha256")
			.update(`${realpathSync(root)}\0${remote}\0${branch}`)
			.digest("hex"),
		...(head ? { head } : {}),
	};
}
