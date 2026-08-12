import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SqliteTaskStore } from "./store.ts";
import type { EvidenceRef } from "./types.ts";

export interface ResolvedEvidence {
	evidence: EvidenceRef;
	verified: boolean;
	reason?: string;
	actualSha256?: string;
}

function isInside(root: string, path: string): boolean {
	const child = relative(root, path);
	return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

export class EvidenceResolver {
	private readonly store: SqliteTaskStore;

	constructor(store: SqliteTaskStore) {
		this.store = store;
	}

	resolve(taskId: string, evidence: readonly EvidenceRef[]): ResolvedEvidence[] {
		const task = this.store.requireTask(taskId);
		const workspaceRoot = realpathSync(task.workspaceRoot);
		return evidence.map((candidate) => {
			if (candidate.kind === "event") {
				const event = this.store.findEvent(taskId, candidate.ref);
				return event
					? { evidence: candidate, verified: true }
					: { evidence: candidate, verified: false, reason: "Task event does not exist" };
			}
			if (candidate.kind === "command") {
				return this.store.hasPassedAcceptance(taskId, candidate.ref)
					? { evidence: candidate, verified: true }
					: { evidence: candidate, verified: false, reason: "No passed command acceptance matches this ref" };
			}

			const path = resolve(workspaceRoot, candidate.ref);
			if (!isInside(workspaceRoot, path))
				return { evidence: candidate, verified: false, reason: "Evidence path escapes the Task workspace" };
			if (!existsSync(path) || !statSync(path).isFile())
				return { evidence: candidate, verified: false, reason: "Evidence path is not a file" };
			const actualSha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
			if (candidate.sha256 !== undefined && candidate.sha256 !== actualSha256)
				return {
					evidence: candidate,
					verified: false,
					reason: "Evidence content hash does not match",
					actualSha256,
				};
			return { evidence: candidate, verified: true, actualSha256 };
		});
	}
}
