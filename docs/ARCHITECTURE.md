# Kocpy 0.1.31 architecture

## Recoverable workstation exchange

Every installation owns a random UUID stored under the application data directory. Hostname changes update only the display label. Identity corruption fails closed rather than silently creating a new workstation. Schema-3 exchange packages bind the source identity, a unique export ID, export time, application version, workspace revision and digest, exchange-scope digest, and task/project tombstones under a complete SHA-256 integrity digest.

Import is split into a read-only preview and an explicit commit. Preview compares projects field by field, append-only evidence by stable ID, tasks by ID and recorded-content fingerprint, templates and archive evidence by stable ID, and live records against local or remote tombstones. Every conflict defaults to the local value. There is deliberately no bulk “use incoming” action; an operator must choose each external value, enter their name, acknowledge the scope, and pass a native confirmation.

Before commit, Kocpy rereads the package and rechecks its byte digest, workspace revision/digest, and the wider exchange digest that also covers separately stored templates. Templates from the package are structurally validated and normalized before persistence. A local pre-import snapshot is written, then a recovery journal brackets template staging, authority publication and append-only audit publication. Failure before authority rolls templates back; failure after authority leaves enough evidence for startup to finalize exactly one audit without replaying the merge. Unrelated or corrupt recovery state blocks further team imports.

The audit stores source workstation/export IDs, package SHA-256, operator, preview basis, every conflict decision, decision digest, imported authority/exchange digests and result counts. A repeated package-plus-decision returns the existing audit. Imported tasks remain historical metadata only: exchange never copies, moves, deletes or revalidates original media. The LAN project index remains token-gated and read-only, with no raw paths, private handoff fields, media upload or write endpoint.

## Safe completion automation

Source suggestions are evidence-bearing drafts. A structure signature covers sorted relative paths and byte counts; it is explicitly weaker than a content hash. Volume-history suggestions use the recorded source-volume identity. Neither result mutates a composer draft until the user applies it, and applying never starts a task.

Project completion configuration is frozen through the task's project-rule snapshot and materialized as `CompletionActionRecord` suggestions only after terminal backup completion. Each action key derives from task ID, rule snapshot, action and contract version. A user supplies an operator and approves each execution; attempts remain append-only as running, completed, failed or skipped. Startup converts an interrupted running attempt to failed and never infers success.

Reports and delivery manifests store planned paths and SHA-256 before a hard-link-based no-replace publication. A restart may recover a published artifact only when the recorded digest still matches. Proxy jobs carry a per-file automation key so a partial retry adds only missing jobs. Eject remains a one-shot authorization and rechecks terminal trust, manifest requirements, current source identity, active tasks and proxy use. Completion actions cannot mutate MHL, accept manifest differences, establish baselines, delete media, reduce copy requirements or alter backup trust.

## Archive evidence authority

Workspace schema 2 adds one sealed archive-evidence domain beside tasks and projects. It contains health records, hash-chained changes, reminders and full verification runs under its own revision, commit time and SHA-256 digest; the enclosing workspace digest protects the same snapshot again. Archive evidence and any task verification-state changes are published by one serialized workspace commit. The three historical archive JSON files remain repairable compatibility mirrors and are imported only during the one-time schema-1 upgrade.

Each verification run freezes operator, scope, baseline digest and per-task evidence. A task is verified from a clone: recorded destinations are checked for current volume identity, every selected file is read and hashed, and only a successful authority commit updates the live engine. Offline, identity-unknown, missing and modified states remain distinct and produce audit changes. A reminder advances its next due date only after a completed project run; notification changes only `lastNotifiedAt`.

Archive repair rehashes the chosen healthy source, rechecks the target volume identity, publishes through a unique same-directory temporary file, preserves any existing damaged target under a non-colliding name, and rehashes the published file. A recovery journal is updated at preservation and publication boundaries. Completed and partial outcomes enter the authority before the journal is removed, and a successful repair is followed by whole-card reverification. Project archive reports bind the evidence revision/digest, runs, health, changes, reminders and unresolved issues under a report SHA-256.

## Workspace authority and commit boundary

`workspace-state.json` is the authoritative task/project state. It carries a schema version, monotonic revision, commit time, SHA-256 digest, complete task/project snapshots and deletion tombstones. `tasks.json` and `projects.json` remain compatibility mirrors for 0.1.25 readers. `catalog.sqlite` is a searchable replica and recovery snapshot, not a second business authority.

All task and project mutations enter one serialized `WorkspaceRepository`. A commit atomically publishes authority first, writes compatibility mirrors and their revision marker second, then transactionally reconciles SQLite entity digests and the matching workspace snapshot. Active transfers keep the crash-safe authoritative checkpoint cadence but defer the duplicate large compatibility write until settlement or the next explicit state transition. If the process stops between stages, startup selects the highest valid revision, verifies its digest, repairs mirrors and reconciles the catalog. Index failure never changes a committed business result.

The first 0.1.26 launch treats a valid legacy JSON array—including an explicit empty array—as authoritative for its domain. SQLite fills a domain only when its JSON mirror is absent or unrecoverable. Once a compatibility marker exists, invalid authority copies block startup instead of resetting the revision from legacy mirrors. A newer unknown schema also blocks startup. These guards prevent stale indexes, backups or unsupported downgrades from reviving deleted records.

Task and project identifiers are unique within the envelope; live records cannot overlap tombstones. SQLite schema 6 stores entity digests and the exact indexed workspace revision. Reconciliation removes extra rows and updates changed entities inside one transaction; deleting the SQLite file is recoverable from the authority state. Diagnostic exports include only workspace counts, revision and a shortened digest, never the complete workspace or media paths.

## Large-workspace checkpoints and index lifecycle

The authority commit computes each domain digest once, seals one canonical serialized document, and sends those exact bytes through the existing atomic storage boundary. This avoids duplicate whole-document serialization without changing validation, SHA-256 integrity, backup rotation, directory synchronization, or commit order. No-op domain writes preserve the existing revision; active transfer checkpoints remain explicit durable commits.

Catalog schema 6 installs transactional dirty triggers on tasks, files, projects, and workspace entities. Startup may skip row-by-row reconciliation only when the dirty flag is clear and catalog metadata, indexed workspace snapshot, revision, digest, and schema all match the validated authority. Missing triggers or any tracked-table mutation mark the index dirty and force a complete drift check, including same-count path or size changes.

Catalog publication uses a durable hard-link rollback point, with a copy fallback, before the SQLite transaction is persisted. If publication fails after commit, the rollback database is integrity-checked, atomically restored, and reopened; the in-memory database is never allowed to advertise an unpublished state. Bulk internal rebuilds temporarily remove dirty triggers inside the same transaction and reinstall them before commit, avoiding per-row trigger overhead without leaving a crash window on disk.

Library pages use a scope-bound opaque keyset cursor ordered by creation time, task identifier and relative path. A cursor from a different project, query or media kind is rejected. Online path probes are flattened and executed with a maximum concurrency of 16 while retaining row order.

## Backup-priority resource scheduling

Proxy processing cannot begin while a backup action is queued or the transfer engine is active. Before starting copy, resume, failed-target retry, recovery or reverification, a running proxy receives an abort request and settles as paused with `pauseReason: backup-priority`. The backup action waits for this safe boundary rather than competing for sustained reads and writes.

After the backup engine is idle and the authoritative workspace settlement succeeds, only backup-priority pauses return to pending. A user pause is recorded as `pauseReason: user` and is never auto-resumed. On application restart there is no surviving active backup process, so an old backup-priority pause may return to the pending queue; stale proxy `running` states remain failures requiring an explicit retry.

## Proxy evidence and delivery publication

Each new proxy job freezes a source task identifier, relative path, exact verified-copy path, byte count, original hash algorithm and digest, media snapshot, and complete parameter snapshot. Processing starts with a full source rehash; a matching size is not accepted as proof. FFmpeg writes to an owned temporary directory and publishes a uniquely named output without replacement. Kocpy then hashes that output with SHA-256 and records its measured media properties before the job becomes deliverable.

Delivery preflight fully rehashes every selected output and rejects case-folded basename collisions. A formal package is built in an owned hidden directory beside the final destination: copied media is rehashed and synchronized, generated manifests reference the eventual package `Media` paths, and files/directories are synchronized before one same-filesystem rename publishes the package. Failure removes only the owned staging directory. Older completed jobs without source/parameter/output evidence remain historical records and must be regenerated for formal delivery.

## Shared trust decisions

`src/common/task-trust.ts` is the metadata-only authority for content trust, manifest requirements and project coverage. UI lists, live detail, closeout and exported task/day/project reports consume the same decisions. Paged IPC omits file rows deliberately; an empty list payload does not erase historical hash evidence. Terminal success and sufficient verified targets are required for countable copies. An old extra-file acceptance never waives missing, size or checksum differences. Raw execution status and per-target historical flags remain available for audit; derived labels do not mutate records.

## Transfer pipeline

1. Scan the source without following symbolic links.
2. Hash fresh source files during distribution; existing/resumed files use a prehash for safe comparison.
3. Fan one source read out to every destination that shares the same resume offset.
4. Sync and publish each `.partial` file without replacing an existing original.
5. Start a separate verification pass and read every destination back independently.
6. Rescan the source and verify its identity before success; inspect verified destinations' current storage topology without replacing content verification.
7. Persist checkpoints while the task is active; interrupted jobs validate partial prefixes before continuing.

The UI samples completed writes/readbacks every second and retains recent speed series. Source-equivalent throughput is distinct from aggregate target writes. State transitions bypass progress throttling; task detail resolves the current task rather than retaining a stale snapshot.

## Safety properties

- Source and destination aliases/nesting are rejected after canonicalization.
- Conflicting files are never overwritten.
- Free space is aggregated per physical volume and duplicate targets on one volume trigger a warning.
- Completion requires independent destination hashes to match the source hash.
- A paused or interrupted task never reports success.

## Runtime compatibility

Kocpy ships separate native FFmpeg binaries for Apple Silicon and Intel. All tasks, projects, preferences, thumbnails, and proxy records remain in the Kocpy local data directory.

## Window layout

Normal main windows use a 1.4–2.0 aspect-ratio band and a screen-fitted 1080×720 minimum. Display moves update constraints; full-screen and maximized windows remain OS-managed. Sidebar fonts/icons stay fixed, with an independently scrolling navigation area. Page content, tables and modal bodies have separate overflow boundaries; controls wrap without stretching their height.

## Copy evidence and closeout

`copy-evidence.ts` separates verified target instances from independent storage groups. Evidence carries a random inspection ID, checked time, volume UUID, known whole-device domains and an explanation. OS device node names are only compared within one inspection, never across historical retries or workstations. APFS stores/partitions map to whole disks; unknown RAID/network/virtual topology cannot add a second independent copy. Existing records remain intact; online reverification can refresh evidence.

Project matrices, task conclusions and reports share the same copy requirement functions. Expected devices with unsafe records need attention. Rest/unused declarations exempt only empty cells. Content verification, manifest requirements and independence evidence are distinct conditions.

## Media distribution and release

Both media architectures are built from the same pinned FFmpeg/x264 sources without nonfree/autodetected external libraries. Full licenses, exact source archives, build scripts and provenance accompany the runtime. Before/after packaging hooks reject hash/source/license mismatches. CI uses native architecture runners for regression and packaged runtime tests, then one aggregation job stages a draft containing both installers, corresponding source and checksums. Publication requires verification of the exact staged artifacts and actual desktop checks; no asset overwrite is performed.

## Existing-backup reconciliation

Project refresh operates on imported records only. It removes a parent record only when its normalized non-manifest file path/size set exactly equals the union of recorded descendant card folders. Card-root MHL/SHA manifests are parsed independently; nested manifests are never assigned to a parent folder. Metadata refresh compares paths and sizes without hashing media, while manifest import supports MD5, SHA-1, SHA-256, and decimal xxHash32 and performs full per-file checksum verification.

## Reliability diagnostics

The diagnostics module classifies recovery state without reading media content. Exported snapshots include application and system versions, volume capacity and anonymized identity, transfer performance summaries, recent fault events, and benchmark history. Full source and destination paths and file lists are excluded.

The optional volume benchmark writes and reads a bounded 64 MiB temporary file in a user-selected directory, synchronizes it before readback, and removes it in a `finally` path. It cannot run while backup or proxy work is active.
