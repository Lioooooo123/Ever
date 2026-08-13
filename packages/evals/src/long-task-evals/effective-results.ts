import type { EvalRunResult } from "./schemas.ts";

/** Keep the first valid result for each plan, or its latest invalid attempt when every retry failed. */
export function selectEffectiveLongHorizonResults(results: readonly EvalRunResult[]): EvalRunResult[] {
	const effective = new Map<string, EvalRunResult>();
	for (const result of results) {
		const planId = result.longHorizon?.planId;
		if (planId === undefined) throw new Error("Effective long-horizon selection requires a trial plan ID");
		if (effective.get(planId)?.longHorizon?.valid) continue;
		effective.set(planId, result);
	}
	return [...effective.values()];
}
