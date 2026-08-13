# Make the file-backed pipeline resumable

Repair the pipeline CLI in this repository:

```text
node src/cli.mjs --jobs <path> --state <path> --effects <path>
```

Each input job has an `id` and `payload`. Processing has three logical stages: validate, prepare, and commit. Commit appends one JSON line to the effects file. The current implementation loses progress and duplicates effects after interruption.

Requirements:

- persist sufficient versioned state to resume after a process exits;
- save state atomically using a sibling temporary file and rename;
- never append more than one effect for the same job ID, including when the process is restarted;
- support the test hook `ELHB_CRASH_AFTER_STAGE=<stage>:<job-id>` by exiting non-zero immediately after that stage is durably recorded; each configured crash point must fire at most once per state directory;
- reject duplicate job IDs before producing effects;
- keep the CLI contract above and document recovery semantics in `README.md`.

Do not use network access or third-party packages.
