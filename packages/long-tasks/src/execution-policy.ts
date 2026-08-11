import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { AgentRecord } from "./types.ts";

export type ToolEffect = "read_only" | "reconcilable_write" | "process" | "external_side_effect";

export interface NormalizedToolCall {
	name: string;
	paths: string[];
	effect: ToolEffect;
}

export type AuthorizationDecision = { allowed: true } | { allowed: false; code: string; reason: string };

export interface ToolExecutionContext {
	sandboxAvailable: boolean;
	unattended: boolean;
	unsafeNoSandbox?: boolean;
}

function canonicalize(path: string): string {
	let existing = resolve(path);
	const suffix: string[] = [];
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) break;
		suffix.unshift(existing.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
		existing = parent;
	}
	return resolve(realpathSync(existing), ...suffix);
}

function isInside(path: string, root: string): boolean {
	const resolvedPath = canonicalize(path);
	const resolvedRoot = realpathSync(root);
	const child = relative(resolvedRoot, resolvedPath);
	return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

export class ExecutionPolicy {
	authorizeTool(agent: AgentRecord, call: NormalizedToolCall, context: ToolExecutionContext): AuthorizationDecision {
		if (!agent.toolPolicy.allowedTools.includes(call.name)) {
			return { allowed: false, code: "tool_not_allowed", reason: `${call.name} is outside the agent tool policy` };
		}
		if (!call.paths.every((path) => agent.toolPolicy.allowedPaths.some((root) => isInside(path, root)))) {
			return { allowed: false, code: "path_not_allowed", reason: "Tool path is outside the delegated scope" };
		}
		if (agent.toolPolicy.readOnly && call.effect !== "read_only") {
			return {
				allowed: false,
				code: "read_only_violation",
				reason: "Read-only agents cannot execute side-effecting tools",
			};
		}
		if (agent.toolPolicy.sandboxRequired && !context.sandboxAvailable) {
			return { allowed: false, code: "sandbox_required", reason: "The agent policy requires an execution sandbox" };
		}
		if (
			context.unattended &&
			call.effect !== "read_only" &&
			!context.sandboxAvailable &&
			context.unsafeNoSandbox !== true
		) {
			return {
				allowed: false,
				code: "unattended_sandbox_required",
				reason: "Unattended side-effecting tools require an execution sandbox",
			};
		}
		return { allowed: true };
	}
}

export function defaultToolEffect(toolName: string): ToolEffect {
	if (["read", "grep", "find", "ls", "read_only_command"].includes(toolName)) return "read_only";
	if (["edit", "write"].includes(toolName)) return "reconcilable_write";
	if (toolName === "bash") return "process";
	return "external_side_effect";
}
