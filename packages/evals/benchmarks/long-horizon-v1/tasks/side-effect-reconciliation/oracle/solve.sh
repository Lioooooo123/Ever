#!/bin/sh
set -eu
cat > src/cli.mjs <<'EOF'
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
const args = process.argv.slice(2); const value = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const batchPath = value("--batch"), statePath = value("--state"), ledgerPath = value("--ledger");
if (!batchPath || !statePath || !ledgerPath) throw new Error("usage");
const atomic = async (path, data) => { await mkdir(dirname(path), { recursive: true }); const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`); try { await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" }); await rename(temp, path); } catch (error) { await unlink(temp).catch(() => {}); throw error; } };
const readJson = async (path, fallback) => { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code === "ENOENT") return fallback; throw error; } };
const batch = await readJson(batchPath, []); let state = await readJson(statePath, { schemaVersion: 1, terminalState: "running", operations: {} });
let receipts = []; try { receipts = (await readFile(ledgerPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); } catch (error) { if (error.code !== "ENOENT") throw error; }
const keys = new Map(); for (const receipt of receipts) keys.set(receipt.idempotencyKey, receipt);
for (const item of batch) {
  const existing = keys.get(item.idempotencyKey);
  if (existing && (existing.operationId !== item.operationId || JSON.stringify(existing.payload) !== JSON.stringify(item.payload))) throw new Error("idempotency_conflict");
  if (state.operations[item.operationId]?.status === "committed") continue;
  if (existing) {
    if (item.effect === "external_side_effect") { state.terminalState = "unknown_outcome"; state.operations[item.operationId] = { status: "unknown_outcome" }; await atomic(statePath, state); process.exit(3); }
    state.operations[item.operationId] = { status: "committed", receiptId: existing.receiptId }; await atomic(statePath, state); continue;
  }
  const receipt = { schemaVersion: 1, receiptId: `receipt-${item.operationId}`, operationId: item.operationId, idempotencyKey: item.idempotencyKey, effect: item.effect, payload: item.payload };
  await appendFile(ledgerPath, `${JSON.stringify(receipt)}\n`); keys.set(item.idempotencyKey, receipt);
  if (process.env.ELHB_INTERRUPT_AFTER_COMMIT === item.operationId) { const marker = `${statePath}.interrupted-${item.operationId}`; try { await writeFile(marker, "1", { flag: "wx" }); process.exit(86); } catch (error) { if (error.code !== "EEXIST") throw error; } }
  state.operations[item.operationId] = { status: "committed", receiptId: receipt.receiptId }; await atomic(statePath, state);
}
state.terminalState = "completed"; await atomic(statePath, state);
EOF
cat >> README.md <<'EOF'

Receipts are durable before completion state. Reconcilable writes recover by stable operation and idempotency identity; unprovable external effects fail closed as `unknown_outcome`.
EOF
