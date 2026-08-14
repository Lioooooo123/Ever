import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Writable } from "node:stream";
import { sanitizeUnattendedEnvironment } from "./secret-environment.ts";
import {
	type SandboxCapability,
	type SandboxedCommand,
	type SandboxProfileExtension,
	UnattendedSandbox,
	unattendedSandboxAllowedDomains,
} from "./unattended-sandbox.ts";

export interface SessionExecutionEnvironment {
	trust: "sandboxed" | "unsafe_host";
	backend: SandboxCapability["backend"];
	workspaceRoot: string;
	sandboxId?: string;
	profileSha256?: string;
	allowedDomains: readonly string[];
	writableRoots: readonly string[];
}

export interface HostedSessionProcess {
	child: ReturnType<typeof spawn>;
	tokenChannel: Writable;
	environment: SessionExecutionEnvironment;
}

export interface SessionProcessStartRequest {
	command: string;
	args: readonly string[];
	cwd: string;
	logFd: number;
	env: NodeJS.ProcessEnv;
	profile?: SandboxProfileExtension;
}

/** Owns sandbox initialization and process launch for Session workers. */
export class SessionExecutionHost {
	private readonly sandbox: UnattendedSandbox | undefined;
	private capability?: SandboxCapability;

	constructor(agentDir: string, unsafeNoSandbox: boolean) {
		this.sandbox = unsafeNoSandbox ? undefined : new UnattendedSandbox(agentDir);
	}

	async initialize(profile: SandboxProfileExtension = {}): Promise<SandboxCapability> {
		this.validateProfile(profile);
		this.capability = this.sandbox
			? await this.sandbox.initialize(profile)
			: { available: false, backend: "unsupported", reason: "explicitly disabled" };
		return this.capability;
	}

	async start(request: SessionProcessStartRequest): Promise<HostedSessionProcess> {
		if (!this.capability) throw new Error("Session execution host is not initialized");
		if (this.sandbox && !this.capability.available) {
			throw new Error(this.capability.reason ?? "Session execution sandbox is unavailable");
		}
		this.validateProfile(request.profile);
		let sandboxed: SandboxedCommand | undefined;
		if (this.sandbox)
			sandboxed = await this.sandbox.wrap(request.command, request.args, request.cwd, request.profile);
		const child = spawn(sandboxed?.command ?? request.command, sandboxed ? [] : [...request.args], {
			cwd: request.cwd,
			detached: true,
			shell: sandboxed !== undefined,
			stdio: ["ignore", request.logFd, request.logFd, "pipe"],
			env: {
				...sanitizeUnattendedEnvironment(process.env),
				...request.env,
			},
		});
		const tokenChannel = child.stdio[3];
		if (!tokenChannel || typeof tokenChannel === "number" || !("write" in tokenChannel)) {
			child.kill("SIGTERM");
			throw new Error("Session Worker token channel did not open");
		}
		return {
			child,
			tokenChannel,
			environment: {
				trust: sandboxed ? "sandboxed" : "unsafe_host",
				backend: this.capability.backend,
				workspaceRoot: request.cwd,
				allowedDomains: sandboxed ? unattendedSandboxAllowedDomains(request.profile) : [],
				writableRoots: sandboxed ? [request.cwd, ...(request.profile?.writableRoots ?? [])] : [],
				...(sandboxed ? { sandboxId: sandboxed.sandboxId, profileSha256: sandboxed.profileSha256 } : {}),
			},
		};
	}

	async close(): Promise<void> {
		await this.sandbox?.close();
	}

	private validateProfile(profile: SandboxProfileExtension | undefined): void {
		if (profile?.writableRoots?.some((root) => !isAbsolute(root)))
			throw new Error("Sandbox writable roots must be absolute");
		if (profile?.allowedDomains?.some((domain) => domain.trim() === "" || domain === "*" || /[\s/]/u.test(domain)))
			throw new Error("Sandbox allowed domains must be explicit hostnames");
	}
}
