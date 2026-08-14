import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { PermissionGrantRecord, TaskRecord } from "@lioooooo123/ever-long-tasks";
import { workerSocketDirectory } from "./worker-socket.ts";

const PROVIDER_DOMAINS = [
	"api.anthropic.com",
	"api.openai.com",
	"chatgpt.com",
	"api.github.com",
	"github.com",
	"*.githubusercontent.com",
	"generativelanguage.googleapis.com",
	"*.googleapis.com",
	"api.mistral.ai",
	"api.groq.com",
	"api.x.ai",
	"openrouter.ai",
	"api.deepseek.com",
	"api.cohere.com",
];

export interface SandboxCapability {
	available: boolean;
	backend: "seatbelt" | "bubblewrap" | "unsupported";
	reason?: string;
}

export interface SandboxedCommand {
	command: string;
	sandboxId: string;
	profileSha256: string;
}

/** Unix-socket roots where sandboxed tools (tsx/vitest/etc.) create their IPC sockets under the sandbox TMPDIR. */
const SANDBOX_TMP_SOCKETS = ["/tmp/claude", "/private/tmp/claude"] as const;

export interface SandboxProfileExtension {
	allowedDomains?: readonly string[];
	writableRoots?: readonly string[];
	/** macOS only: allow pseudo-terminal operations so an interactive TUI can run inside the sandbox. */
	allowPty?: boolean;
}

export function unattendedSandboxAllowedDomains(profile: SandboxProfileExtension = {}): string[] {
	return [...new Set([...PROVIDER_DOMAINS, ...(profile.allowedDomains ?? [])])];
}

/** Derives the next Worker profile only from active grants visible to the Task workspace. */
export function sandboxProfileForTask(
	task: TaskRecord,
	grants: readonly PermissionGrantRecord[],
): SandboxProfileExtension {
	const applicable = grants.filter(
		(grant) =>
			grant.state === "active" &&
			(grant.taskId === task.id ||
				(["workspace", "project_policy"].includes(grant.lifetime) &&
					grant.workspaceFingerprint === task.workspaceFingerprint)),
	);
	return {
		allowedDomains: [...new Set(applicable.flatMap((grant) => grant.scope.networkDomains))],
		writableRoots: [...new Set(applicable.flatMap((grant) => grant.scope.pathPrefixes))],
	};
}

function sandboxBackend(): SandboxCapability["backend"] {
	if (process.platform === "darwin") return "seatbelt";
	if (process.platform === "linux") return "bubblewrap";
	return "unsupported";
}

export function probeUnattendedSandbox(): SandboxCapability {
	const backend = sandboxBackend();
	if (backend === "unsupported")
		return { available: false, backend, reason: `Unsupported platform: ${process.platform}` };
	const dependencies = SandboxManager.checkDependencies();
	if (dependencies.errors.length > 0) {
		return {
			available: false,
			backend,
			reason: dependencies.errors.join(", "),
		};
	}
	return { available: true, backend };
}

/** Owns the OS sandbox runtime and emits one restricted process-tree command per Task workspace. */
export class UnattendedSandbox {
	private readonly agentDir: string;
	private initialized = false;

	constructor(agentDir: string) {
		this.agentDir = agentDir;
	}

	async initialize(profile: SandboxProfileExtension = {}): Promise<SandboxCapability> {
		const capability = probeUnattendedSandbox();
		if (!capability.available) return capability;
		const config: SandboxRuntimeConfig = {
			network: {
				allowedDomains: unattendedSandboxAllowedDomains(profile),
				deniedDomains: [],
				allowUnixSockets: [
					join(this.agentDir, "run"),
					workerSocketDirectory(this.agentDir),
					...SANDBOX_TMP_SOCKETS,
				],
				allowLocalBinding: false,
			},
			filesystem: {
				denyRead: [
					join(this.agentDir, "auth.json"),
					join(this.agentDir, "run", "control-token"),
					join(this.agentDir, "run", "client-id"),
					join(homedir(), ".ssh"),
					join(homedir(), ".aws"),
					join(homedir(), ".gnupg"),
					join(homedir(), ".kube"),
					join(homedir(), ".config", "gcloud"),
					join(homedir(), ".config", "gh"),
					join(homedir(), ".docker"),
					join(homedir(), ".netrc"),
					join(homedir(), ".npmrc"),
				],
				allowWrite: [],
				denyWrite: [
					join(this.agentDir, "auth.json"),
					join(this.agentDir, "run", "control-token"),
					join(this.agentDir, "run", "client-id"),
				],
				allowGitConfig: false,
			},
			allowPty: profile.allowPty ?? false,
		};
		await SandboxManager.initialize(config, undefined, false);
		this.initialized = true;
		return capability;
	}

	async wrap(
		command: string,
		args: readonly string[],
		workspaceRoot: string,
		profile: SandboxProfileExtension = {},
	): Promise<SandboxedCommand> {
		if (!this.initialized) throw new Error("Unattended sandbox is not initialized");
		const config: SandboxRuntimeConfig = {
			network: {
				allowedDomains: unattendedSandboxAllowedDomains(profile),
				deniedDomains: [],
			},
			filesystem: {
				denyRead: [
					join(this.agentDir, "auth.json"),
					join(this.agentDir, "run", "control-token"),
					join(this.agentDir, "run", "client-id"),
					join(homedir(), ".ssh"),
					join(homedir(), ".aws"),
					join(homedir(), ".gnupg"),
					join(homedir(), ".kube"),
					join(homedir(), ".config", "gcloud"),
					join(homedir(), ".config", "gh"),
					join(homedir(), ".docker"),
					join(homedir(), ".netrc"),
					join(homedir(), ".npmrc"),
				],
				allowWrite: [
					workspaceRoot,
					this.agentDir,
					workerSocketDirectory(this.agentDir),
					tmpdir(),
					...(profile.writableRoots ?? []),
				],
				denyWrite: [
					join(this.agentDir, "auth.json"),
					join(this.agentDir, "run", "control-token"),
					join(this.agentDir, "run", "client-id"),
					join(workspaceRoot, ".env"),
					join(workspaceRoot, ".env.*"),
					join(workspaceRoot, "*.pem"),
					join(workspaceRoot, "*.key"),
				],
				allowGitConfig: false,
			},
			allowPty: profile.allowPty ?? false,
		};
		const serialized = [command, ...args].map((value) => `'${value.replaceAll("'", `'\\''`)}'`).join(" ");
		const wrapped = await SandboxManager.wrapWithSandbox(serialized, undefined, config);
		return {
			command: wrapped,
			sandboxId: `${sandboxBackend()}:${randomUUID()}`,
			profileSha256: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
		};
	}

	async reinitialize(profile: SandboxProfileExtension): Promise<SandboxCapability> {
		await this.close();
		return this.initialize(profile);
	}

	/** Hot-update the network allowlist for already-running sandboxed processes via the host proxy. */
	updateAllowedDomains(domains: readonly string[]): void {
		if (!this.initialized) throw new Error("Unattended sandbox is not initialized");
		const valid = domains.filter((domain) => domain.trim() !== "" && domain !== "*" && !/[\s/]/u.test(domain));
		if (valid.length === 0) return;
		const current = SandboxManager.getConfig();
		if (!current) throw new Error("Sandbox configuration is unavailable");
		const next: SandboxRuntimeConfig = {
			...current,
			network: {
				...current.network,
				allowedDomains: [...new Set([...current.network.allowedDomains, ...valid])],
			},
		};
		SandboxManager.updateConfig(next);
	}

	async close(): Promise<void> {
		if (!this.initialized) return;
		this.initialized = false;
		await SandboxManager.reset();
	}
}
