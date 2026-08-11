import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type WorkerLifecycle = "resident" | "client_owned";
export type WorkerState = "starting" | "running" | "stopping" | "exited";

export interface WorkerDescriptor {
	schemaVersion: 1;
	workerId: string;
	agentId: string;
	taskId: string;
	activeSessionId: string;
	sessionPath?: string;
	pid: number;
	processGroupId: number;
	supervisorGeneration: string;
	previousSupervisorGeneration?: string;
	previousTokenSha256?: string;
	privateSocketPath: string;
	tokenSha256: string;
	workspaceRoot: string;
	lifecycle: WorkerLifecycle;
	state: WorkerState;
	heartbeatAt: string;
	startedAt: string;
}

export class WorkerRegistry {
	private readonly directory: string;

	constructor(runDirectory: string) {
		this.directory = join(runDirectory, "workers");
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		chmodSync(this.directory, 0o700);
	}

	write(descriptor: WorkerDescriptor): void {
		const path = join(this.directory, `${descriptor.agentId}.json`);
		const temporaryPath = `${path}.${process.pid}.tmp`;
		writeFileSync(temporaryPath, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporaryPath, path);
		chmodSync(path, 0o600);
	}

	list(): WorkerDescriptor[] {
		const descriptors: WorkerDescriptor[] = [];
		for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			try {
				const value = JSON.parse(readFileSync(join(this.directory, entry.name), "utf8")) as unknown;
				if (
					value !== null &&
					typeof value === "object" &&
					"schemaVersion" in value &&
					value.schemaVersion === 1 &&
					"agentId" in value &&
					typeof value.agentId === "string" &&
					"pid" in value &&
					typeof value.pid === "number"
				) {
					descriptors.push(value as WorkerDescriptor);
				}
			} catch {
				// Corrupt descriptors are ignored and reported by daemon doctor.
			}
		}
		return descriptors;
	}
}
