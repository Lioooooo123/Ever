import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { workerSocketDirectory } from "./worker-socket.ts";

const PROVIDER_DOMAINS = [
	"api.anthropic.com",
	"api.openai.com",
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

function sandboxBackend(): SandboxCapability["backend"] {
	if (process.platform === "darwin") return "seatbelt";
	if (process.platform === "linux") return "bubblewrap";
	return "unsupported";
}

export function probeUnattendedSandbox(): SandboxCapability {
	const backend = sandboxBackend();
	if (backend === "unsupported")
		return { available: false, backend, reason: `Unsupported platform: ${process.platform}` };
	if (!SandboxManager.checkDependencies()) {
		return {
			available: false,
			backend,
			reason:
				backend === "bubblewrap"
					? "Sandbox requires rg, bwrap, and socat"
					: "Sandbox requires rg and the macOS Seatbelt runtime",
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

	async initialize(): Promise<SandboxCapability> {
		const capability = probeUnattendedSandbox();
		if (!capability.available) return capability;
		const config: SandboxRuntimeConfig = {
			network: {
				allowedDomains: PROVIDER_DOMAINS,
				deniedDomains: [],
				allowUnixSockets: [join(this.agentDir, "run"), workerSocketDirectory(this.agentDir)],
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
		};
		await SandboxManager.initialize(config, undefined, false);
		this.initialized = true;
		return capability;
	}

	async wrap(command: string, args: readonly string[], workspaceRoot: string): Promise<SandboxedCommand> {
		if (!this.initialized) throw new Error("Unattended sandbox is not initialized");
		const config: SandboxRuntimeConfig = {
			network: { allowedDomains: PROVIDER_DOMAINS, deniedDomains: [] },
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
				allowWrite: [workspaceRoot, this.agentDir, tmpdir()],
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
		};
		const serialized = [command, ...args].map((value) => `'${value.replaceAll("'", `'\\''`)}'`).join(" ");
		const wrapped = await SandboxManager.wrapWithSandbox(serialized, undefined, config);
		return {
			command: wrapped,
			sandboxId: `${sandboxBackend()}:${randomUUID()}`,
			profileSha256: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
		};
	}

	async close(): Promise<void> {
		if (!this.initialized) return;
		this.initialized = false;
		await SandboxManager.reset();
	}
}
