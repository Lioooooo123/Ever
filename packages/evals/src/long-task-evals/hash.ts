import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

export function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

export async function hashFile(path: string): Promise<string> {
	return sha256(await readFile(path));
}

export async function hashDirectory(root: string): Promise<string> {
	const absoluteRoot = resolve(root);
	const entries: Array<{ path: string; digest: string }> = [];

	async function visit(directory: string): Promise<void> {
		const children = await readdir(directory, { withFileTypes: true });
		children.sort((left, right) => left.name.localeCompare(right.name));
		for (const child of children) {
			const absolutePath = resolve(directory, child.name);
			const stat = await lstat(absolutePath);
			if (stat.isSymbolicLink()) throw new Error(`Benchmark sources may not contain symlinks: ${absolutePath}`);
			if (stat.isDirectory()) {
				await visit(absolutePath);
				continue;
			}
			if (!stat.isFile()) throw new Error(`Unsupported benchmark source entry: ${absolutePath}`);
			entries.push({ path: relative(absoluteRoot, absolutePath), digest: await hashFile(absolutePath) });
		}
	}

	await visit(absoluteRoot);
	return sha256(entries.map((entry) => `${entry.path}\0${entry.digest}`).join("\n"));
}
