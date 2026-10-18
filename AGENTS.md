# Kocpy engineering and release rules

## Safety

- Preserve unrelated work and existing task compatibility. Prefer small, tested changes.
- Never weaken checksum verification, path containment, identity checks, exclusive writes,
  or recovery evidence to make a test or workflow pass.
- Tests use generated fixtures and isolated temporary directories. Do not mutate users'
  production projects, source media, destination backups or original manifests.
- Copy completion, content verification and independent-copy policy are separate facts.
  Unknown storage topology is not proof of physical independence.
- Schedule exemptions may explain an empty cell, never erase risk in recorded material.
- Defect fixes require a regression test where practicable and related failure-path checks.

## Change-impact and workflow review

- Every functional update requires a recorded end-to-end impact review, not just review of
  the edited component. Start with the actual diff and trace UI input -> IPC authorization
  -> frozen scope/rules/paths -> execution/recovery -> persistence/index -> trust/statistics
  -> reports/delivery/archive/workstation exchange -> user guidance.
- Before implementation and again before release, decide whether a complete workflow
  review is required and record the reason. Changes to source selection, associated-file
  grouping, dates/devices, paths, checksums, storage identity, recovery, persistent schemas,
  record deletion, archive repair, evidence exchange or bundled runtimes always trigger it.
- Scope changes must explicitly include completion actions, closeout, bulk/manual eject,
  every report/manifest format and archive-package naming as downstream consumers.
  Add counterexamples such as failed whole-card -> successful subfolder, confirmed dates
  differing from the task day, and distinct IDs sharing the same display prefix. Passing
  happy-path tests or a legacy expectation is not evidence that a safety predicate is valid.
- For every code release, run the full automated regression suite and existing release
  gates, plus isolated ordinary/project workflow smoke checks and actual affected GUI
  checks. Add failure, cancellation, restart and legacy/round-trip cases according to the
  impact. Static/hidden UI fixtures do not replace desktop acceptance.
- UI-only changes still require default/minimum/wide, long-content, theme, focus and
  failure-guidance checks for affected screens. Documentation-only changes do not require
  a new binary version; verify links, behavior claims and published/candidate status.
- Classify each gap as reproduced defect, unverified risk/coverage gap, accepted product
  boundary or optional enhancement. Record evidence, affected versions/stages, impact,
  required action, release-blocking decision and closure criteria; do not turn an
  untested possibility into a confirmed bug or a skipped test into a pass.
- Source mutation, unauthorized overwrite, false verification/whole-card/independence
  claims, lost recovery/evidence or a broken core workflow block affected releases.
  Lesser interaction issues may be deferred only with an explicit reason and safe
  workaround. A review is not a zero-defect guarantee.
- Reassess historical hardware/NLE/multi-Mac evidence when relevant filesystem, runtime,
  media, persistence or interchange code changes. Run physical/disruptive tests only on
  explicitly authorized disposable devices; unavailable evidence stays unverified and
  limits claims. Track required retests instead of silently inheriting old certification.
- Keep a per-version gap inventory and resume state. Store private review decisions and
  execution evidence outside the repository; public documents may describe implemented
  behavior, verified limitations and general engineering rules, never private planning.

## User interface

- Keep sidebar font and icon sizes stable. Scroll content instead of scaling the page down.
- Validate default/minimum/wide windows, long paths, loading/error states and light/dark themes.
- Critical actions must be reachable; destructive operations need explicit scope and confirmation.
- Static rendering and unit tests do not count as an actual desktop interaction test.

## Privacy

- Private planning documents, their revisions, attachments, converted copies and private
  execution ledgers stay outside this repository, packages and all public GitHub surfaces.
- Public documentation describes implemented behavior and general engineering rules only.
- Do not publish real footage, identifying project fixtures, private paths or raw diagnostic data.

## Release

- Check the remote version before assigning the next consecutive patch version.
- Never force-push, reuse a version, replace published binaries or remove historical releases
  without separate explicit authorization.
- Known severe data-safety/core-flow defects block affected releases.
- Type checks, regression tests, build, runtime checks and relevant final-app GUI evidence
  are required; report skipped/unavailable tests honestly.
- Use one artifact-producing pipeline. Stage a draft with all required artifacts first;
  publish only after checking the exact staged artifacts. Do not mix local and CI installers.
- Refuse nonredistributable media runtimes, missing corresponding source or unsupported
  license configurations. Include exact sources, license notices and build provenance.
- Native Apple Silicon, Rosetta and native Intel checks must be labeled separately.
- No Developer ID / notarization / hardware certification claims without actual evidence.
- Keep public help, architecture notes, release notes and verification scope in sync.
