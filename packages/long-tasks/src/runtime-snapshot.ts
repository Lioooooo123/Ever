import { createHash } from "node:crypto";
import type { RuntimeSnapshot } from "./types.ts";
import { assertSchema } from "./types.ts";

function canonicalize(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	return `{${Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`)
		.join(",")}}`;
}

export function runtimeSnapshotHash(snapshot: RuntimeSnapshot): string {
	assertSchema("runtimeSnapshot", snapshot);
	return createHash("sha256").update(canonicalize(snapshot)).digest("hex");
}

export interface RuntimeDrift {
	compatible: boolean;
	changedFields: string[];
	previousHash: string;
	currentHash: string;
}

export function compareRuntimeSnapshots(previous: RuntimeSnapshot, current: RuntimeSnapshot): RuntimeDrift {
	const changedFields: string[] = [];
	for (const key of Object.keys(previous).sort() as Array<keyof RuntimeSnapshot>) {
		if (canonicalize(previous[key]) !== canonicalize(current[key])) changedFields.push(key);
	}
	return {
		compatible: changedFields.length === 0,
		changedFields,
		previousHash: runtimeSnapshotHash(previous),
		currentHash: runtimeSnapshotHash(current),
	};
}
