import { describe, expect, it } from "vitest";
import {
	createInMemoryTaskStore,
	DurableAgentCoordinator,
	DurableFlowCoordinator,
	type RuntimeSnapshot,
	runtimeSnapshotHash,
	TaskController,
	validateFlowDefinition,
} from "../src/index.ts";

function snapshot(): RuntimeSnapshot {
	return {
		everVersion: "0.1.0",
		upstreamCommit: "test",
		protocolVersion: 1,
		model: { provider: "test", id: "faux" },
		systemPromptSha256: "prompt",
		contextFiles: [],
		resources: [],
		toolPolicySha256: "tools",
		sandboxPolicySha256: "sandbox",
	};
}

function setup() {
	const store = createInMemoryTaskStore(() => new Date("2026-08-14T00:00:00.000Z"));
	const controller = new TaskController(store);
	const task = controller.create({
		title: "flow",
		goal: "run a DAG",
		acceptance: [],
		budget: { maxTurns: 40, maxWallTimeMinutes: 60 },
		workspaceRoot: "/repo",
		workspaceFingerprint: "repo",
		toolPolicy: {
			allowedTools: ["read", "agent_report", "agent_message", "session_message"],
			allowedPaths: ["/repo"],
			readOnly: false,
			sandboxRequired: false,
		},
	});
	controller.submit(task.id);
	const main = store.listAgents(task.id)[0]!;
	store.transitionAgent(main.id, "running");
	const definition = {
		objective: "research then synthesize",
		nodes: [
			{
				key: "research_a",
				name: "research-a",
				role: "researcher",
				objective: "collect A",
				dependsOn: [],
				acceptance: [{ id: "a", kind: "manual" as const, description: "A delivered" }],
				scope: {
					paths: ["."],
					allowedTools: ["read", "agent_report", "session_message"],
					workspaceMode: "read_only_shared" as const,
				},
				budget: { maxTurns: 5, maxWallTimeMinutes: 10 },
				required: true,
			},
			{
				key: "research_b",
				name: "research-b",
				role: "researcher",
				objective: "collect B",
				dependsOn: [],
				acceptance: [{ id: "b", kind: "manual" as const, description: "B delivered" }],
				scope: {
					paths: ["."],
					allowedTools: ["read", "agent_report", "agent_message"],
					workspaceMode: "read_only_shared" as const,
				},
				budget: { maxTurns: 5, maxWallTimeMinutes: 10 },
				required: true,
			},
			{
				key: "synthesize",
				name: "synthesizer",
				role: "writer",
				objective: "combine A and B",
				dependsOn: ["research_a", "research_b"],
				acceptance: [{ id: "s", kind: "manual" as const, description: "summary delivered" }],
				scope: { paths: ["."], allowedTools: ["read", "agent_report"], workspaceMode: "read_only_shared" as const },
				budget: { maxTurns: 5, maxWallTimeMinutes: 10 },
				required: true,
			},
		],
	};
	return { store, controller, task, main, definition };
}

describe("durable Flow DAG", () => {
	it("validates DAG waves before creating any Agent", () => {
		const { store, definition } = setup();
		expect(validateFlowDefinition(definition)).toEqual([["research_a", "research_b"], ["synthesize"]]);
		expect(() =>
			validateFlowDefinition({
				...definition,
				nodes: definition.nodes.map((node) =>
					node.key === "research_a" ? { ...node, dependsOn: ["synthesize"] } : node,
				),
			}),
		).toThrow("dependency cycle");
		expect(() =>
			validateFlowDefinition({
				...definition,
				nodes: definition.nodes.map((node) =>
					node.key === "research_a"
						? { ...node, scope: { ...node.scope, workspaceMode: "isolated_worktree" as const } }
						: node,
				),
			}),
		).toThrow("requires change-bundle composition");
		store.close();
	});

	it("runs independent nodes concurrently and unlocks dependents only after accepted Episodes", async () => {
		const { store, task, main, definition } = setup();
		const flow = new DurableFlowCoordinator(store).define(
			{ taskId: task.id, agentId: main.id, kind: "main" },
			"flow-concurrent",
			definition,
		);
		const byKey = new Map(flow.nodes.map((node) => [node.key, node]));
		expect(new Set(store.listRunnableAgents(task.id, 4).map((agent) => agent.id))).toEqual(
			new Set([byKey.get("research_a")!.agentId, byKey.get("research_b")!.agentId]),
		);

		const coordinator = new DurableAgentCoordinator(store);
		const report = async (key: string, status: "completed" | "failed") => {
			const node = byKey.get(key)!;
			return coordinator.coordinate(
				{ taskId: task.id, agentId: node.agentId, kind: "subagent" },
				{
					type: "report",
					operationKey: `report-${key}`,
					dispatchId: node.dispatchId,
					status,
					summary: `${key} ${status}`,
					evidence: [{ id: key, kind: "event", ref: `event:${key}` }],
					acceptanceResults: [
						{ criterionId: key === "research_a" ? "a" : key === "research_b" ? "b" : "s", passed: true },
					],
				},
			);
		};
		await report("research_a", "completed");
		expect(store.listRunnableAgents(task.id, 4).map((agent) => agent.id)).toEqual([byKey.get("research_b")!.agentId]);
		await report("research_b", "completed");
		expect(store.listRunnableAgents(task.id, 4).map((agent) => agent.id)).toEqual([byKey.get("synthesize")!.agentId]);
		expect(
			store.listDependencyEpisodes(byKey.get("synthesize")!.agentId).map((episode) => ({
				node: episode.nodeKey,
				summary: episode.summary,
			})),
		).toEqual([
			{ node: "research_a", summary: "research_a completed" },
			{ node: "research_b", summary: "research_b completed" },
		]);
		await report("synthesize", "completed");
		expect(store.requireFlow(flow.id).state).toBe("completed");
		expect(
			new DurableFlowCoordinator(store).define(
				{ taskId: task.id, agentId: main.id, kind: "main" },
				"flow-concurrent",
				definition,
			).id,
		).toBe(flow.id);
		expect(() =>
			new DurableFlowCoordinator(store).define(
				{ taskId: task.id, agentId: main.id, kind: "main" },
				"flow-concurrent",
				{ ...definition, objective: "changed" },
			),
		).toThrow("reused with different input");
		expect(store.listEpisodes({ taskId: task.id, flowId: flow.id }).map((episode) => episode.status)).toEqual([
			"completed",
			"completed",
			"completed",
		]);
		store.close();
	});

	it("allows sibling Agent messages and skips downstream nodes after failure", async () => {
		const { store, task, main, definition } = setup();
		const flow = new DurableFlowCoordinator(store).define(
			{ taskId: task.id, agentId: main.id, kind: "main" },
			"flow-failure",
			definition,
		);
		const a = flow.nodes.find((node) => node.key === "research_a")!;
		const b = flow.nodes.find((node) => node.key === "research_b")!;
		const coordinator = new DurableAgentCoordinator(store);
		await expect(
			coordinator.coordinate(
				{ taskId: task.id, agentId: a.agentId, kind: "subagent" },
				{
					type: "message",
					operationKey: "sibling-message",
					recipientAgentId: b.agentId,
					messageType: "question",
					body: "What did you find?",
				},
			),
		).resolves.toMatchObject({ kind: "message" });
		await coordinator.coordinate(
			{ taskId: task.id, agentId: a.agentId, kind: "subagent" },
			{
				type: "report",
				operationKey: "a-failed",
				dispatchId: a.dispatchId,
				status: "failed",
				summary: "source unavailable",
				evidence: [{ id: "research-a-failed", kind: "event", ref: "event:research-a-failed" }],
				blockers: ["source"],
			},
		);
		const failed = store.requireFlow(flow.id);
		expect(failed.nodes.find((node) => node.key === "synthesize")?.state).toBe("skipped");
		expect(store.listRunnableAgents(task.id, 4).map((agent) => agent.id)).toEqual([b.agentId]);
		store.close();
	});

	it("requeues a running Flow node across Task pause and resume, then settles terminal Flow state", () => {
		const { store, controller, task, main, definition } = setup();
		const flow = new DurableFlowCoordinator(store).define(
			{ taskId: task.id, agentId: main.id, kind: "main" },
			"flow-cancel",
			definition,
		);
		const node = flow.nodes.find((candidate) => candidate.key === "research_a")!;
		const runtime = snapshot();
		store.claimAttempt({
			agentId: node.agentId,
			sessionId: "session-a",
			runtimeSnapshot: runtime,
			runtimeSnapshotSha256: runtimeSnapshotHash(runtime),
			workerId: "worker-a",
			executionId: "execution-a",
		});
		expect(store.requireFlow(flow.id).nodes.find((candidate) => candidate.key === node.key)?.state).toBe("running");

		controller.pause(task.id);
		expect(store.requireFlow(flow.id).nodes.find((candidate) => candidate.key === node.key)?.state).toBe("queued");
		controller.resume(task.id);
		expect(store.listRunnableAgents(task.id, 4).map((agent) => agent.id)).toContain(node.agentId);
		controller.cancel(task.id);
		expect(store.requireFlow(flow.id).state).toBe("cancelled");
		expect(store.requireAgentDispatch(node.dispatchId).state).toBe("cancelled");
		expect(() =>
			store.finalizeAgentDispatch({
				agent: store.requireAgent(node.agentId),
				dispatchId: node.dispatchId,
				status: "completed",
				messageId: "late",
				episode: { summary: "late", evidence: [], blockers: [], acceptanceResults: [] },
			}),
		).toThrow("already terminal");
		expect(store.requireFlow(flow.id).state).toBe("cancelled");
		store.close();
	});

	it("completes when only optional nodes fail", async () => {
		const { store, task, main, definition } = setup();
		const optional = { ...definition.nodes[0]!, required: false };
		const flow = new DurableFlowCoordinator(store).define(
			{ taskId: task.id, agentId: main.id, kind: "main" },
			"flow-optional",
			{ objective: "best effort research", nodes: [optional] },
		);
		const node = flow.nodes[0]!;
		expect(node.required).toBe(false);
		await new DurableAgentCoordinator(store).coordinate(
			{ taskId: task.id, agentId: node.agentId, kind: "subagent" },
			{
				type: "report",
				operationKey: "optional-failed",
				dispatchId: node.dispatchId,
				status: "failed",
				summary: "optional source unavailable",
				evidence: [],
				blockers: ["source"],
			},
		);
		expect(store.requireFlow(flow.id).state).toBe("completed");
		store.close();
	});

	it("freezes completed predecessor Episodes when a downstream Dispatch becomes runnable", async () => {
		const { store, task, main, definition } = setup();
		const flow = new DurableFlowCoordinator(store).define(
			{ taskId: task.id, agentId: main.id, kind: "main" },
			"flow-context",
			definition,
		);
		const sources = flow.nodes.filter((node) => node.key.startsWith("research_"));
		const target = flow.nodes.find((node) => node.key === "synthesize")!;
		for (const source of sources) {
			await new DurableAgentCoordinator(store).coordinate(
				{ taskId: task.id, agentId: source.agentId, kind: "subagent" },
				{
					type: "report",
					operationKey: `${source.key}-completed`,
					dispatchId: source.dispatchId,
					status: "completed",
					summary: `${source.key} handoff`,
					evidence: [{ id: source.key, kind: "event", ref: `event:${source.key}` }],
					blockers: [],
					acceptanceResults: [{ criterionId: source.key === "research_a" ? "a" : "b", passed: true }],
				},
			);
		}
		const superseding = store.createAgentDispatch({
			actor: main,
			agentId: sources[0]!.agentId,
			operationKey: "unrelated-later-work",
			action: "unrelated later work",
		}).dispatch;
		store.finalizeAgentDispatch({
			agent: store.requireAgent(sources[0]!.agentId),
			dispatchId: superseding.id,
			status: "completed",
			messageId: "later",
			episode: { summary: "unrelated later Episode", evidence: [], blockers: [], acceptanceResults: [] },
		});
		const prepared = store.prepareAgentDispatchContext(target.dispatchId);
		expect(prepared.contextManifest.sourceAgentIds).toEqual(sources.map((source) => source.agentId));
		expect(prepared.contextManifest.sourceEpisodes.map((episode) => episode.summary)).toEqual([
			"research_a handoff",
			"research_b handoff",
		]);
		store.close();
	});
});
