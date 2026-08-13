import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlledSideEffectGate, type SideEffectReceipt } from "../../src/long-task-evals/side-effect-gate.ts";

const directories: string[] = [];
const payloadDigest = "a".repeat(64);

afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("ControlledSideEffectGate", () => {
	it("persists a receipt before blocking and deduplicates replay", async () => {
		const root = await mkdtemp(join(tmpdir(), "ever-side-effect-gate-"));
		directories.push(root);
		const ledger = join(root, "receipts.jsonl");
		const observed: SideEffectReceipt[] = [];
		let gate: ControlledSideEffectGate;
		gate = new ControlledSideEffectGate(ledger, {
			effectCommitted: async (receipt) => {
				observed.push(receipt);
				expect(await gate.reconcile(receipt.operationId)).toEqual(receipt);
				gate.release(receipt.operationId);
			},
		});
		const request = {
			operationId: "operation-1",
			idempotencyKey: "key-1",
			effect: "reconcilable_write" as const,
			payloadDigest,
		};
		const first = await gate.execute(request);
		const replay = await gate.execute(request);

		expect(first.replayed).toBe(false);
		expect(replay).toMatchObject({ replayed: true, receipt: first.receipt });
		expect(observed).toHaveLength(1);
		expect((await readFile(ledger, "utf8")).trim().split("\n")).toHaveLength(1);
	});

	it("does not expose reconciliation for external side effects", async () => {
		const root = await mkdtemp(join(tmpdir(), "ever-side-effect-gate-"));
		directories.push(root);
		let gate: ControlledSideEffectGate;
		gate = new ControlledSideEffectGate(join(root, "receipts.jsonl"), {
			effectCommitted: async (receipt) => gate.release(receipt.operationId),
		});
		await gate.execute({
			operationId: "external-1",
			idempotencyKey: "external-key-1",
			effect: "external_side_effect",
			payloadDigest,
		});
		await expect(gate.reconcile("external-1")).rejects.toThrow("reconciliation_not_supported");
	});

	it("rejects conflicting idempotency identities", async () => {
		const root = await mkdtemp(join(tmpdir(), "ever-side-effect-gate-"));
		directories.push(root);
		let gate: ControlledSideEffectGate;
		gate = new ControlledSideEffectGate(join(root, "receipts.jsonl"), {
			effectCommitted: async (receipt) => gate.release(receipt.operationId),
		});
		await gate.execute({
			operationId: "operation-1",
			idempotencyKey: "shared-key",
			effect: "reconcilable_write",
			payloadDigest,
		});
		await expect(
			gate.execute({
				operationId: "operation-2",
				idempotencyKey: "shared-key",
				effect: "reconcilable_write",
				payloadDigest,
			}),
		).rejects.toThrow("conflicts");
	});
});
