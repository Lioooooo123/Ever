#!/bin/sh
set -eu
cat > src/cli.mjs <<'EOF'
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const storePath = value("--store"), requestPath = value("--request");
if (!storePath || !requestPath) throw new Error("usage");
const atomic = async (path, data) => {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try { await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" }); await rename(temp, path); }
  catch (error) { await unlink(temp).catch(() => {}); throw error; }
};
let store = JSON.parse(await readFile(storePath, "utf8"));
const request = JSON.parse(await readFile(requestPath, "utf8"));
if (store.schemaVersion === 1) {
  const phasePath = `${storePath}.migration.json`;
  let phase = { schemaVersion: 1, phase: "started" };
  try { phase = JSON.parse(await readFile(phasePath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; await atomic(phasePath, phase); }
  if (phase.phase === "started") {
    const migrated = { schemaVersion: 2, protocolVersion: 2, events: store.events.map((event) => ({
      schemaVersion: 2, seq: event.seq, requestId: event.commandId, operation: event.command, fencingToken: event.fencingToken
    })) };
    await atomic(storePath, migrated);
    await atomic(phasePath, { schemaVersion: 1, phase: "committed" });
    if (process.env.ELHB_CRASH_AFTER_MIGRATION_PHASE === "committed") {
      const marker = `${phasePath}.crashed`;
      try { await writeFile(marker, "1", { flag: "wx" }); process.exit(86); } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    store = migrated;
  } else store = JSON.parse(await readFile(storePath, "utf8"));
}
if (request.protocolVersion !== 2) { process.stderr.write("migration_required\n"); process.exit(2); }
const last = store.events.at(-1);
if (last && request.fencingToken < last.fencingToken) throw new Error("stale_fencing_token");
if (store.events.some((event) => event.requestId === request.requestId)) process.exit(0);
store.events.push({ schemaVersion: 2, seq: (last?.seq ?? 0) + 1, requestId: request.requestId, operation: request.operation, fencingToken: request.fencingToken });
await atomic(storePath, store);
EOF
cat >> README.md <<'EOF'

Protocol v2 migration persists `started` and `committed` phases atomically. Restarting after a committed-phase interruption resumes without remigrating or duplicating events.
EOF
