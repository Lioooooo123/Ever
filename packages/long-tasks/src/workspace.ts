import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	copyFileSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkspaceSnapshot } from "./types.ts";

function sha256(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function assertInside(root: string, path: string): string {
	const relativePath = relative(root, path);
	if (
		relativePath === "" ||
		(!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
	) {
		return relativePath;
	}
	throw new Error(`Path escapes workspace: ${path}`);
}

function git(cwd: string, args: string[], input?: Uint8Array): Buffer {
	return execFileSync("git", args, { cwd, input, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
}

function suspiciousPath(path: string): boolean {
	return /(^|\/)(\.env(?:\.|$)|credentials?|secrets?|id_(?:rsa|ed25519)|[^/]+\.(?:pem|p12|key))$/i.test(path);
}

export interface WorkspaceAllocation {
	worktreePath: string;
	branch: string;
	snapshot: WorkspaceSnapshot;
	snapshotSha256: string;
}

export interface WorkspaceAllocatorOptions {
	worktreesRoot: string;
	artifactsRoot: string;
	maxUntrackedFileBytes?: number;
	now?: () => Date;
}

export class WorkspaceAllocator {
	private readonly worktreesRoot: string;
	private readonly artifactsRoot: string;
	private readonly maxUntrackedFileBytes: number;
	private readonly now: () => Date;

	constructor(options: WorkspaceAllocatorOptions) {
		this.worktreesRoot = options.worktreesRoot;
		this.artifactsRoot = options.artifactsRoot;
		this.maxUntrackedFileBytes = options.maxUntrackedFileBytes ?? 5 * 1024 * 1024;
		this.now = options.now ?? (() => new Date());
	}

	allocate(input: { repoRoot: string; taskId: string; agentId: string; paths: string[] }): WorkspaceAllocation {
		const repoRoot = realpathSync(input.repoRoot);
		const actualRoot = realpathSync(git(repoRoot, ["rev-parse", "--show-toplevel"]).toString("utf8").trim());
		if (actualRoot !== repoRoot) throw new Error(`Workspace must be the Git root: ${actualRoot}`);
		const relativeScopes = input.paths.map((path) => {
			const absolutePath = isAbsolute(path) ? realpathSync(path) : resolve(repoRoot, path);
			const relativePath = assertInside(repoRoot, absolutePath);
			return relativePath === "" ? "." : relativePath;
		});
		const branch = `karissa/task/${input.taskId.slice(0, 8)}/${input.agentId.slice(0, 8)}`;
		try {
			git(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
			throw new Error(`Worktree branch already exists: ${branch}`);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Worktree branch already exists")) throw error;
		}

		mkdirSync(this.artifactsRoot, { recursive: true, mode: 0o700 });
		chmodSync(this.artifactsRoot, 0o700);
		const lockPath = join(this.artifactsRoot, ".workspace-snapshot.lock");
		const lockFd = openSync(lockPath, "wx", 0o600);
		try {
			const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]).toString("utf8").trim();
			const patch = git(repoRoot, ["diff", "--binary", "HEAD", "--", ...relativeScopes]);
			const snapshotDir = join(this.artifactsRoot, input.taskId, input.agentId);
			mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
			const patchPath = join(snapshotDir, "tracked.patch");
			writeFileSync(patchPath, patch, { mode: 0o600 });
			const untracked = git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...relativeScopes])
				.toString("utf8")
				.split("\0")
				.filter((path) => path.length > 0);
			const untrackedFiles: WorkspaceSnapshot["untrackedFiles"] = [];
			for (const relativePath of untracked) {
				if (suspiciousPath(relativePath))
					throw new Error(`Potential credential cannot be snapshotted: ${relativePath}`);
				const sourcePath = join(repoRoot, relativePath);
				const stat = lstatSync(sourcePath);
				if (stat.isSymbolicLink()) throw new Error(`Symbolic link cannot be snapshotted safely: ${relativePath}`);
				if (!stat.isFile()) throw new Error(`Unsupported untracked path: ${relativePath}`);
				if (stat.size > this.maxUntrackedFileBytes)
					throw new Error(`Untracked file exceeds snapshot limit: ${relativePath}`);
				const content = readFileSync(sourcePath);
				const artifactRef = join(snapshotDir, "untracked", relativePath);
				mkdirSync(dirname(artifactRef), { recursive: true, mode: 0o700 });
				writeFileSync(artifactRef, content, { mode: 0o600 });
				untrackedFiles.push({ relativePath, artifactRef, sha256: sha256(content) });
			}
			const snapshot: WorkspaceSnapshot = {
				baseCommit,
				trackedPatchArtifact: patchPath,
				trackedPatchSha256: sha256(patch),
				untrackedFiles,
				excludedPaths: [],
				createdAt: this.now().toISOString(),
			};
			const snapshotSha256 = sha256(Buffer.from(JSON.stringify(snapshot)));
			const worktreePath = join(this.worktreesRoot, input.taskId, input.agentId);
			mkdirSync(dirname(worktreePath), { recursive: true, mode: 0o700 });
			git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseCommit]);
			if (patch.length > 0) git(worktreePath, ["apply", "--whitespace=nowarn", "-"], patch);
			for (const file of untrackedFiles) {
				const targetPath = join(worktreePath, file.relativePath);
				mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
				copyFileSync(file.artifactRef, targetPath);
				if (sha256(readFileSync(targetPath)) !== file.sha256)
					throw new Error(`Snapshot hash mismatch: ${file.relativePath}`);
			}
			return { worktreePath, branch, snapshot, snapshotSha256 };
		} finally {
			closeSync(lockFd);
			rmSync(lockPath, { force: true });
		}
	}
}
