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
