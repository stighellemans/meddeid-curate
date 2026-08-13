import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createMergeProject, finalSpansForDocument, parseCanonicalJsonl, projectStats } from '../../server/merge-engine.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const taxonomy = JSON.parse(await fs.readFile(path.join(rootDir, 'contracts', 'taxonomy.json'), 'utf8'));

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function row(spans, overrides = {}) {
  return {
    document_id: 'doc-001',
    text: 'Alice met Bob on Monday.',
    annotated: true,
    spans,
    ...overrides,
  };
}

function manifest(annotationSetId, annotationsFilename, content, overrides = {}) {
  return JSON.stringify({
    manifest_version: 'meddeid.annotation-set.v1',
    annotation_set_id: annotationSetId,
    status: 'completed',
    annotator_id: `${annotationSetId}-reviewer`,
    contracts: {
      schema_version: 'meddeid.schema.v1',
      offset_unit: 'unicode_codepoints',
      taxonomy_contract_version: taxonomy.contract_version,
      taxonomy_version: taxonomy.taxonomy_version,
    },
    files: { annotations: annotationsFilename },
    hashes: { annotations_sha256: crypto.createHash('sha256').update(content).digest('hex') },
    ...overrides,
  });
}

test('merge retains exact agreement and groups overlapping alternatives', () => {
  const project = createMergeProject([
    {
      name: 'reviewer-a.jsonl',
      content: jsonl([row([
        { begin: 0, end: 5, text: 'Alice', label: 'Name:Patient' },
        { begin: 10, end: 13, text: 'Bob', label: 'Name:Caregiver' },
      ])]),
    },
    {
      name: 'reviewer-b.jsonl',
      content: jsonl([row([
        { begin: 0, end: 5, text: 'Alice', label: 'Name:Patient' },
        { begin: 6, end: 13, text: 'met Bob', label: 'Name:Caregiver' },
      ])]),
    },
  ], taxonomy);

  assert.equal(project.documents[0].consensus_spans.length, 1);
  assert.equal(project.documents[0].disagreements.length, 1);
  assert.equal(project.documents[0].disagreements[0].candidates.length, 2);
  assert.match(project.sources[0].annotation_set_id, /^annotation-set-/);
  assert.equal(project.dataset.offset_unit, 'unicode_codepoints');
  assert.deepEqual(projectStats(project), {
    documents: 1,
    confirmedDocuments: 0,
    consensusSpans: 1,
    disagreements: 1,
    resolved: 0,
    pending: 1,
  });
});

test('explicitly completed empty documents are distinct from missing submissions', () => {
  const emptyA = jsonl([row([], { metadata: { submission: 'a' } })]);
  const emptyB = jsonl([row([], { metadata: { submission: 'b' } })]);
  const project = createMergeProject([
    { name: 'a.jsonl', content: emptyA },
    { name: 'b.jsonl', content: emptyB },
  ], taxonomy);
  assert.equal(project.documents[0].disagreements.length, 0);

  assert.throws(
    () => createMergeProject([
      { name: 'a.jsonl', content: jsonl([row([]), row([], { document_id: 'doc-002' })]) },
      { name: 'b.jsonl', content: emptyB },
    ], taxonomy),
    /document_id set differs/,
  );
  assert.throws(
    () => parseCanonicalJsonl('incomplete.jsonl', jsonl([row([], { annotated: false })]), taxonomy),
    /not explicitly completed/,
  );
});

test('offsets are Unicode code points rather than UTF-16 code units', () => {
  const parsed = parseCanonicalJsonl(
    'emoji.jsonl',
    jsonl([{ document_id: 'emoji', text: 'A😀B', completed: true, spans: [
      { begin: 1, end: 2, text: '😀', label: 'Anonymize_Other' },
    ] }]),
    taxonomy,
  );
  assert.equal(parsed.get('emoji').spans[0].text, '😀');
});

test('package manifests provide stable annotation-set identity and validated lineage', () => {
  const contentA = jsonl([row([{ begin: 0, end: 5, label: 'Name:Patient' }])]);
  const contentB = jsonl([row([])]);
  const files = [
    { name: 'set-a.json', content: manifest('hospital-a-round-1', 'a.jsonl', contentA) },
    { name: 'a.jsonl', content: contentA },
    { name: 'set-b.json', content: manifest('hospital-b-round-1', 'b.jsonl', contentB) },
    { name: 'b.jsonl', content: contentB },
  ];
  const project = createMergeProject(files, taxonomy);
  assert.deepEqual(project.sources.map((source) => source.annotation_set_id), [
    'hospital-a-round-1',
    'hospital-b-round-1',
  ]);
  assert.equal(project.sources[0].annotator_id, 'hospital-a-round-1-reviewer');
  assert.equal(project.sources[0].manifest_filename, 'set-a.json');
  assert.deepEqual(project.documents[0].disagreements[0].candidates[0].present_in, ['hospital-a-round-1']);
  assert.deepEqual(project.documents[0].disagreements[0].candidates[0].missing_from, ['hospital-b-round-1']);

  const badHash = JSON.parse(files[0].content);
  badHash.hashes.annotations_sha256 = '0'.repeat(64);
  assert.throws(
    () => createMergeProject([{ ...files[0], content: JSON.stringify(badHash) }, ...files.slice(1)], taxonomy),
    /SHA-256 does not match/,
  );
  const incomplete = JSON.parse(files[0].content);
  incomplete.status = 'in_progress';
  assert.throws(
    () => createMergeProject([{ ...files[0], content: JSON.stringify(incomplete) }, ...files.slice(1)], taxonomy),
    /status must be completed/,
  );
  const wrongContract = JSON.parse(files[0].content);
  wrongContract.contracts.offset_unit = 'utf16_code_units';
  assert.throws(
    () => createMergeProject([{ ...files[0], content: JSON.stringify(wrongContract) }, ...files.slice(1)], taxonomy),
    /contracts.offset_unit/,
  );
  const duplicate = JSON.parse(files[2].content);
  duplicate.annotation_set_id = 'hospital-a-round-1';
  assert.throws(
    () => createMergeProject([...files.slice(0, 2), { ...files[2], content: JSON.stringify(duplicate) }, files[3]], taxonomy),
    /annotation_set_id values must be unique/,
  );
});

test('accepted candidates become final spans while rejected groups do not', () => {
  const project = createMergeProject([
    { name: 'a.jsonl', content: jsonl([row([{ begin: 0, end: 5, label: 'Name:Patient' }])]) },
    { name: 'b.jsonl', content: jsonl([row([])]) },
  ], taxonomy);
  const disagreement = project.documents[0].disagreements[0];
  disagreement.status = 'resolved';
  disagreement.decision = { type: 'accept_candidate', candidate_id: disagreement.candidates[0].candidate_id };
  assert.equal(finalSpansForDocument(project.documents[0]).length, 1);
  disagreement.decision = { type: 'reject_all', candidate_id: null };
  assert.equal(finalSpansForDocument(project.documents[0]).length, 0);
  disagreement.decision = {
    type: 'custom_spans',
    spans: [
      { begin: 0, end: 2, text: 'Al', label: 'Name:Patient' },
      { begin: 2, end: 5, text: 'ice', label: 'Name:Other' },
    ],
  };
  assert.deepEqual(finalSpansForDocument(project.documents[0]).map((span) => span.text), ['Al', 'ice']);
});
