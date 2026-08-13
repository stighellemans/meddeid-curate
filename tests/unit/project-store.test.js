import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createProjectStore } from '../../server/project-store.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function jsonl(span) {
  return `${JSON.stringify({
    document_id: 'doc-001',
    text: 'Alice arrived.',
    annotated: true,
    spans: span ? [span] : [],
  })}\n`;
}

test('store persists decisions and one current canonical gold output', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meddeid-curate-'));
  try {
    const store = createProjectStore({ rootDir, dataDir });
    await store.load();
    const imported = await store.importFiles([
      { name: 'a.jsonl', content: jsonl({ begin: 0, end: 5, text: 'Alice', label: 'Name:Patient' }) },
      { name: 'b.jsonl', content: jsonl(null) },
    ], { curatorId: 'curator-test' });
    assert.equal(imported.stats.pending, 1);
    await assert.rejects(store.finalize(), /still require a decision/);

    const doc = imported.project.documents[0];
    const disagreement = doc.disagreements[0];
    const candidate = disagreement.candidates[0];
    const resolved = await store.resolveDisagreement(doc.document_id, disagreement.disagreement_id, {
      decision: 'accept_candidate',
      candidateId: candidate.candidate_id,
      curatorId: 'curator-test',
    });
    assert.equal(resolved.stats.pending, 0);
    assert.equal(resolved.project.decision_events.length, 1);
    await assert.rejects(store.finalize(), /whole-text confirmation/);
    const confirmed = await store.confirmDocument(doc.document_id, { curatorId: 'curator-test' });
    assert.equal(confirmed.stats.confirmedDocuments, 1);
    assert.equal(confirmed.project.documents[0].curation_status, 'confirmed');
    assert.equal(confirmed.project.decision_events.at(-1).action, 'confirm_document');

    const published = await store.finalize();
    const manifest = JSON.parse(await fs.readFile(published.manifestPath, 'utf8'));
    assert.equal(manifest.manifest_version, 'meddeid.primary-gold.v1');
    assert.equal(manifest.status, 'published');
    assert.equal(Object.hasOwn(manifest, 'freeze_id'), false);
    assert.equal(manifest.hashes.decisions_sha256.length, 64);
    const output = JSON.parse((await fs.readFile(published.annotationsPath, 'utf8')).trim());
    assert.equal(output.spans[0].span_id.startsWith('span-'), true);
    assert.equal(output.dataset_id, resolved.project.dataset.dataset_id);
    assert.equal(output.adjudication.sources[0].startsWith('annotation-set-'), true);
    assert.deepEqual((await fs.readdir(path.join(dataDir, 'exports'))).sort(), [
      'annotations.jsonl',
      'decisions.jsonl',
      'manifest.json',
    ]);
    assert.equal((await store.finalize()).reused, true);

    await store.resolveDisagreement(doc.document_id, disagreement.disagreement_id, {
      decision: 'custom_spans',
      spans: [{ begin: 0, end: 4, label: 'Name:Patient' }],
      curatorId: 'curator-test',
    });
    await store.confirmDocument(doc.document_id, { curatorId: 'curator-test' });
    const replaced = await store.finalize();
    assert.equal(replaced.annotationsPath, published.annotationsPath);
    assert.equal(
      JSON.parse((await fs.readFile(replaced.annotationsPath, 'utf8')).trim()).spans[0].end,
      4,
    );
    assert.deepEqual((await fs.readdir(path.join(dataDir, 'exports'))).sort(), [
      'annotations.jsonl',
      'decisions.jsonl',
      'manifest.json',
    ]);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('store validates and persists curator-authored edit and split decisions', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meddeid-curate-custom-'));
  try {
    const store = createProjectStore({ rootDir, dataDir });
    await store.load();
    const imported = await store.importFiles([
      { name: 'a.jsonl', content: jsonl({ begin: 0, end: 5, text: 'Alice', label: 'Name:Patient' }) },
      { name: 'b.jsonl', content: jsonl(null) },
    ], { curatorId: 'curator-test' });
    const doc = imported.project.documents[0];
    const disagreement = doc.disagreements[0];
    const resolved = await store.resolveDisagreement(doc.document_id, disagreement.disagreement_id, {
      decision: 'custom_spans',
      spans: [
        { begin: 0, end: 2, label: 'Name:Patient' },
        { begin: 2, end: 5, label: 'Name:Other' },
      ],
      curatorId: 'curator-test',
    });
    assert.deepEqual(resolved.project.documents[0].spans.map((span) => span.text), ['Al', 'ice']);
    assert.equal(resolved.project.decision_events[0].action, 'custom_spans');
    assert.equal(resolved.project.decision_events[0].spans.length, 2);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('whole-text confirmation accepts the current curated result without forcing every difference', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meddeid-curate-optional-differences-'));
  try {
    const store = createProjectStore({ rootDir, dataDir });
    await store.load();
    const imported = await store.importFiles([
      { name: 'a.jsonl', content: jsonl({ begin: 0, end: 5, text: 'Alice', label: 'Name:Patient' }) },
      { name: 'b.jsonl', content: jsonl(null) },
    ], { curatorId: 'curator-test' });
    const disagreementId = imported.project.documents[0].disagreements[0].disagreement_id;

    const confirmed = await store.confirmDocument('doc-001', { curatorId: 'curator-test' });
    const disagreement = confirmed.project.documents[0].disagreements[0];
    assert.equal(confirmed.stats.pending, 0);
    assert.equal(confirmed.stats.confirmedDocuments, 1);
    assert.equal(disagreement.disagreement_id, disagreementId);
    assert.equal(disagreement.decision.type, 'reject_all');
    assert.equal(disagreement.decision.implicit, true);
    assert.deepEqual(
      confirmed.project.decision_events.at(-1).untouched_disagreements_retained_as_absent,
      [disagreementId],
    );
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('store automatically persists direct curator span add, relabel, and delete actions', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meddeid-curate-direct-'));
  try {
    const store = createProjectStore({ rootDir, dataDir });
    await store.load();
    const imported = await store.importFiles([
      { name: 'a.jsonl', content: jsonl(null) },
      { name: 'b.jsonl', content: `${JSON.stringify({ document_id: 'doc-001', text: 'Alice arrived.', annotated: true, spans: [], metadata: { reviewer: 'b' } })}\n` },
    ], { curatorId: 'curator-test' });
    assert.equal(imported.project.documents[0].spans.length, 0);

    const added = await store.mutateCuratorSpan('doc-001', {
      action: 'add',
      span: { begin: 0, end: 5, label: 'Name:Patient' },
      curatorId: 'curator-test',
    });
    const curatorSpanId = added.project.documents[0].curator_spans[0].curator_span_id;
    assert.equal(added.project.documents[0].spans[0].text, 'Alice');
    assert.equal(added.project.decision_events.at(-1).action, 'curator_span_add');

    const relabeled = await store.mutateCuratorSpan('doc-001', {
      action: 'update',
      curatorSpanId,
      span: { begin: 0, end: 5, label: 'Name:Other' },
      curatorId: 'curator-test',
    });
    assert.equal(relabeled.project.documents[0].spans[0].label, 'Name:Other');
    assert.equal(relabeled.project.decision_events.at(-1).action, 'curator_span_update');

    const deleted = await store.mutateCuratorSpan('doc-001', {
      action: 'delete',
      curatorSpanId,
      curatorId: 'curator-test',
    });
    assert.equal(deleted.project.documents[0].spans.length, 0);
    assert.equal(deleted.project.decision_events.at(-1).action, 'curator_span_delete');
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('store audits curator overrides of agreed spans without changing source agreement', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meddeid-curate-consensus-'));
  try {
    const store = createProjectStore({ rootDir, dataDir });
    await store.load();
    const agreed = { begin: 0, end: 5, text: 'Alice', label: 'Name:Patient' };
    const imported = await store.importFiles([
      { name: 'a.jsonl', content: jsonl(agreed) },
      {
        name: 'b.jsonl',
        content: `${JSON.stringify({
          document_id: 'doc-001',
          text: 'Alice arrived.',
          annotated: true,
          spans: [agreed],
          metadata: { reviewer: 'b' },
        })}\n`,
      },
    ], { curatorId: 'curator-test' });
    const consensusSpanId = imported.project.documents[0].consensus_spans[0].consensus_span_id;

    const relabeled = await store.mutateCuratorSpan('doc-001', {
      action: 'update',
      consensusSpanId,
      span: { begin: 0, end: 5, label: 'Name:Other' },
      curatorId: 'curator-test',
    });
    assert.equal(relabeled.project.documents[0].consensus_spans[0].label, 'Name:Patient');
    assert.equal(relabeled.project.documents[0].spans[0].label, 'Name:Other');
    assert.equal(relabeled.project.documents[0].spans[0].consensus_override, true);
    assert.equal(relabeled.project.decision_events.at(-1).action, 'consensus_span_update');

    const deleted = await store.mutateCuratorSpan('doc-001', {
      action: 'delete',
      consensusSpanId,
      curatorId: 'curator-test',
    });
    assert.equal(deleted.project.documents[0].consensus_spans.length, 1);
    assert.equal(deleted.project.documents[0].spans.length, 0);
    assert.equal(deleted.project.decision_events.at(-1).action, 'consensus_span_delete');

    const undone = await store.undo({ curatorId: 'curator-test' });
    assert.equal(undone.project.documents[0].spans[0].label, 'Name:Other');
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('store supports audited undo and redo for curation changes', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meddeid-curate-history-'));
  try {
    const store = createProjectStore({ rootDir, dataDir });
    await store.load();
    const imported = await store.importFiles([
      { name: 'a.jsonl', content: jsonl({ begin: 0, end: 5, text: 'Alice', label: 'Name:Patient' }) },
      { name: 'b.jsonl', content: jsonl(null) },
    ], { curatorId: 'curator-test' });
    const doc = imported.project.documents[0];
    const disagreement = doc.disagreements[0];
    const candidate = disagreement.candidates[0];

    const resolved = await store.resolveDisagreement(doc.document_id, disagreement.disagreement_id, {
      decision: 'accept_candidate',
      candidateId: candidate.candidate_id,
      curatorId: 'curator-test',
    });
    assert.equal(resolved.history.canUndo, true);
    assert.equal(resolved.stats.pending, 0);

    const undone = await store.undo({ curatorId: 'curator-test' });
    assert.equal(undone.stats.pending, 1);
    assert.equal(undone.history.canRedo, true);
    assert.equal(undone.project.decision_events.at(-1).action, 'undo');

    const redone = await store.redo({ curatorId: 'curator-test' });
    assert.equal(redone.stats.pending, 0);
    assert.equal(redone.history.canRedo, false);
    assert.equal(redone.project.decision_events.at(-1).action, 'redo');
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
