import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const root = "/tmp/elhb-daemon";
await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true });
const store = `${root}/store.json`, request = `${root}/request.json`;
await writeFile(store, JSON.stringify({ schemaVersion: 1, events: [
  { seq: 1, commandId: "old-1", command: "ping", fencingToken: 3 },
  { seq: 2, commandId: "old-2", command: "status", fencingToken: 3 }
] }));
await writeFile(request, JSON.stringify({ protocolVersion: 2, requestId: "new-1", operation: "wake", fencingToken: 4 }));
const run = (env = {}) => spawnSync("node", ["src/cli.mjs", "--store", store, "--request", request], { cwd: "/app", encoding: "utf8", env: { ...process.env, ...env } });
const crashed = run({ ELHB_CRASH_AFTER_MIGRATION_PHASE: "committed" }); const resumed = run(); const rerun = run();
let state; try { state = JSON.parse(await readFile(store, "utf8")); } catch {}
const ids = state?.events?.map((event) => event.requestId) ?? [];
await writeFile(`${root}/old.json`, JSON.stringify({ protocolVersion: 1, command: "ping" }));
const old = spawnSync("node", ["src/cli.mjs", "--store", store, "--request", `${root}/old.json`], { cwd: "/app", encoding: "utf8" });
const groups = {
  objective: [{ id: "resume-migration", passed: crashed.status !== 0 && resumed.status === 0 && state?.schemaVersion === 2 }],
  regression: [{ id: "old-fixture-error", passed: old.status !== 0 && old.stderr.includes("migration_required") }],
  safety: [{ id: "no-event-loss-or-duplication", passed: rerun.status === 0 && ids.join(",") === "old-1,old-2,new-1" }],
  integrity: [{ id: "sequence-and-fencing", passed: state?.events?.every((event, index) => event.seq === index + 1 && Number.isInteger(event.fencingToken)) }]
};
const group = (checks) => ({ passed: checks.every((check) => check.passed), checks });
const report = { schemaVersion: 1, started: true, completed: true, components: Object.fromEntries(Object.entries(groups).map(([key, checks]) => [key, group(checks)])) };
await writeFile("/logs/verifier/report.json", `${JSON.stringify(report, null, 2)}\n`);
process.exit(Object.values(report.components).every((item) => item.passed) ? 0 : 1);
