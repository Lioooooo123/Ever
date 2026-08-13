import { readFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const store = JSON.parse(await readFile(value("--store"), "utf8"));
const request = JSON.parse(await readFile(value("--request"), "utf8"));
store.events.push({ seq: store.events.length + 1, type: request.command });
await writeFile(value("--store"), JSON.stringify(store));
