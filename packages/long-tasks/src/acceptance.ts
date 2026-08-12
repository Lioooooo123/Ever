import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SqliteTaskStore } from "./store.ts";

function inside(root: string, path: string): boolean {
	const value = relative(root, path);
	return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

export class AcceptanceRunner {
	private readonly store: SqliteTaskStore;

	constructor(store: SqliteTaskStore) {
		this.store = store;
	}

	runAutomated(
		taskId: string,
		requestId: string,
	): { passed: string[]; failed: string[]; pendingManual: string[]; outcomeUnknown: string[] } {
		const task = this.store.requireTask(taskId);
		const workspaceRoot = realpathSync(task.workspaceRoot);
		const passed: string[] = [];
		const failed: string[] = [];
		const pendingManual: string[] = [];
		const outcomeUnknown: string[] = [];
		for (const criterion of task.acceptance) {
			if (criterion.kind === "manual") {
				(this.store.hasPassedAcceptance(taskId, criterion.id) ? passed : pendingManual).push(criterion.id);
				continue;
			}
			if (criterion.kind === "agent_evidence") {
				(this.store.hasPassedAcceptance(taskId, criterion.id) ? passed : pendingManual).push(criterion.id);
				continue;
			}
			if (criterion.kind === "command") {
				const cwd = resolve(workspaceRoot, criterion.cwd);
				if (!inside(workspaceRoot, cwd)) throw new Error(`Acceptance cwd escapes workspace: ${criterion.cwd}`);
				const execution = this.store.beginAcceptanceCommand(taskId, requestId, criterion.id);
				if (execution === "unknown") {
					outcomeUnknown.push(criterion.id);
					continue;
				}
				if (execution === "finished") {
					(this.store.hasPassedAcceptance(taskId, criterion.id) ? passed : failed).push(criterion.id);
					continue;
				}
				const result = spawnSync(criterion.command, {
					cwd,
					shell: true,
					encoding: "utf8",
					timeout: criterion.timeoutSeconds * 1000,
					maxBuffer: 1024 * 1024,
				});
				const success = result.status === 0 && !result.error;
				this.store.finishAcceptanceCommand(taskId, requestId, criterion.id, success, {
					exitCode: result.status,
					signal: result.signal,
					stdoutSha256: createHash("sha256")
						.update(result.stdout ?? "")
						.digest("hex"),
					stderrSha256: createHash("sha256")
						.update(result.stderr ?? "")
						.digest("hex"),
				});
				(success ? passed : failed).push(criterion.id);
				continue;
			}
			const path = resolve(workspaceRoot, criterion.path);
			if (!inside(workspaceRoot, path)) throw new Error(`Acceptance artifact escapes workspace: ${criterion.path}`);
			const actualSha256 = existsSync(path)
				? createHash("sha256").update(readFileSync(path)).digest("hex")
				: undefined;
			const success = actualSha256 !== undefined && (!criterion.sha256 || criterion.sha256 === actualSha256);
			this.store.recordAcceptance(taskId, criterion.id, success, { path: criterion.path, actualSha256 });
			(success ? passed : failed).push(criterion.id);
		}
		return { passed, failed, pendingManual, outcomeUnknown };
	}
}
