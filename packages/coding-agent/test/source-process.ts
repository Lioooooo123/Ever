import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const tsxLoaderPath = resolve(repositoryRoot, "node_modules/tsx/dist/loader.mjs");
const tsconfigPath = resolve(repositoryRoot, "tsconfig.json");

export function sourceProcessArgs(entryPath: string, args: readonly string[] = []): string[] {
	return ["--import", tsxLoaderPath, entryPath, ...args];
}

export function sourceProcessEnv(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return { ...environment, TSX_TSCONFIG_PATH: tsconfigPath };
}
