# Upgrade the daemon protocol atomically

Upgrade this repository from protocol v1 to v2. The public command remains:

```text
node src/cli.mjs --store <path> --request <path>
```

Protocol v2 requests use `{ protocolVersion: 2, requestId, operation, fencingToken }`. Stored events use `{ schemaVersion: 2, seq, requestId, operation, fencingToken }`.

Requirements:

- migrate a v1 store exactly once and persist migration phases atomically;
- preserve every event, sequence number, and request identity;
- reject an unmigrated v1 request with the exact code `migration_required`;
- reject non-increasing sequence numbers and stale fencing tokens;
- resume safely if `ELHB_CRASH_AFTER_MIGRATION_PHASE=committed` exits the process after the committed phase is durable;
- document the migration and recovery contract.

Use only Node.js built-ins and do not access the network.
