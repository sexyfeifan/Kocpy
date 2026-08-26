# Kocpy 0.0.1 architecture

## Transfer pipeline

1. Scan the source without following symbolic links.
2. Hash the source file once.
3. Fan one source read out to every destination that shares the same resume offset.
4. Sync and publish each `.partial` file without replacing an existing original.
5. Start a separate verification pass and read every destination back independently.
6. Persist checkpoints while the task is active; interrupted jobs validate partial prefixes before continuing.

The UI reports two rates. `aggregateSpeedBps` is physical bytes written across all destinations and is labelled “实时物理写入”. `speedBps` is source-equivalent throughput. Both use a two-second sliding window over real completed writes; neither is simulated.

## Safety properties

- Source and destination aliases/nesting are rejected after canonicalization.
- Conflicting files are never overwritten.
- Free space is aggregated per physical volume and duplicate targets on one volume trigger a warning.
- Completion requires independent destination hashes to match the source hash.
- A paused or interrupted task never reports success.

## Compatibility

Kocpy ships separate native FFmpeg binaries for Apple Silicon and Intel. The app automatically imports previous `New Kocpy` task, project and settings JSON on the first launch without deleting the old data.
