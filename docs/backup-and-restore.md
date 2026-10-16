# Back up a deployment

Keep recordings and databases separate from model files and build caches. A model download is reproducible; a personal recording is not. Store backups outside the active `DATA_ROOT`, with mode `0700`, on private storage. Configuration backups contain credentials and must never enter this repository.

## Consistent snapshot

Before stopping services, record the repository revision, exact container image IDs, running containers, restart policies, Compose configuration, and GPU-manager unit and configuration. Keep this inventory private: container inspection and expanded Compose configuration include secrets.

1. Confirm that both GPU managers are idle with no active lease. If sleep is running, stop its scheduler and wait until both managers confirm daytime recovery.
2. Stop both GPU-manager services so they cannot change container state during the backup.
3. Stop capture ingress and sleep on Spark 1. Stop recognition, speech, OCR, Graph Sync, and Archive on Spark 2. Confirm that every writer has exited. Stop Graph API and Neo4j last.
4. Copy each host's complete `DATA_ROOT`, private `.env`, control token, manager configuration, and any private TLS or reverse-proxy configuration. Preserve ownership, permissions and symlinks. Inventory symlink targets before copying: recording or database links outside the copied roots must have their target data backed up separately, or the backup must fail. A copied link does not preserve the bytes it references. Include SQLite `-wal` and `-shm` files; do not copy only the main database file.
5. Compare SHA-256 hashes for every regular source and backup file, and compare symlink targets. Run SQLite `PRAGMA integrity_check` on the backup databases. Use the same Neo4j image version to run `neo4j-admin database check` against a disposable copy of its backed-up data, with the original database owner's UID.
6. Save a private receipt with completion time, file count, byte count, checksums, database-check results and the stopped-writer inventory. A completed copy alone is not a verified backup.

Model weights can remain in their original read-only directories during deployment validation. Verify them against pinned upstream hashes before reuse. Never run an in-place model conversion against the only copy of a source checkpoint.

## Restore rehearsal

Use a new, empty data directory and the recorded image versions. Preserve file ownership and permissions. Never start a second database process against the active database directory, and do not allow the rehearsal's scheduler or capture endpoint to write to production storage.

Start Neo4j and Archive first, then daytime model workers, Graph Sync, Graph API and Observer. Check the databases, archive reads and worker readiness. Start the host GPU managers and sleep scheduler after those checks. If rehearsing on the same ports and GPUs, keep the original deployment stopped until the rehearsal has fully released them.

To return from an isolated validation, stop its scheduler, confirm both GPU managers have released their leases, stop its managers and containers, and restart the original deployment using its recorded configuration. Verify service health and the capture origin. Keep the verified backup until a separate retention decision is made.

To move the original data into a new Eleagent deployment instead of restarting the original services, follow [Phase 4 of the agent runbook](agent-runbook.md#phase-4-migrate-data).
