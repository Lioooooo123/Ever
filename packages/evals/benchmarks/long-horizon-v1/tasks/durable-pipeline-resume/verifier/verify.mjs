import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const root = "/tmp/elhb-pipeline";
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
const jobsPath = `${root}/jobs.json`, statePath = `${root}/state.json`, effectsPath = `${root}/effects.jsonl`;
await writeFile(jobsPath, JSON.stringify([
  { id: "job-a", payload: { value: 1 } }, { id: "job-b", payload: { value: 2 } }, { id: "job-c", payload: { value: 3 } }
]));
const invoke = (env = {}) => spawnSync("node", ["src/cli.mjs", "--jobs", jobsPath, "--state", statePath, "--effects", effectsPath], {
  cwd: "/app", encoding: "utf8", env: { ...process.env, ...env }
});
const crashed = invoke({ ELHB_CRASH_AFTER_STAGE: "prepared:job-b" });
const resumed = invoke({ ELHB_CRASH_AFTER_STAGE: "prepared:job-b" });
const rerun = invoke();
let effects = [];
try { effects = (await readFile(effectsPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); } catch {}
let state;
try { state = JSON.parse(await readFile(statePath, "utf8")); } catch {}
const counts = new Map();
for (const effect of effects) counts.set(effect.id, (counts.get(effect.id) ?? 0) + 1);
const checks = {
  objective: [
    { id: "crash-hook", passed: crashed.status !== 0 },
    { id: "resume-completes", passed: resumed.status === 0 && ["job-a", "job-b", "job-c"].every((id) => state?.jobs?.[id]?.stage === "committed") }
  ],
  regression: [{ id: "cli-rerun", passed: rerun.status === 0 }],
  safety: [{ id: "exactly-once-effects", passed: effects.length === 3 && ["job-a", "job-b", "job-c"].every((id) => counts.get(id) === 1) }],
  integrity: [{ id: "versioned-state", passed: state?.schemaVersion === 1 }]
};
await writeFile(`${root}/duplicate.json`, JSON.stringify([{ id: "same", payload: 1 }, { id: "same", payload: 2 }]));
const before = effects.length;
const duplicate = spawnSync("node", ["src/cli.mjs", "--jobs", `${root}/duplicate.json`, "--state", `${root}/duplicate-state.json`, "--effects", effectsPath], { cwd: "/app", encoding: "utf8" });
const after = (await readFile(effectsPath, "utf8")).trim().split("\n").filter(Boolean).length;
checks.safety.push({ id: "duplicate-input-rejected", passed: duplicate.status !== 0 && before === after });
const group = (items) => ({ passed: items.length > 0 && items.every((item) => item.passed), checks: items });
const report = { schemaVersion: 1, started: true, completed: true, components: {
  objective: group(checks.objective), regression: group(checks.regression), safety: group(checks.safety), integrity: group(checks.integrity)
} };
await writeFile("/logs/verifier/report.json", `${JSON.stringify(report, null, 2)}\n`);
process.exit(Object.values(report.components).every((item) => item.passed) ? 0 : 1);
