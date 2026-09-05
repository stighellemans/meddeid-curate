# Changelog

All notable user-visible changes are recorded here. This project follows
semantic versioning while pre-1.0 versions may still refine public contracts.

## [Unreleased]

## [0.2.0] - 2026-09-05

- Added optional import of a prior curated JSONL as an audited seed without
  treating it as another annotator, while requiring matching documents and
  immutable text.
- Added explicit confirmation before unresolved differences are marked absent
  and before a new comparison replaces the active project.
- Canonicalized curator edits that exactly match a submitted candidate and
  improved document/text mismatch diagnostics with code-point offsets and
  local context.
- Added a synthetic interface preview and expanded browser and project-store
  regression coverage.

## [0.1.0] - 2026-08-17

- Published the first externally supported MedDeID Curate release.
- Added public installation, compatibility, licensing, and verification
  metadata.
- Established independent CI and immutable release artifacts.

For earlier migration history, consult the repository's Git history.
