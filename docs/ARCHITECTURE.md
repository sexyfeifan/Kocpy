# Kocpy 0.1.20 architecture

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

## Compatibility

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
