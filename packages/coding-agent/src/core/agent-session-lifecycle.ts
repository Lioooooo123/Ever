import { AsyncLocalStorage } from "node:async_hooks";
import type { Api, AssistantMessage, Model, Usage } from "@lioooooo123/ever-ai/compat";

export type AgentSessionRequestKind = "agent" | "compaction" | "branch_summary";

export type AgentSessionLifecycleEvent =
	| { type: "before_turn"; sessionId: string; baseSystemPrompt: string }
	| {
			type: "before_request";
			sessionId: string;
			requestId: string;
			kind: AgentSessionRequestKind;
			model: Pick<Model<Api>, "provider" | "id" | "contextWindow" | "maxTokens" | "cost">;
	  }
	| {
			type: "after_response";
			sessionId: string;
			requestId: string;
			kind: AgentSessionRequestKind;
			message: AssistantMessage;
			usage: Usage;
	  }
	| {
			type: "before_tool";
			sessionId: string;
			operationId: string;
			toolCallId: string;
			toolName: string;
			input: Record<string, unknown>;
	  }
	| {
			type: "after_tool";
			sessionId: string;
			operationId: string;
			toolCallId: string;
			toolName: string;
			input: Record<string, unknown>;
			isError: boolean;
			resultSummary: string;
	  }
	| {
			type: "before_compaction";
			sessionId: string;
			reason: "manual" | "threshold" | "overflow";
	  }
	| {
			type: "after_compaction";
			sessionId: string;
			reason: "manual" | "threshold" | "overflow";
			entryId: string;
	  }
	| { type: "settled"; sessionId: string };

export interface AgentSessionLifecycleDecision {
	block?: boolean;
	reason?: string;
	terminate?: boolean;
	systemPrompt?: string;
}

/** Host-owned awaited lifecycle seam that extensions cannot replace. */
export interface AgentSessionLifecycle {
	handle(event: AgentSessionLifecycleEvent): Promise<AgentSessionLifecycleDecision | undefined>;
}

export interface AgentSessionLifecycleRef {
	current?: AgentSessionLifecycle;
}

const requestKindScope = new AsyncLocalStorage<AgentSessionRequestKind>();

export function currentAgentSessionRequestKind(): AgentSessionRequestKind {
	return requestKindScope.getStore() ?? "agent";
}

export function withAgentSessionRequestKind<T>(kind: AgentSessionRequestKind, operation: () => Promise<T>): Promise<T> {
	return requestKindScope.run(kind, operation);
}

export const NOOP_AGENT_SESSION_LIFECYCLE: AgentSessionLifecycle = {
	async handle() {
		return undefined;
	},
};
