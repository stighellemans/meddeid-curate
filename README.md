# meddeid-curate

Local multi-annotator reconciliation for canonical MedDeID JSONL. The
application compares two or more completed independent annotation sets,
records explicit curation decisions, and publishes primary gold data together
with an audit log.

See [prepare and annotate data](https://meddeid.github.io/workflows/prepare-and-annotate/#5-curate-only-when-required)
for when curation belongs in a study. This repository remains authoritative for
reconciliation decisions, audit behavior, and gold publication.

## Run locally

Requirements: Node.js 20 or later and npm.

```bash
npm install
npm run dev
```

Open `http://localhost:5183`, select two or more completed canonical JSONL
files, and enter a pseudonymous curator identifier. The working project is
stored at `data/project.json`.

Each input row must contain:

- `document_id`, stable within the dataset revision;
- identical `text` across all submitted annotation sets;
- canonical `spans` using half-open Unicode-code-point offsets; and
- `annotated: true` or `completed: true`.

An explicitly completed row with `spans: []` means that the document was
reviewed and contains no PII. A missing row is treated as an incomplete
submission.

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
confirmation accepts the current curated pane as the intended result; untouched
differences are recorded as intentionally absent rather than forcing a separate
decision for each one. Any later edit invalidates that confirmation. Source text
cannot be edited.

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

## Docker

The released container is the default route; no source checkout or Node.js
installation is required:

```bash
docker pull ghcr.io/stighellemans/meddeid-curate:0.1.0
mkdir -p curation-data
docker run --rm -p 127.0.0.1:8793:8793 \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -v "$PWD/curation-data:/app/data" \
  ghcr.io/stighellemans/meddeid-curate:0.1.0
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
