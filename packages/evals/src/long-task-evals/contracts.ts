import type { AgentIdentity, EnvironmentIdentity, EvalCase, EvalRunResult } from "./schemas.ts";

export interface EnvironmentCommand {
	args: string[];
	cwd?: string;
	env?: Record<string, string>;
	timeoutSeconds: number;
}

export interface EnvironmentCommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export interface EvalEnvironment {
	readonly identity: EnvironmentIdentity;
	exec(command: EnvironmentCommand): Promise<EnvironmentCommandResult>;
	copyIn(source: string, destination: string): Promise<void>;
	copyOut(source: string, destination: string): Promise<void>;
	readFile(path: string): Promise<string | undefined>;
	destroy(): Promise<void>;
}

export interface EnvironmentAdapter {
	preflight(): Promise<void>;
	create(testCase: EvalCase, runDirectory: string): Promise<EvalEnvironment>;
}

export interface AgentRunOutcome {
	outcome: EvalRunResult["outcome"];
	usage: Omit<EvalRunResult["usage"], "wallTimeMs">;
	karissa?: EvalRunResult["karissa"];
	errors: EvalRunResult["errors"];
}

export interface AgentAdapter {
	readonly identity: AgentIdentity;
	run(
		testCase: EvalCase,
		environment: EvalEnvironment,
		runDirectory: string,
		budget: { maxCostUsd?: number },
	): Promise<AgentRunOutcome>;
	stop(reason: "timeout" | "cancelled" | "fault"): Promise<void>;
}

export interface OfficialVerification {
	valid: boolean;
	metrics: Record<string, number>;
	exitCode?: number;
	errors: EvalRunResult["errors"];
}

export interface BenchmarkAdapter {
	listCases(): Promise<EvalCase[]>;
	verify(testCase: EvalCase, environment: EvalEnvironment, runDirectory: string): Promise<OfficialVerification>;
}
