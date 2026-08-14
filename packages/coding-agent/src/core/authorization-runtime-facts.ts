import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export function readGitAuthorizationFacts(cwd: string): { gitHead?: string; changeSetSha256?: string } {
	try {
		const gitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
		const diff = execFileSync("git", ["diff", "--no-ext-diff", "--full-index", "--binary", "HEAD"], {
			cwd,
			maxBuffer: 64 * 1024 * 1024,
		});
		const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
			cwd,
			encoding: "utf8",
		})
			.split("\0")
			.filter(Boolean)
			.sort();
		const digest = createHash("sha256").update(diff);
		for (const path of untracked) {
			const blobSha = execFileSync("git", ["hash-object", "--no-filters", "--", path], {
				cwd,
				encoding: "utf8",
			}).trim();
			digest.update("\0").update(path).update("\0").update(blobSha);
		}
		return { gitHead, changeSetSha256: digest.digest("hex") };
	} catch {
		return {};
	}
}

export function readPrHeadSha(command: string | undefined, cwd: string): string | undefined {
	if (!command) return undefined;
	const parts = command.trim().replace(/\s+/gu, " ").split(" ");
	if (parts[0] !== "gh" || parts[1] !== "pr" || parts[2] !== "merge") return undefined;
	const pr = parts[3]?.startsWith("-") ? undefined : parts[3];
	const repoIndex = parts.indexOf("--repo");
	const repository =
		repoIndex >= 0 ? parts[repoIndex + 1] : parts.find((part) => part.startsWith("--repo="))?.slice("--repo=".length);
	try {
		return execFileSync(
			"gh",
			[
				"pr",
				"view",
				...(pr ? [pr] : []),
				...(repository ? ["--repo", repository] : []),
				"--json",
				"headRefOid",
				"--jq",
				".headRefOid",
			],
			{ cwd, encoding: "utf8", timeout: 15_000 },
		).trim();
	} catch {
		return undefined;
	}
}
