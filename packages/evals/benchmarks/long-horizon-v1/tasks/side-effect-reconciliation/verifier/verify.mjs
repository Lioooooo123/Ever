import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const root = "/tmp/elhb-effects"; await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true });
const invoke = (batch, state, ledger, env = {}) => spawnSync("node", ["src/cli.mjs", "--batch", batch, "--state", state, "--ledger", ledger], { cwd: "/app", encoding: "utf8", env: { ...process.env, ...env } });
const batch = `${root}/reconcile.json`, state = `${root}/state.json`, ledger = `${root}/ledger.jsonl`;
await writeFile(batch, JSON.stringify([{ operationId: "order-1", idempotencyKey: "key-order-1", effect: "reconcilable_write", payload: { amount: 10 } }]));
const interrupted = invoke(batch, state, ledger, { ELHB_INTERRUPT_AFTER_COMMIT: "order-1" }); const resumed = invoke(batch, state, ledger); const rerun = invoke(batch, state, ledger);
const readJson = async (path, fallback) => {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error?.code === "ENOENT") return fallback; throw error; }
};
const readLedger = async (path) => {
  try { return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); } catch (error) { if (error?.code === "ENOENT") return []; throw error; }
};
const receipts = await readLedger(ledger); const final = await readJson(state, {});
const extBatch = `${root}/external.json`, extState = `${root}/external-state.json`, extLedger = `${root}/external-ledger.jsonl`;
await writeFile(extBatch, JSON.stringify([{ operationId: "notify-1", idempotencyKey: "key-notify-1", effect: "external_side_effect", payload: { to: "synthetic" } }]));
const extInterrupted = invoke(extBatch, extState, extLedger, { ELHB_INTERRUPT_AFTER_COMMIT: "notify-1" }); const extResumed = invoke(extBatch, extState, extLedger); const extFinal = await readJson(extState, {});
const extReceipts = await readLedger(extLedger);
const groups = {
  objective: [{ id: "reconcile-completes", passed: interrupted.status !== 0 && resumed.status === 0 && final.terminalState === "completed" }],
  regression: [{ id: "stable-rerun", passed: rerun.status === 0 }],
  safety: [
    { id: "reconcilable-exactly-once", passed: receipts.length === 1 },
    { id: "external-fail-closed", passed: extInterrupted.status !== 0 && extResumed.status !== 0 && extFinal.terminalState === "unknown_outcome" && extReceipts.length === 1 }
  ],
  integrity: [{ id: "receipt-state-agree", passed: final.operations?.["order-1"]?.receiptId === receipts[0]?.receiptId }]
};
const group = (checks) => ({ passed: checks.every((check) => check.passed), checks }); const report = { schemaVersion: 1, started: true, completed: true, components: Object.fromEntries(Object.entries(groups).map(([key, checks]) => [key, group(checks)])) };
await writeFile("/logs/verifier/report.json", `${JSON.stringify(report, null, 2)}\n`); process.exit(Object.values(report.components).every((item) => item.passed) ? 0 : 1);
