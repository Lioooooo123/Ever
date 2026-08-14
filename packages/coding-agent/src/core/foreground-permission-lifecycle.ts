import type { AgentRecord } from "@lioooooo123/ever-long-tasks";
import type {
	AgentSessionLifecycle,
	AgentSessionLifecycleDecision,
	AgentSessionLifecycleEvent,
} from "./agent-session-lifecycle.ts";
import type { AgentSessionRuntime } from "./agent-session-runtime.ts";
import { normalizeToolIntent, PermissionKernel, permissionIntentSha256 } from "./permission-kernel.ts";

/** Applies the same deterministic permission seam to ordinary, non-Task Sessions. */
export class ForegroundPermissionLifecycle implements AgentSessionLifecycle {
	private readonly runtime: AgentSessionRuntime;
	private readonly taskOwnsPermission: () => boolean;
	private readonly kernel = new PermissionKernel();

	constructor(runtime: AgentSessionRuntime, taskOwnsPermission: () => boolean) {
		this.runtime = runtime;
		this.taskOwnsPermission = taskOwnsPermission;
	}

	async handle(event: AgentSessionLifecycleEvent): Promise<AgentSessionLifecycleDecision | undefined> {
		if (event.type !== "before_tool" || this.taskOwnsPermission()) return undefined;
		const now = new Date().toISOString();
		const taskId = `foreground:${event.sessionId}`;
		const agent: AgentRecord = {
			id: taskId,
			taskId,
			kind: "main",
			name: "foreground",
			role: "interactive",
			objective: "Execute the current interactive Session safely",
			state: "running",
			depth: 0,
			workspaceMode: "primary",
			workspaceRoot: this.runtime.cwd,
			toolPolicy: {
				allowedTools: [...this.runtime.session.getActiveToolNames()],
				allowedPaths: [this.runtime.cwd],
				readOnly: false,
				sandboxRequired: false,
			},
			budget: { maxTurns: 1, maxWallTimeMinutes: 1 },
			createdAt: now,
			updatedAt: now,
		};
		const intent = normalizeToolIntent({
			operationId: event.operationId,
			taskId,
			attemptId: taskId,
			sessionId: event.sessionId,
			toolName: event.toolName,
			input: event.input,
			workspaceRoot: this.runtime.cwd,
			...(event.durability ? { metadata: event.durability } : {}),
		});
		const decision = await this.kernel.authorize(intent, {
			agent,
			attemptId: taskId,
			workspaceFingerprint: this.runtime.cwd,
			sandboxProfileSha256: "0".repeat(64),
			sandboxAvailable: false,
			unattended: false,
		});
		if (decision.action === "allow") return undefined;
		if (decision.action === "deny") return { block: true, reason: decision.reason, terminate: true };
		const approval = await this.runtime.requestPermissionApproval({
			intent,
			intentSha256: permissionIntentSha256(intent),
			code: decision.code,
			reason: decision.reason,
			suggestedScope: decision.suggestedScope,
			availableLifetimes: ["once"],
		});
		return approval?.action === "allow"
			? undefined
			: { block: true, reason: approval ? "User denied this action" : decision.reason, terminate: true };
	}
}
