export interface TaskRunContext {
	taskId: string;
	agentId: string;
	dispatchId?: string;
	acceptRuntimeDrift: boolean;
}

let currentTaskRun: TaskRunContext | undefined;

export function setTaskRunContext(context: TaskRunContext): void {
	if (currentTaskRun) throw new Error("A Task run is already configured for this process");
	currentTaskRun = Object.freeze({ ...context });
}

export function getTaskRunContext(): TaskRunContext | undefined {
	return currentTaskRun;
}
