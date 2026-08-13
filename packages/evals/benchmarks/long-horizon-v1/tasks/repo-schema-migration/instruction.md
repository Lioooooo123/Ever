# Upgrade the account store to schema v2

Implement a production-safe JSON migration CLI in this repository.

The command must be:

```text
node src/cli.mjs --input <path> --output <path> [--dry-run]
```

Input v1 records contain `id`, `name`, and `email`. Output must be `{ "schemaVersion": 2, "accounts": [...] }`; each account keeps the exact `id`, stores the trimmed name as `displayName`, lowercases the email, and adds `status: "active"`. If the input is already valid v2, rerunning must produce the same semantic result.

Requirements:

- validate malformed and duplicate-ID input and exit non-zero without changing the output;
- write atomically via a sibling temporary file followed by rename;
- `--dry-run` prints the v2 document to stdout and performs no writes;
- do not write outside the requested output directory;
- add concise usage documentation in `README.md`.

Do not rely on network access or third-party packages.
