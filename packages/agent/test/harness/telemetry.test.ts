import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTypedSpanStarter, NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@lioooooo123/ever-telemetry";
import { describe, expect, expectTypeOf, it } from "vitest";
import { renderAgentTelemetrySchemaMarkdown } from "../../scripts/generate-telemetry-docs.ts";
import {
	AGENT_TELEMETRY_SCHEMAS,
	AI_TELEMETRY_SCHEMA,
	type AiSpanEndAttributes,
	type AiSpanStartAttributes,
	HARNESS_TELEMETRY_SCHEMA,
	type HarnessSpanEndAttributes,
	type HarnessSpanStartAttributes,
	startAiSpan,
	startHarnessSpan,
} from "../../src/harness/telemetry.ts";

describe("agent telemetry schemas", () => {
	it("serializes both schemas and generates the checked-in reference", () => {
		expect(() => JSON.stringify(AI_TELEMETRY_SCHEMA)).not.toThrow();
		expect(() => JSON.stringify(HARNESS_TELEMETRY_SCHEMA)).not.toThrow();
		expect(AGENT_TELEMETRY_SCHEMAS).toEqual([AI_TELEMETRY_SCHEMA, HARNESS_TELEMETRY_SCHEMA]);
		expect(Object.keys(HARNESS_TELEMETRY_SCHEMA.spans)).toEqual([
			"ever.harness.run",
			"ever.harness.compaction",
			"ever.harness.navigation",
			"ever.harness.checkpoint",
			"ever.harness.turn",
			"ever.harness.step",
			"ever.harness.tool",
			"ever.harness.hook",
			"ever.harness.sleep",
			"ever.harness.event_handler",
			"ever.session.write",
		]);
		const actual = readFileSync(resolve(import.meta.dirname, "../../docs/telemetry-schema.md"), "utf8");
		expect(actual).toBe(renderAgentTelemetrySchemaMarkdown());
	});

	it("starts AI-request and harness spans through one composed typed starter", async () => {
		const startSpan = createTypedSpanStarter(NOOP_TELEMETRY_CONTEXT, AGENT_TELEMETRY_SCHEMAS);
		await startSpan(
			"ever.harness.step",
			{
				"ever.lane.name": "main",
				"ever.operation.id": "operation",
				"ever.step.kind": "assistant",
				"ever.step.attempt": 1,
			},
			async (stepSpan, startChildSpan) => {
				stepSpan.setAttributes({ "ever.step.outcome": "succeeded" });
				await startChildSpan(
					"ever.ai.request",
					{
						"ever.ai.operation": "stream",
						"ever.ai.provider": "provider",
						"ever.ai.model": "model",
						"ever.ai.api": "api",
						"ever.ai.streaming": true,
					},
					(requestSpan) => {
						requestSpan.setAttributes({ "ever.ai.response.stop_reason": "stop" });
					},
				);
			},
		);
	});

	it("infers exact AI start and optional end attributes", async () => {
		type Start = AiSpanStartAttributes<"ever.ai.request">;
		type End = AiSpanEndAttributes<"ever.ai.request">;
		expectTypeOf<Start>().toMatchTypeOf<{
			"ever.ai.operation": "stream" | "fetch_deferred" | "cancel_deferred" | "generate_images";
			"ever.ai.provider": string;
			"ever.ai.model": string;
			"ever.ai.api": string;
			"ever.ai.streaming": boolean;
			"ever.ai.deferred"?: boolean;
		}>();
		expectTypeOf<End["ever.ai.response.stop_reason"]>().toEqualTypeOf<
			"stop" | "length" | "tool_use" | "error" | "aborted" | "deferred" | undefined
		>();

		const telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT;
		await startAiSpan(
			telemetryContext,
			"ever.ai.request",
			{
				"ever.ai.operation": "stream",
				"ever.ai.provider": "provider",
				"ever.ai.model": "model",
				"ever.ai.api": "api",
				"ever.ai.streaming": true,
			},
			(span) => {
				span.setAttributes({ "ever.ai.response.stop_reason": "tool_use" });
				// @ts-expect-error ever.ai.request declares no span events
				span.addEvent("chunk");
			},
		);

		const compileTimeFailures = () => {
			const extraAttributes = {
				"ever.ai.operation": "stream",
				"ever.ai.provider": "provider",
				"ever.ai.model": "model",
				"ever.ai.api": "api",
				"ever.ai.streaming": true,
				"ever.ai.unknown": true,
			} as const;
			// @ts-expect-error variables with unknown attributes are rejected
			void startAiSpan(telemetryContext, "ever.ai.request", extraAttributes, () => {});
			// @ts-expect-error missing required start attributes
			void startAiSpan(telemetryContext, "ever.ai.request", { "ever.ai.operation": "stream" }, () => {});
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});

	it("infers per-span harness literals and optional completion enrichment", async () => {
		type RunStart = HarnessSpanStartAttributes<"ever.harness.run">;
		type RunEnd = HarnessSpanEndAttributes<"ever.harness.run">;
		expectTypeOf<RunStart["ever.operation.kind"]>().toEqualTypeOf<"run">();
		expectTypeOf<RunEnd["ever.operation.outcome"]>().toEqualTypeOf<
			"completed" | "aborted" | "failed" | "suspended" | undefined
		>();

		const telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT;
		await startHarnessSpan(
			telemetryContext,
			"ever.harness.run",
			{
				"ever.session.id": "session",
				"ever.lane.name": "main",
				"ever.operation.id": "operation",
				"ever.operation.kind": "run",
				"ever.operation.recovery": false,
			},
			(span) => {
				span.setAttributes({ "ever.operation.outcome": "completed" });
				span.setAttributes({});
				// @ts-expect-error the harness schema declares no span events
				span.addEvent("result");
			},
		);

		const compileTimeFailures = () => {
			const extraRunAttributes = {
				"ever.session.id": "session",
				"ever.lane.name": "main",
				"ever.operation.id": "operation",
				"ever.operation.kind": "run",
				"ever.operation.recovery": false,
				"ever.unknown": true,
			} as const;
			// @ts-expect-error variables with unknown attributes are rejected
			void startHarnessSpan(telemetryContext, "ever.harness.run", extraRunAttributes, () => {});
			void startHarnessSpan(
				telemetryContext,
				"ever.harness.checkpoint",
				{
					"ever.lane.name": "main",
					"ever.operation.id": "operation",
					"ever.checkpoint.kind": "normal",
				},
				(span) => {
					// @ts-expect-error empty end schemas reject every attribute
					span.setAttributes({ "ever.unknown": true });
				},
			);
			void startHarnessSpan(
				telemetryContext,
				"ever.harness.run",
				{
					"ever.session.id": "session",
					"ever.lane.name": "main",
					"ever.operation.id": "operation",
					// @ts-expect-error run spans accept only the run operation kind
					"ever.operation.kind": "navigation",
					"ever.operation.recovery": false,
				},
				() => {},
			);
			// @ts-expect-error missing required run start attributes
			void startHarnessSpan(telemetryContext, "ever.harness.run", {}, () => {});
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});
});
