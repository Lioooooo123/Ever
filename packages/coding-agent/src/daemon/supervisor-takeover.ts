import { deriveWorkerToken, workerTokenMatches } from "./supervisor-credentials.ts";
import { requestWorker, type WorkerResponse } from "./worker-host.ts";
import type { WorkerDescriptor } from "./worker-registry.ts";

export interface AdoptedWorker {
	taskId: string;
	descriptor: WorkerDescriptor;
	token: string;
}

export async function adoptResidentWorkers(options: {
	descriptors: WorkerDescriptor[];
	controlToken: string;
	supervisorGeneration: string;
	isProcessAlive: (pid: number) => boolean;
	request?: (socketPath: string, request: Parameters<typeof requestWorker>[1]) => Promise<WorkerResponse>;
}): Promise<AdoptedWorker[]> {
	const adopted: AdoptedWorker[] = [];
	const send = options.request ?? requestWorker;
	for (const descriptor of options.descriptors) {
		if (descriptor.lifecycle !== "resident" || !["starting", "running"].includes(descriptor.state)) continue;
		if (!options.isProcessAlive(descriptor.pid)) continue;
		const candidateTokens: string[] = [];
		const currentToken = deriveWorkerToken(
			options.controlToken,
			descriptor.workerId,
			descriptor.supervisorGeneration,
		);
		if (workerTokenMatches(currentToken, descriptor.tokenSha256)) candidateTokens.push(currentToken);
		if (descriptor.previousSupervisorGeneration && descriptor.previousTokenSha256) {
			const previousToken = deriveWorkerToken(
				options.controlToken,
				descriptor.workerId,
				descriptor.previousSupervisorGeneration,
			);
			if (workerTokenMatches(previousToken, descriptor.previousTokenSha256)) candidateTokens.push(previousToken);
		}
		if (candidateTokens.length === 0) continue;
		const token = deriveWorkerToken(options.controlToken, descriptor.workerId, options.supervisorGeneration);
		for (const candidateToken of candidateTokens) {
			try {
				const response = await send(descriptor.privateSocketPath, {
					token: candidateToken,
					command: "adopt",
					payload: { supervisorGeneration: options.supervisorGeneration, newToken: token },
				});
				const adoptedDescriptor = response.descriptor;
				if (
					!response.ok ||
					!adoptedDescriptor ||
					typeof adoptedDescriptor !== "object" ||
					!("workerId" in adoptedDescriptor) ||
					adoptedDescriptor.workerId !== descriptor.workerId
				)
					continue;
				adopted.push({ taskId: descriptor.taskId, descriptor: adoptedDescriptor as WorkerDescriptor, token });
				break;
			} catch {
				// Try the previous generation only when a rotation descriptor proves it.
			}
		}
	}
	return adopted;
}
