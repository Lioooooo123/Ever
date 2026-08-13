import { appendFile, readFile } from "node:fs/promises";
const args = process.argv.slice(2); const value = (name) => args[args.indexOf(name) + 1];
const batch = JSON.parse(await readFile(value("--batch"), "utf8"));
for (const item of batch) await appendFile(value("--ledger"), `${JSON.stringify(item)}\n`);
