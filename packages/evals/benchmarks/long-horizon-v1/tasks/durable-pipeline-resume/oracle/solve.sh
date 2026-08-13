#!/bin/sh
set -eu
cat > src/cli.mjs <<'EOF'
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const jobsPath = option("--jobs"), statePath = option("--state"), effectsPath = option("--effects");
if (!jobsPath || !statePath || !effectsPath) throw new Error("usage: --jobs <path> --state <path> --effects <path>");
const jobs = JSON.parse(await readFile(jobsPath, "utf8"));
if (!Array.isArray(jobs)) throw new Error("jobs must be an array");
const ids = new Set();
for (const job of jobs) {
  if (!job || typeof job.id !== "string" || !job.id || ids.has(job.id)) throw new Error("invalid or duplicate job id");
  ids.add(job.id);
}
let state = { schemaVersion: 1, jobs: {} };
try { state = JSON.parse(await readFile(statePath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (state.schemaVersion !== 1 || !state.jobs || typeof state.jobs !== "object") throw new Error("invalid state");
const save = async () => {
  await mkdir(dirname(statePath), { recursive: true });
  const temporary = join(dirname(statePath), `.${basename(statePath)}.${process.pid}.tmp`);
  try { await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" }); await rename(temporary, statePath); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
};
const crash = process.env.ELHB_CRASH_AFTER_STAGE;
const record = async (job, stage) => {
  state.jobs[job.id] = { stage };
  await save();
  const marker = `${statePath}.crash-${stage}-${job.id}`;
  if (crash === `${stage}:${job.id}`) {
    try { await writeFile(marker, "fired\n", { flag: "wx" }); process.exit(86); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
};
for (const job of jobs) {
  const stage = state.jobs[job.id]?.stage;
  if (!stage) await record(job, "validated");
  if (!state.jobs[job.id] || state.jobs[job.id].stage === "validated") await record(job, "prepared");
  if (state.jobs[job.id].stage === "prepared") {
    await appendFile(effectsPath, `${JSON.stringify({ id: job.id, payload: job.payload })}\n`);
    await record(job, "committed");
  }
}
EOF
cat >> README.md <<'EOF'

State is versioned and atomically replaced. Restart the same command after interruption; committed jobs are skipped and each effect is emitted once.
EOF
