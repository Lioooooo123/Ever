import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const tsxPackagePath = require.resolve("tsx/package.json");
const tsxCliPath = resolve(dirname(tsxPackagePath), "dist/cli.mjs");
const result = spawnSync(process.execPath, [tsxCliPath, "src/eval-cli.ts", ...process.argv.slice(2)], {
	cwd: packageRoot,
	stdio: "inherit",
	env: process.env,
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
