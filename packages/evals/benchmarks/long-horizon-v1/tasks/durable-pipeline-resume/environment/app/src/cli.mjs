import { appendFile, readFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const jobs = JSON.parse(await readFile(option("--jobs"), "utf8"));
for (const job of jobs) {
  await writeFile(option("--state"), JSON.stringify({ current: job.id, stage: "prepare" }));
  await appendFile(option("--effects"), `${JSON.stringify({ id: job.id, payload: job.payload })}\n`);
}
