import type { AgentRecord, EvidenceRef, Progress, TaskRecord } from "./types.ts";

export interface TaskContextInput {
	task: TaskRecord;
	agent: AgentRecord;
	progress?: Progress;
	evidence: EvidenceRef[];
	tokenBudget?: number;
}

function escapeXml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function compactEvidence(evidence: EvidenceRef[], max: number): EvidenceRef[] {
	if (evidence.length <= max) return evidence;
	return evidence.slice(evidence.length - max);
}

export class TaskContextBuilder {
	build(input: TaskContextInput): string {
		const tokenBudget = input.tokenBudget ?? 8000;
		if (tokenBudget < 1000) throw new RangeError("Long-task context budget must be at least 1000 estimated tokens");
		let evidence = input.evidence;
		let progress = input.progress;
		let context = this.render(input, progress, evidence);
		const characterBudget = tokenBudget * 4;
		if (context.length > characterBudget) {
			evidence = compactEvidence(evidence, 20).map((item) => ({ ...item, summary: undefined }));
			if (progress) {
				progress = {
					...progress,
					completedItems: progress.completedItems.slice(-20),
					verification: progress.verification
						.slice(-10)
						.map((item) => ({ ...item, artifactRef: item.artifactRef })),
				};
			}
			context = this.render(input, progress, evidence);
		}
		if (context.length > characterBudget)
			throw new Error("Required task context exceeds the configured context budget");
		return context;
	}

	private render(input: TaskContextInput, progress: Progress | undefined, evidence: EvidenceRef[]): string {
		return `<long_task>
  <goal>${escapeXml(input.task.goal)}</goal>
  <acceptance>${escapeXml(JSON.stringify(input.task.acceptance))}</acceptance>
  <constraints>${escapeXml(JSON.stringify(input.task.constraints))}</constraints>
  <budget>${escapeXml(JSON.stringify(input.task.budget))}</budget>
  <progress>${escapeXml(JSON.stringify(progress ?? null))}</progress>
  <next_actions>${escapeXml(JSON.stringify(progress?.nextActions ?? []))}</next_actions>
  <open_blockers>${escapeXml(JSON.stringify(progress?.blockers ?? []))}</open_blockers>
  <evidence_index>${escapeXml(JSON.stringify(evidence))}</evidence_index>
  <agent_identity>${escapeXml(JSON.stringify({ id: input.agent.id, kind: input.agent.kind, role: input.agent.role }))}</agent_identity>
  <tool_policy>${escapeXml(JSON.stringify(input.agent.toolPolicy))}</tool_policy>
</long_task>`;
	}
}
