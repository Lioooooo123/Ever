#!/bin/sh
set -eu
mkdir -p src
cat > src/migrate.mjs <<'EOF'
export function migrate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("input must be an object");
  const source = value.schemaVersion === 1 ? value.users : value.schemaVersion === 2 ? value.accounts : undefined;
  if (!Array.isArray(source)) throw new Error("unsupported schema");
  const ids = new Set();
  const accounts = source.map((record) => {
    if (!record || typeof record !== "object" || typeof record.id !== "string" || !record.id ||
        typeof (record.name ?? record.displayName) !== "string" || typeof record.email !== "string") {
      throw new Error("invalid account");
    }
    if (ids.has(record.id)) throw new Error("duplicate id");
    ids.add(record.id);
    return { id: record.id, displayName: (record.name ?? record.displayName).trim(), email: record.email.toLowerCase(), status: "active" };
  });
  return { schemaVersion: 2, accounts };
}
EOF
cat > src/cli.mjs <<'EOF'
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { migrate } from "./migrate.mjs";
const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const input = value("--input");
const output = value("--output");
const dryRun = args.includes("--dry-run");
if (!input || !output) throw new Error("usage: --input <path> --output <path> [--dry-run]");
const document = `${JSON.stringify(migrate(JSON.parse(await readFile(input, "utf8"))), null, 2)}\n`;
if (dryRun) process.stdout.write(document);
else {
  const temporary = join(dirname(output), `.${basename(output)}.${process.pid}.tmp`);
  try { await writeFile(temporary, document, { flag: "wx" }); await rename(temporary, output); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
EOF
cat >> README.md <<'EOF'

## Migration

Run `node src/cli.mjs --input fixtures/accounts-v1.json --output accounts-v2.json`. Add `--dry-run` to print without writing.
EOF
