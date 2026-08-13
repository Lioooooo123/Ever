import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

async function regularFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const paths: string[] = [];
	for (const entry of entries) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) paths.push(...(await regularFiles(path)));
		else if (entry.isFile()) paths.push(path);
		else if (entry.isSymbolicLink()) throw new Error(`Digest input symlinks are not allowed: ${path}`);
	}
	return paths;
}

export async function digestPath(path: string): Promise<string> {
	const absolutePath = resolve(path);
	const pathStat = await stat(absolutePath);
	const digest = createHash("sha256");
	if (pathStat.isFile()) digest.update(await readFile(absolutePath));
	else if (pathStat.isDirectory()) {
		const files = await regularFiles(absolutePath);
		files.sort((left, right) =>
			Buffer.compare(
				Buffer.from(relative(absolutePath, left).replaceAll("\\", "/")),
				Buffer.from(relative(absolutePath, right).replaceAll("\\", "/")),
			),
		);
		for (const file of files) {
			digest.update(relative(absolutePath, file).replaceAll("\\", "/"));
			digest.update("\0");
			digest.update(await readFile(file));
		}
	} else throw new Error(`Digest input must be a regular file or directory: ${absolutePath}`);
	return digest.digest("hex");
}
