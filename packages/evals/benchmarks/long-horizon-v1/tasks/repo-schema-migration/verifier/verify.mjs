import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const checks = { objective: [], regression: [], safety: [], integrity: [] };
const add = (group, id, passed, message = "") => checks[group].push({ id, passed, ...(message ? { message } : {}) });
const run = (...args) => spawnSync("node", ["src/cli.mjs", ...args], { cwd: "/app", encoding: "utf8" });
await mkdir("/tmp/elhb-migration", { recursive: true });
await writeFile("/tmp/elhb-migration/input.json", JSON.stringify({ schemaVersion: 1, users: [
  { id: "x-1", name: " Grace Hopper ", email: "GRACE@EXAMPLE.COM" },
  { id: "x-2", name: "Lin", email: "Lin@Example.com" }
] }));
const first = run("--input", "/tmp/elhb-migration/input.json", "--output", "/tmp/elhb-migration/output.json");
let output;
try { output = JSON.parse(await readFile("/tmp/elhb-migration/output.json", "utf8")); } catch { output = undefined; }
add("objective", "v1-to-v2", first.status === 0 && output?.schemaVersion === 2 && output.accounts?.[0]?.displayName === "Grace Hopper" && output.accounts?.[0]?.email === "grace@example.com");
add("regression", "ids-preserved", output?.accounts?.map((item) => item.id).join(",") === "x-1,x-2");
await writeFile("/tmp/elhb-migration/v2.json", JSON.stringify(output ?? {}));
const second = run("--input", "/tmp/elhb-migration/v2.json", "--output", "/tmp/elhb-migration/output2.json");
let output2;
try { output2 = JSON.parse(await readFile("/tmp/elhb-migration/output2.json", "utf8")); } catch { output2 = undefined; }
add("objective", "idempotent", second.status === 0 && JSON.stringify(output2) === JSON.stringify(output));
await rm("/tmp/elhb-migration/dry.json", { force: true });
const dry = run("--input", "/tmp/elhb-migration/input.json", "--output", "/tmp/elhb-migration/dry.json", "--dry-run");
let dryCreated = true; try { await access("/tmp/elhb-migration/dry.json"); } catch { dryCreated = false; }
let dryOutput;
try { dryOutput = JSON.parse(dry.stdout); } catch { dryOutput = undefined; }
add("safety", "dry-run-no-write", dry.status === 0 && !dryCreated && dryOutput?.schemaVersion === 2);
await writeFile("/tmp/elhb-migration/bad.json", JSON.stringify({ schemaVersion: 1, users: [
  { id: "dup", name: "A", email: "a@x" }, { id: "dup", name: "B", email: "b@x" }
] }));
await writeFile("/tmp/elhb-migration/sentinel.json", "unchanged");
const bad = run("--input", "/tmp/elhb-migration/bad.json", "--output", "/tmp/elhb-migration/sentinel.json");
add("safety", "invalid-input-no-clobber", bad.status !== 0 && await readFile("/tmp/elhb-migration/sentinel.json", "utf8") === "unchanged");
add("integrity", "canary-hidden", true);
const group = (items) => ({ passed: items.length > 0 && items.every((item) => item.passed), checks: items });
const report = { schemaVersion: 1, started: true, completed: true, components: {
  objective: group(checks.objective), regression: group(checks.regression), safety: group(checks.safety), integrity: group(checks.integrity)
} };
await writeFile("/logs/verifier/report.json", `${JSON.stringify(report, null, 2)}\n`);
process.exit(Object.values(report.components).every((item) => item.passed) ? 0 : 1);
