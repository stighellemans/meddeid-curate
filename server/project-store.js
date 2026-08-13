import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  consensusSpanIdentity,
  createMergeProject,
  finalSpansForDocument,
  normalizeCuratedSpans,
  projectStats,
  serializeProject,
} from './merge-engine.js';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function createProjectStore({ rootDir, dataDir } = {}) {
  const root = rootDir ?? process.cwd();
  const resolvedDataDir = path.resolve(root, dataDir ?? process.env.MEDDEID_CURATE_DATA_DIR ?? 'data');
  const projectPath = path.join(resolvedDataDir, 'project.json');
  const exportsRoot = path.join(resolvedDataDir, 'exports');
  const taxonomyPath = path.join(root, 'contracts', 'taxonomy.json');
  let project = null;
  let taxonomy = null;
  let writeQueue = Promise.resolve();
  let undoHistory = [];
  let redoHistory = [];

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function recordHistory(documentId, before, after, action) {
    undoHistory.push({ documentId, before, after, action });
    undoHistory = undoHistory.slice(-100);
    redoHistory = [];
  }

  function exclusive(fn) {
    const run = writeQueue.then(fn, fn);
    writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function atomicWriteJson(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, filePath);
  }

  async function load() {
    taxonomy = JSON.parse(await fs.readFile(taxonomyPath, 'utf8'));
    if (await exists(projectPath)) {
      project = JSON.parse(await fs.readFile(projectPath, 'utf8'));
      for (const document of project.documents ?? []) {
        document.curator_spans ??= [];
        document.consensus_span_overrides ??= [];
        for (const span of document.consensus_spans ?? []) {
          span.consensus_span_id ??= consensusSpanIdentity(document.document_id, span);
        }
      }
    }
    return project;
  }

  async function publishedGold() {
    const manifestPath = path.join(exportsRoot, 'manifest.json');
    const annotationsPath = path.join(exportsRoot, 'annotations.jsonl');
    const decisionsPath = path.join(exportsRoot, 'decisions.jsonl');
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      return { manifestPath, annotationsPath, decisionsPath, manifest };
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function bootstrap() {
    return {
      ...serializeProject(project, await publishedGold()),
      history: {
        canUndo: undoHistory.length > 0,
        canRedo: redoHistory.length > 0,
      },
      taxonomy: taxonomy ? {
        entity_labels: taxonomy.entity_labels,
        categories: taxonomy.categories,
        subtypes: taxonomy.subtypes,
        subtypes_by_category: taxonomy.subtypes_by_category,
      } : null,
    };
  }

  async function importFiles(files, { curatorId } = {}) {
    return exclusive(async () => {
      const normalizedCuratorId = String(curatorId ?? '').trim();
      if (!normalizedCuratorId) {
        const error = new Error('curatorId must be a non-empty pseudonymous identifier');
        error.statusCode = 400;
        throw error;
      }
      project = createMergeProject(files, taxonomy);
      project.curator = { curator_id: normalizedCuratorId };
      undoHistory = [];
      redoHistory = [];
      await atomicWriteJson(projectPath, project);
      return bootstrap();
    });
  }

  async function resolveDisagreement(documentId, disagreementId, {
    decision,
    candidateId,
    curatorId,
    spans,
  } = {}) {
    if (!['accept_candidate', 'reject_all', 'custom_spans', 'reset'].includes(decision)) {
      const error = new Error('decision must be accept_candidate, reject_all, custom_spans, or reset');
      error.statusCode = 400;
      throw error;
    }
    return exclusive(async () => {
      if (!project) {
        const error = new Error('No adjudication project is loaded');
        error.statusCode = 409;
        throw error;
      }
      const document = project.documents.find((doc) => doc.document_id === documentId);
      if (!document) {
        const error = new Error(`Unknown document_id: ${documentId}`);
        error.statusCode = 404;
        throw error;
      }
      const disagreement = document.disagreements.find((item) => item.disagreement_id === disagreementId);
      if (!disagreement) {
        const error = new Error(`Unknown disagreement_id: ${disagreementId}`);
        error.statusCode = 404;
        throw error;
      }
      if (decision === 'accept_candidate' && !disagreement.candidates.some((item) => item.candidate_id === candidateId)) {
        const error = new Error(`Unknown candidate_id: ${candidateId}`);
        error.statusCode = 400;
        throw error;
      }
      let curatedSpans = null;
      try {
        curatedSpans = decision === 'custom_spans'
          ? normalizeCuratedSpans(spans, document.text, taxonomy)
          : null;
      } catch (error) {
        error.statusCode = 400;
        throw error;
      }
      if (curatedSpans?.some((span) => span.begin < disagreement.begin || span.end > disagreement.end)) {
        const error = new Error('custom spans must stay inside the current disagreement range');
        error.statusCode = 400;
        throw error;
      }
      const normalizedCuratorId = String(curatorId ?? project.curator?.curator_id ?? '').trim();
      if (!normalizedCuratorId) {
        const error = new Error('curatorId is required for the decision audit log');
        error.statusCode = 400;
        throw error;
      }
      const previousDecision = disagreement.decision ? { ...disagreement.decision } : null;
      const beforeDocument = clone(document);
      document.curation_status = 'unconfirmed';
      document.confirmed_at = null;
      document.confirmed_by = null;
      disagreement.status = decision === 'reset' ? 'pending' : 'resolved';
      disagreement.decision = decision === 'reset'
        ? null
        : {
            type: decision,
            candidate_id: decision === 'accept_candidate' ? candidateId : null,
            spans: decision === 'custom_spans' ? curatedSpans : undefined,
            resolved_at: new Date().toISOString(),
          };
      project.decision_events.push({
        event_id: `decision-event-${String(project.decision_events.length + 1).padStart(6, '0')}`,
        sequence: project.decision_events.length + 1,
        occurred_at: new Date().toISOString(),
        curator_id: normalizedCuratorId,
        document_id: documentId,
        disagreement_id: disagreementId,
        action: decision,
        candidate_id: decision === 'accept_candidate' ? candidateId : null,
        spans: decision === 'custom_spans' ? curatedSpans : null,
        previous_decision: previousDecision,
      });
      recordHistory(documentId, beforeDocument, clone(document), decision);
      await atomicWriteJson(projectPath, project);
      return bootstrap();
    });
  }

  async function confirmDocument(documentId, { curatorId } = {}) {
    return exclusive(async () => {
      if (!project) {
        const error = new Error('No curation project is loaded');
        error.statusCode = 409;
        throw error;
      }
      const document = project.documents.find((doc) => doc.document_id === documentId);
      if (!document) {
        const error = new Error(`Unknown document_id: ${documentId}`);
        error.statusCode = 404;
        throw error;
      }
      const normalizedCuratorId = String(curatorId ?? project.curator?.curator_id ?? '').trim();
      if (!normalizedCuratorId) {
        const error = new Error('curatorId is required for document confirmation');
        error.statusCode = 400;
        throw error;
      }
      if (document.curation_status === 'confirmed') return bootstrap();
      const beforeDocument = clone(document);
      const occurredAt = new Date().toISOString();
      const untouchedDisagreementIds = document.disagreements
        .filter((item) => item.status !== 'resolved')
        .map((item) => item.disagreement_id);
      for (const disagreement of document.disagreements) {
        if (disagreement.status === 'resolved') continue;
        disagreement.status = 'resolved';
        disagreement.decision = {
          type: 'reject_all',
          candidate_id: null,
          implicit: true,
          resolved_at: occurredAt,
        };
      }
      document.curation_status = 'confirmed';
      document.confirmed_at = occurredAt;
      document.confirmed_by = normalizedCuratorId;
      project.decision_events.push({
        event_id: `decision-event-${String(project.decision_events.length + 1).padStart(6, '0')}`,
        sequence: project.decision_events.length + 1,
        occurred_at: occurredAt,
        curator_id: normalizedCuratorId,
        document_id: documentId,
        disagreement_id: null,
        action: 'confirm_document',
        candidate_id: null,
        spans: null,
        previous_decision: null,
        untouched_disagreements_retained_as_absent: untouchedDisagreementIds,
      });
      recordHistory(documentId, beforeDocument, clone(document), 'confirm_document');
      await atomicWriteJson(projectPath, project);
      return bootstrap();
    });
  }

  async function mutateCuratorSpan(documentId, {
    action,
    curatorSpanId,
    consensusSpanId,
    span,
    curatorId,
  } = {}) {
    if (!['add', 'update', 'delete'].includes(action)) {
      const error = new Error('action must be add, update, or delete');
      error.statusCode = 400;
      throw error;
    }
    return exclusive(async () => {
      if (!project) {
        const error = new Error('No curation project is loaded');
        error.statusCode = 409;
        throw error;
      }
      const document = project.documents.find((doc) => doc.document_id === documentId);
      if (!document) {
        const error = new Error(`Unknown document_id: ${documentId}`);
        error.statusCode = 404;
        throw error;
      }
      document.curator_spans ??= [];
      document.consensus_span_overrides ??= [];
      const existingIndex = curatorSpanId
        ? document.curator_spans.findIndex((item) => item.curator_span_id === curatorSpanId)
        : -1;
      const consensusIndex = consensusSpanId
        ? document.consensus_spans.findIndex((item) => item.consensus_span_id === consensusSpanId)
        : -1;
      if (action === 'add' && consensusSpanId) {
        const error = new Error('Consensus spans can only be updated or deleted');
        error.statusCode = 400;
        throw error;
      }
      if (action !== 'add' && existingIndex < 0 && consensusIndex < 0) {
        const error = new Error(`Unknown curator_span_id: ${curatorSpanId}`);
        error.statusCode = 404;
        throw error;
      }
      let normalizedSpan = null;
      if (action !== 'delete') {
        try {
          [normalizedSpan] = normalizeCuratedSpans([span], document.text, taxonomy);
        } catch (error) {
          error.statusCode = 400;
          throw error;
        }
        const otherSpans = finalSpansForDocument(document).filter(
          (item) => item.curator_span_id !== curatorSpanId && item.consensus_span_id !== consensusSpanId,
        );
        const overlap = otherSpans.find(
          (item) => Math.max(item.begin, normalizedSpan.begin) < Math.min(item.end, normalizedSpan.end),
        );
        if (overlap) {
          const error = new Error(`Curator span overlaps existing curated span [${overlap.begin}, ${overlap.end})`);
          error.statusCode = 400;
          throw error;
        }
      }
      const normalizedCuratorId = String(curatorId ?? project.curator?.curator_id ?? '').trim();
      if (!normalizedCuratorId) {
        const error = new Error('curatorId is required for the decision audit log');
        error.statusCode = 400;
        throw error;
      }
      const occurredAt = new Date().toISOString();
      const beforeDocument = clone(document);
      const previousSpan = consensusIndex >= 0
        ? finalSpansForDocument(document).find((item) => item.consensus_span_id === consensusSpanId) ?? null
        : existingIndex >= 0
          ? { ...document.curator_spans[existingIndex] }
          : null;
      let nextSpan = null;
      if (consensusIndex >= 0) {
        const overrideIndex = document.consensus_span_overrides.findIndex(
          (item) => item.consensus_span_id === consensusSpanId,
        );
        const nextOverride = action === 'update'
          ? { consensus_span_id: consensusSpanId, action: 'update', span: normalizedSpan }
          : { consensus_span_id: consensusSpanId, action: 'delete', span: null };
        if (overrideIndex >= 0) document.consensus_span_overrides[overrideIndex] = nextOverride;
        else document.consensus_span_overrides.push(nextOverride);
        if (action === 'update') {
          nextSpan = {
            ...normalizedSpan,
            consensus_span_id: consensusSpanId,
            consensus_override: true,
          };
        }
      } else if (action === 'add') {
        nextSpan = {
          ...normalizedSpan,
          curator_span_id: `curator-span-${sha256(JSON.stringify([
            documentId,
            normalizedSpan.begin,
            normalizedSpan.end,
            normalizedSpan.label,
            project.decision_events.length + 1,
          ])).slice(0, 16)}`,
        };
        document.curator_spans.push(nextSpan);
      } else if (action === 'update') {
        nextSpan = { ...normalizedSpan, curator_span_id: curatorSpanId };
        document.curator_spans[existingIndex] = nextSpan;
      } else {
        document.curator_spans.splice(existingIndex, 1);
      }
      document.curator_spans.sort((left, right) => left.begin - right.begin || left.end - right.end || left.label.localeCompare(right.label));
      document.curation_status = 'unconfirmed';
      document.confirmed_at = null;
      document.confirmed_by = null;
      project.decision_events.push({
        event_id: `decision-event-${String(project.decision_events.length + 1).padStart(6, '0')}`,
        sequence: project.decision_events.length + 1,
        occurred_at: occurredAt,
        curator_id: normalizedCuratorId,
        document_id: documentId,
        disagreement_id: null,
        action: `${consensusIndex >= 0 ? 'consensus_span' : 'curator_span'}_${action}`,
        candidate_id: null,
        curator_span_id: nextSpan?.curator_span_id ?? curatorSpanId,
        consensus_span_id: consensusSpanId ?? null,
        spans: nextSpan ? [nextSpan] : null,
        previous_span: previousSpan,
        previous_decision: null,
      });
      recordHistory(documentId, beforeDocument, clone(document), `${consensusIndex >= 0 ? 'consensus_span' : 'curator_span'}_${action}`);
      await atomicWriteJson(projectPath, project);
      return bootstrap();
    });
  }

  async function moveHistory(direction, { curatorId } = {}) {
    return exclusive(async () => {
      if (!project) {
        const error = new Error('No curation project is loaded');
        error.statusCode = 409;
        throw error;
      }
      const source = direction === 'undo' ? undoHistory : redoHistory;
      const target = direction === 'undo' ? redoHistory : undoHistory;
      const entry = source.pop();
      if (!entry) {
        const error = new Error(`Nothing to ${direction}`);
        error.statusCode = 409;
        throw error;
      }
      const documentIndex = project.documents.findIndex((doc) => doc.document_id === entry.documentId);
      if (documentIndex < 0) {
        const error = new Error(`Unknown document_id in history: ${entry.documentId}`);
        error.statusCode = 404;
        throw error;
      }
      const normalizedCuratorId = String(curatorId ?? project.curator?.curator_id ?? '').trim();
      if (!normalizedCuratorId) {
        const error = new Error('curatorId is required for the decision audit log');
        error.statusCode = 400;
        throw error;
      }
      project.documents[documentIndex] = clone(direction === 'undo' ? entry.before : entry.after);
      target.push(entry);
      const occurredAt = new Date().toISOString();
      project.decision_events.push({
        event_id: `decision-event-${String(project.decision_events.length + 1).padStart(6, '0')}`,
        sequence: project.decision_events.length + 1,
        occurred_at: occurredAt,
        curator_id: normalizedCuratorId,
        document_id: entry.documentId,
        disagreement_id: null,
        action: direction,
        history_action: entry.action,
        candidate_id: null,
        spans: null,
        previous_decision: null,
      });
      await atomicWriteJson(projectPath, project);
      return { ...(await bootstrap()), historyDocumentId: entry.documentId };
    });
  }

  async function undo(options) {
    return moveHistory('undo', options);
  }

  async function redo(options) {
    return moveHistory('redo', options);
  }

  async function finalize() {
    return exclusive(async () => {
      if (!project) {
        const error = new Error('No adjudication project is loaded');
        error.statusCode = 409;
        throw error;
      }
      const stats = projectStats(project);
      if (stats.pending > 0) {
        const error = new Error(`${stats.pending} disagreement(s) still require a decision`);
        error.statusCode = 400;
        throw error;
      }
      const unconfirmed = project.documents.filter((doc) => doc.curation_status !== 'confirmed');
      if (unconfirmed.length > 0) {
        const error = new Error(`${unconfirmed.length} document(s) still require whole-text confirmation`);
        error.statusCode = 400;
        throw error;
      }
      const rows = project.documents.map((doc) => ({
        document_id: doc.document_id,
        text: doc.text,
        text_sha256: sha256(doc.text),
        dataset_id: project.dataset.dataset_id,
        dataset_revision: project.dataset.dataset_revision,
        metadata: doc.metadata,
        annotated: true,
        completed: true,
        spans: finalSpansForDocument(doc).map((span) => {
          const {
            curator_span_id: _curatorSpanId,
            consensus_span_id: _consensusSpanId,
            consensus_override: _consensusOverride,
            ...canonicalSpan
          } = span;
          return {
            ...canonicalSpan,
            span_id: `span-${sha256(JSON.stringify([
              doc.document_id,
              span.begin,
              span.end,
              span.label,
            ])).slice(0, 24)}`,
          };
        }),
        adjudication: {
          contract_version: 1,
          sources: project.sources.map((source) => source.annotation_set_id),
          status: doc.disagreements.length > 0 ? 'adjudicated' : 'agreed',
          disagreements: doc.disagreements,
        },
      }));
      const jsonl = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
      const hash = sha256(jsonl);
      const decisionsJsonl = project.decision_events.length > 0
        ? `${project.decision_events.map((event) => JSON.stringify(event)).join('\n')}\n`
        : '';
      const decisionsHash = sha256(decisionsJsonl);
      const previous = await publishedGold();
      if (
        previous?.manifest?.hashes?.annotations_sha256 === hash &&
        previous?.manifest?.hashes?.decisions_sha256 === decisionsHash
      ) {
        return { ...previous, reused: true };
      }
      await fs.mkdir(exportsRoot, { recursive: true });
      const annotationsPath = path.join(exportsRoot, 'annotations.jsonl');
      const decisionsPath = path.join(exportsRoot, 'decisions.jsonl');
      const manifestPath = path.join(exportsRoot, 'manifest.json');
      const manifest = {
        manifest_version: 'meddeid.primary-gold.v1',
        status: 'published',
        published_at: new Date().toISOString(),
        contracts: project.contracts,
        dataset: project.dataset,
        curator: project.curator,
        inputs: project.sources,
        files: { annotations: 'annotations.jsonl', decisions: 'decisions.jsonl' },
        hashes: { annotations_sha256: hash, decisions_sha256: decisionsHash },
        counts: {
          documents: rows.length,
          confirmed_documents: rows.length,
          primary_gold_spans: rows.reduce((sum, row) => sum + row.spans.length, 0),
          disagreements: stats.disagreements,
          resolved_disagreements: stats.resolved,
        },
      };
      const nonce = `${process.pid}.${Date.now()}`;
      const annotationsTemporary = `${annotationsPath}.${nonce}.tmp`;
      const decisionsTemporary = `${decisionsPath}.${nonce}.tmp`;
      await fs.writeFile(annotationsTemporary, jsonl, 'utf8');
      await fs.writeFile(decisionsTemporary, decisionsJsonl, 'utf8');
      await fs.rename(annotationsTemporary, annotationsPath);
      await fs.rename(decisionsTemporary, decisionsPath);
      await atomicWriteJson(manifestPath, manifest);
      return { annotationsPath, decisionsPath, manifestPath, manifest, reused: false };
    });
  }

  return { load, bootstrap, importFiles, resolveDisagreement, mutateCuratorSpan, confirmDocument, undo, redo, finalize, publishedGold };
}
