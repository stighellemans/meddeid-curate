# meddeid-curate

Local multi-annotator reconciliation for canonical MedDeID JSONL. The
application compares two or more completed independent annotation sets,
records explicit curation decisions, and publishes primary gold data together
with an audit log.

See [prepare and annotate data](https://stighellemans.github.io/meddeid/workflows/prepare-and-annotate/#6-reconcile-multiple-reviewers-only-when-required)
for when curation belongs in a study. This repository remains authoritative for
reconciliation decisions, audit behavior, and gold publication.

## Interface preview

![Multi-annotator curation interface comparing synthetic annotation sets and their disagreements](docs/images/interface.jpg)

The example uses synthetic data. It shows the curated result beside read-only
annotator lanes, with disagreement navigation and whole-document confirmation.

## Run locally

Requirements: Node.js 20 or later and npm.

```bash
npm install
npm run dev
```

Open `http://localhost:5183`, select two or more completed canonical JSONL
files, and enter a pseudonymous curator identifier. The working project is
stored at `data/project.json`.

For the shared, switchable workspace, start with:

```bash
MEDDEID_WORKSPACE_DIR=/absolute/path/to/shared-workspace npm run dev
```

Curate then opens a comparison library. **New comparison → From workspace** selects completed Annotate assignments from that same folder, while **Import files** supports external reviewer files. Each comparison has separate inputs, decisions and finalized versions under `curate/<id>/`. Use **Workspace** to switch comparisons; clicking outside the controls collapses them and restores the editor's full height. Several comparisons can be open in separate browser tabs.

After confirming all texts, **Publish gold** preserves a finalized version. In Subannotate, **From workspace** can select that exact version without downloading or copying files. For direct navigation, set `VITE_WORKSPACE_SUBANNOTATE_URL` when starting/building the frontend. The suite's preview launcher and Compose configuration set the companion URLs automatically. All three applications must use the same `MEDDEID_WORKSPACE_DIR`.

A legacy `curate/project.json` already in the shared folder is copied once into the library without removing the original. Old published gold is preserved; republish the comparison to mark its current working state finalized.

Without `MEDDEID_WORKSPACE_DIR`, the standalone application retains its single active comparison at `data/project.json` (or `MEDDEID_CURATE_DATA_DIR`). In that legacy mode, **New comparison** warns before replacing the current project after successful validation.

For train, validation and test, create separate comparisons and select reviewer versions of the same split. All inputs must contain the same documents and text. Explicit split labels are checked when selecting workspace sources.

Each input row must contain:

- `document_id`, stable within the dataset revision;
- identical `text` across all submitted annotation sets;
- canonical `spans` using half-open Unicode-code-point offsets; and
- `annotated: true` or `completed: true`.

An explicitly completed row with `spans: []` means that the document was
reviewed and contains no PII. A missing row is treated as an incomplete
submission.

The import screen also offers a collapsed **Start from prior curation** option.
One canonical curated JSONL can seed the working result without counting as an
annotator: exact submitted candidates are restored as included, unmatched spans
remain curator edits, and omitted candidates are restored as absent. The seed
must contain the same documents and immutable text as the annotation sets, and
all documents still require whole-text confirmation.

## Annotation-set manifests

For durable lineage, submit each JSONL file with a manifest:

```json
{
  "manifest_version": "meddeid.annotation-set.v1",
  "annotation_set_id": "hospital-a-round-1",
  "status": "completed",
  "annotator_id": "reviewer-7",
  "contracts": {
    "schema_version": "meddeid.schema.v1",
    "offset_unit": "unicode_codepoints",
    "taxonomy_contract_version": 1,
    "taxonomy_version": "ProductionLabels-v1.1"
  },
  "files": {"annotations": "reviewer-a.jsonl"},
  "hashes": {"annotations_sha256": "<sha256>"}
}
```

The application validates the declared file, checksum, completion status, and
contracts. Bare JSONL files are accepted with a content-addressed annotation-set
identifier, but an explicit manifest is recommended for reproducible projects.

## Curation decisions

Exact `(begin, end, label)` agreement is retained automatically. Non-unanimous
candidates are shown as optional differences. The curator can:

- retain a submitted candidate;
- retain no span; or
- author a corrected, split, or combined outcome.

Every action appends an audit event containing the curator, document,
disagreement, candidate, timestamp, and previous decision. Whole-document
confirmation normally follows explicit review of every difference. If differences
remain, the interface requires a warning dialog before confirmation; continuing
explicitly records every untouched difference as absent in the audit event. Any
later edit invalidates that confirmation. Source text cannot be edited.

Use the document list to choose which document you are working on. Its filters
show documents still to review, confirmed documents, or all documents. You may
review them in any order, but every document must receive whole-text
confirmation before the comparison can be published.

## Publish gold

Publication is blocked while a document lacks whole-text confirmation.
**Publish gold** atomically replaces the current
canonical output:

```text
data/exports/annotations.jsonl
data/exports/decisions.jsonl
data/exports/manifest.json
```

The manifest pins the annotations and decision log by SHA-256.
`annotations.jsonl` uses the same format as `meddeid-annotate` output and can be
linked directly to `meddeid-subannotate`.

These filenames are fixed within one data directory. Publishing a different
comparison there replaces the existing export. Keep splits—and separate rounds
that must be retained—in different directories, for example:

```text
curation-data/
├── train/exports/
├── validation/exports/
└── test/exports/
```

## Docker

The released container is the default route; no source checkout or Node.js
installation is required:

```bash
docker pull ghcr.io/stighellemans/meddeid-curate:0.3.0
split=train
mkdir -p "curation-data/$split"
docker run --rm -p 127.0.0.1:8793:8793 \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -v "$PWD/curation-data/$split:/app/data" \
  ghcr.io/stighellemans/meddeid-curate:0.3.0
```

To test an unreleased source change instead, run
`docker build -t meddeid-curate .` and substitute that image name above.

## Security and development

All data stays on the local host. The application does not provide network
authentication; do not expose it without an authenticated TLS reverse proxy.

```bash
npm test
npm run test:browser
```

## Licence

AGPL-3.0-only.

### Updating linked workspace sources

Managed reviews detect newer workspace sources on opening, focus and every 30 seconds while visible. **Newer source available** opens an impact preview; **Update this review** applies it to the same assignment, retaining compatible work and reopening affected content for review. Unsaved work must finish saving first. Curate requires a new publication before its corrections are available to Subannotate. Profile pins and previous published versions remain unchanged.

Use **Source updates → Recovery versions** to restore the state before an update; the current state is retained first. Recovery files are deduplicated under the assignment's `.source-history/` directory. Include hidden directories when backing up the workspace. Stale previews and stale browser writes are rejected. File-only imports have no linked workspace source to monitor.
