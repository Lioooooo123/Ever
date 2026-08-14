import { createHash } from "node:crypto";
import type { SqliteTaskStore } from "./store.ts";
import type { AgentIdentity, FlowDefinition, FlowRecord } from "./types.ts";
import type { WorkspaceAllocator } from "./workspace.ts";

const MAX_FLOW_NODES = 32;

export function validateFlowDefinition(definition: FlowDefinition): string[][] {
	if (definition.objective.trim() === "") throw new Error("Flow objective is required");
	if (definition.nodes.length === 0 || definition.nodes.length > MAX_FLOW_NODES)
		throw new Error(`Flow must contain 1..${MAX_FLOW_NODES} nodes`);
	const keys = new Set<string>();
	for (const node of definition.nodes) {
		if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(node.key)) throw new Error(`Invalid Flow node key: ${node.key}`);
		if (keys.has(node.key)) throw new Error(`Duplicate Flow node key: ${node.key}`);
		keys.add(node.key);
		if (!node.scope.allowedTools.includes("agent_report"))
			throw new Error(`Flow node must allow agent_report: ${node.key}`);
		const orchestrationTool = node.scope.allowedTools.find((tool) =>
			["agent_spawn", "delegate_task", "flow_define", "task_update"].includes(tool),
		);
		if (orchestrationTool)
			throw new Error(`Flow node cannot allow orchestration tool ${orchestrationTool}: ${node.key}`);
		if (node.dependsOn.includes(node.key)) throw new Error(`Flow node cannot depend on itself: ${node.key}`);
	}
	for (const node of definition.nodes) {
		if (new Set(node.dependsOn).size !== node.dependsOn.length)
			throw new Error(`Duplicate Flow dependency for ${node.key}`);
		for (const dependency of node.dependsOn) {
			if (!keys.has(dependency)) throw new Error(`Unknown Flow dependency ${dependency} for ${node.key}`);
		}
	}
	const pending = new Map(definition.nodes.map((node) => [node.key, new Set(node.dependsOn)]));
	const waves: string[][] = [];
	while (pending.size > 0) {
		const wave = [...pending.entries()]
			.filter(([, dependencies]) => dependencies.size === 0)
			.map(([key]) => key)
			.sort();
		if (wave.length === 0) throw new Error("Flow graph contains a dependency cycle");
		waves.push(wave);
		for (const key of wave) pending.delete(key);
		for (const dependencies of pending.values()) {
			for (const key of wave) dependencies.delete(key);
		}
	}
	return waves;
}

export class DurableFlowCoordinator {
	private readonly store: SqliteTaskStore;
	private readonly workspaceAllocator?: WorkspaceAllocator;

	constructor(store: SqliteTaskStore, options?: { workspaceAllocator?: WorkspaceAllocator }) {
		this.store = store;
		this.workspaceAllocator = options?.workspaceAllocator;
	}

	define(actorIdentity: AgentIdentity, definition: FlowDefinition): FlowRecord {
		validateFlowDefinition(definition);
		const actor = this.store.requireAgent(actorIdentity.agentId);
		if (actor.taskId !== actorIdentity.taskId || actor.kind !== actorIdentity.kind)
			throw new Error("Agent identity mismatch");
		const allocations = new Map<
			string,
			{
				workspaceRoot: string;
				workspaceSnapshot: ReturnType<WorkspaceAllocator["allocate"]>["snapshot"];
				workspaceSnapshotSha256: string;
			}
		>();
		for (const node of definition.nodes) {
			if (node.scope.workspaceMode !== "isolated_worktree") continue;
			if (!this.workspaceAllocator) throw new Error("Isolated Flow nodes require a WorkspaceAllocator");
			const allocation = this.workspaceAllocator.allocate({
				repoRoot: actor.workspaceRoot,
				taskId: actor.taskId,
				agentId: createHash("sha256").update(`${actor.taskId}\0${node.key}`).digest("hex").slice(0, 32),
				paths: node.scope.paths,
			});
			allocations.set(node.key, {
				workspaceRoot: allocation.worktreePath,
				workspaceSnapshot: allocation.snapshot,
				workspaceSnapshotSha256: allocation.snapshotSha256,
			});
		}
		return this.store.createFlow(actor, definition, allocations);
	}
}
