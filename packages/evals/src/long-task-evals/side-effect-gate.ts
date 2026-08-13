import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SideEffectRequest {
	operationId: string;
	idempotencyKey: string;
	effect: "reconcilable_write" | "external_side_effect";
	payloadDigest: string;
}

export interface SideEffectReceipt extends SideEffectRequest {
	schemaVersion: 1;
	committedAt: string;
}

export interface SideEffectExecutionResult {
	receipt: SideEffectReceipt;
	replayed: boolean;
}

export interface SideEffectGateObserver {
	effectCommitted(receipt: SideEffectReceipt): Promise<void>;
}

interface Barrier {
	promise: Promise<void>;
	release(): void;
}

function barrier(): Barrier {
	let release = (): void => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

function validateRequest(request: SideEffectRequest): void {
	if (request.operationId.trim() === "" || request.idempotencyKey.trim() === "")
		throw new Error("Side-effect operation and idempotency identities are required");
	if (!/^[a-f0-9]{64}$/.test(request.payloadDigest)) throw new Error("Side-effect payloadDigest must be SHA-256");
}

export class ControlledSideEffectGate {
	readonly #ledgerPath: string;
	readonly #observer: SideEffectGateObserver;
	readonly #barriers = new Map<string, Barrier>();
	#serialization: Promise<void> = Promise.resolve();

	constructor(ledgerPath: string, observer: SideEffectGateObserver) {
		this.#ledgerPath = ledgerPath;
		this.#observer = observer;
	}

	async execute(request: SideEffectRequest, signal?: AbortSignal): Promise<SideEffectExecutionResult> {
		validateRequest(request);
		const committed = await this.#serializedCommit(request);
		if (committed.replayed) return committed;
		const pending = barrier();
		this.#barriers.set(request.operationId, pending);
		try {
			await this.#observer.effectCommitted(committed.receipt);
			if (signal?.aborted) throw new Error("Side-effect response barrier was aborted");
			await (signal === undefined
				? pending.promise
				: Promise.race([
						pending.promise,
						new Promise<never>((_, reject) => {
							signal.addEventListener(
								"abort",
								() => reject(new Error("Side-effect response barrier was aborted")),
								{
									once: true,
								},
							);
						}),
					]));
			return committed;
		} finally {
			this.#barriers.delete(request.operationId);
		}
	}

	release(operationId: string): void {
		const pending = this.#barriers.get(operationId);
		if (pending === undefined) throw new Error(`No side-effect response barrier for ${operationId}`);
		pending.release();
	}

	async reconcile(operationId: string): Promise<SideEffectReceipt | undefined> {
		const receipt = (await this.#receipts()).find((candidate) => candidate.operationId === operationId);
		if (receipt?.effect === "external_side_effect") throw new Error("reconciliation_not_supported");
		return receipt;
	}

	async #serializedCommit(request: SideEffectRequest): Promise<SideEffectExecutionResult> {
		let resolveResult = (_value: SideEffectExecutionResult): void => {};
		let rejectResult = (_error: unknown): void => {};
		const result = new Promise<SideEffectExecutionResult>((resolve, reject) => {
			resolveResult = resolve;
			rejectResult = reject;
		});
		this.#serialization = this.#serialization.then(async () => {
			try {
				resolveResult(await this.#commit(request));
			} catch (error) {
				rejectResult(error);
			}
		});
		await this.#serialization;
		return await result;
	}

	async #commit(request: SideEffectRequest): Promise<SideEffectExecutionResult> {
		const receipts = await this.#receipts();
		const existing = receipts.find(
			(receipt) => receipt.idempotencyKey === request.idempotencyKey || receipt.operationId === request.operationId,
		);
		if (existing !== undefined) {
			if (
				existing.operationId !== request.operationId ||
				existing.idempotencyKey !== request.idempotencyKey ||
				existing.effect !== request.effect ||
				existing.payloadDigest !== request.payloadDigest
			) {
				throw new Error("Side-effect idempotency identity conflicts with a committed receipt");
			}
			return { receipt: existing, replayed: true };
		}
		const receipt: SideEffectReceipt = {
			schemaVersion: 1,
			...request,
			committedAt: new Date().toISOString(),
		};
		await mkdir(dirname(this.#ledgerPath), { recursive: true, mode: 0o700 });
		const handle = await open(this.#ledgerPath, "a", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(receipt)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		return { receipt, replayed: false };
	}

	async #receipts(): Promise<SideEffectReceipt[]> {
		let text: string;
		try {
			text = await readFile(this.#ledgerPath, "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
			throw error;
		}
		return text
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as SideEffectReceipt);
	}
}
