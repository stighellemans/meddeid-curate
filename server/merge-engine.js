import crypto from 'node:crypto';

const DOCUMENT_ALIASES = ['doc_id', 'plain_text', 'annotations'];
const SPAN_ALIASES = ['Category', 'Subtype'];

function hashText(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function codePointSlice(text, begin, end) {
  return Array.from(text).slice(begin, end).join('');
}

function stableId(prefix, value) {
  const encoded = JSON.stringify(value);
  return `${prefix}-${hashText(encoded).slice(0, 16)}`;
}

function spanKey(span) {
  return `${span.begin}:${span.end}:${span.label}`;
}

export function consensusSpanIdentity(documentId, span) {
  return stableId('consensus-span', [documentId, spanKey(span)]);
}

function compareSpans(left, right) {
  return left.begin - right.begin || left.end - right.end || left.label.localeCompare(right.label);
}

function spansOverlap(left, right) {
  return Math.max(left.begin, right.begin) < Math.min(left.end, right.end);
}

function normalizeSpan(rawSpan, text, context, labels) {
  if (!rawSpan || typeof rawSpan !== 'object' || Array.isArray(rawSpan)) {
    throw new Error(`${context}: expected a span object`);
  }
  const alias = SPAN_ALIASES.find((key) => Object.hasOwn(rawSpan, key));
  if (alias) throw new Error(`${context}: unsupported span field ${JSON.stringify(alias)}`);
  const begin = Number(rawSpan.begin);
  const end = Number(rawSpan.end);
  const label = String(rawSpan.label ?? '').trim();
  if (!Number.isInteger(begin) || !Number.isInteger(end) || begin < 0 || end <= begin || end > Array.from(text).length) {
    throw new Error(`${context}: invalid [begin, end) offsets`);
  }
  if (!labels.has(label)) throw new Error(`${context}: unsupported canonical label ${JSON.stringify(label)}`);
  if (rawSpan.text !== undefined && rawSpan.text !== codePointSlice(text, begin, end)) {
    throw new Error(`${context}: span text does not match document offsets`);
  }
  return { begin, end, text: codePointSlice(text, begin, end), label };
}

export function normalizeCuratedSpans(rawSpans, text, taxonomy) {
  if (!Array.isArray(rawSpans) || rawSpans.length === 0) {
    throw new Error('custom_spans requires at least one curated span');
  }
  const labels = new Set(taxonomy.entity_labels ?? []);
  const spans = rawSpans
    .map((span, index) => normalizeSpan(span, text, `custom span ${index + 1}`, labels))
    .sort(compareSpans);
  for (let index = 1; index < spans.length; index += 1) {
    if (spansOverlap(spans[index - 1], spans[index])) {
      throw new Error('custom curated spans may not overlap');
    }
  }
  return spans;
}

export function parseCanonicalJsonl(name, content, taxonomy) {
  const labels = new Set(taxonomy.entity_labels ?? []);
  const rows = new Map();
  String(content ?? '').split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const context = `${name} line ${index + 1}`;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(`${context}: invalid JSON (${error.message})`);
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${context}: expected an object`);
    const alias = DOCUMENT_ALIASES.find((key) => Object.hasOwn(row, key));
    if (alias) throw new Error(`${context}: unsupported field ${JSON.stringify(alias)}`);
    const documentId = String(row.document_id ?? '').trim();
    if (!documentId) throw new Error(`${context}: document_id must be a non-empty string`);
    if (rows.has(documentId)) throw new Error(`${context}: duplicate document_id ${JSON.stringify(documentId)}`);
    if (typeof row.text !== 'string') throw new Error(`${context}: text must be a string`);
    if (row.spans !== undefined && !Array.isArray(row.spans)) throw new Error(`${context}: spans must be a list`);
    if (row.metadata !== undefined && (!row.metadata || typeof row.metadata !== 'object' || Array.isArray(row.metadata))) {
      throw new Error(`${context}: metadata must be an object`);
    }
    if (row.annotated !== true && row.completed !== true) {
      throw new Error(`${context}: document is not explicitly completed (set annotated or completed to true)`);
    }
    const spans = (row.spans ?? [])
      .map((span, spanIndex) => normalizeSpan(span, row.text, `${context} span ${spanIndex}`, labels))
      .sort(compareSpans);
    rows.set(documentId, {
      document_id: documentId,
      text: row.text,
      metadata: row.metadata ? { ...row.metadata } : {},
      spans,
    });
  });
  if (rows.size === 0) throw new Error(`${name}: file contains no canonical documents`);
  return rows;
}

function groupCandidates(candidates) {
  const remaining = new Set(candidates.map((_candidate, index) => index));
  const groups = [];
  while (remaining.size > 0) {
    const seed = Math.min(...remaining);
    remaining.delete(seed);
    const groupIndexes = new Set([seed]);
    const frontier = [seed];
    while (frontier.length > 0) {
      const current = candidates[frontier.pop()];
      for (const index of [...remaining]) {
        if (!spansOverlap(current.span, candidates[index].span)) continue;
        remaining.delete(index);
        groupIndexes.add(index);
        frontier.push(index);
      }
    }
    groups.push([...groupIndexes].map((index) => candidates[index]).sort((a, b) => compareSpans(a.span, b.span)));
  }
  return groups.sort((left, right) => compareSpans(left[0].span, right[0].span));
}

function assertMatchingDocuments(sources) {
  const expectedIds = [...sources[0].documents.keys()].sort();
  for (const source of sources.slice(1)) {
    const actualIds = [...source.documents.keys()].sort();
    if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
      throw new Error(`${source.name}: document_id set differs from ${sources[0].name}`);
    }
  }
  for (const documentId of expectedIds) {
    const expectedText = sources[0].documents.get(documentId).text;
    for (const source of sources.slice(1)) {
      if (source.documents.get(documentId).text !== expectedText) {
        throw new Error(`${documentId}: text differs between ${sources[0].name} and ${source.name}`);
      }
    }
  }
  return expectedIds;
}

function parseAnnotationSetManifest(file, filesByName, taxonomy) {
  let manifest;
  try {
    manifest = JSON.parse(String(file.content ?? ''));
  } catch (error) {
    throw new Error(`${file.name}: invalid annotation-set manifest JSON (${error.message})`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${file.name}: annotation-set manifest must be an object`);
  }
  if (manifest.manifest_version !== 'meddeid.annotation-set.v1') {
    throw new Error(`${file.name}: manifest_version must be meddeid.annotation-set.v1`);
  }
  const annotationSetId = String(manifest.annotation_set_id ?? '').trim();
  if (!annotationSetId) throw new Error(`${file.name}: annotation_set_id must be a non-empty string`);
  if (manifest.status !== 'completed') {
    throw new Error(`${file.name}: annotation set status must be completed`);
  }
  const contracts = manifest.contracts ?? {};
  const expectedContracts = {
    schema_version: 'meddeid.schema.v1',
    offset_unit: 'unicode_codepoints',
    taxonomy_contract_version: taxonomy.contract_version,
    taxonomy_version: taxonomy.taxonomy_version,
  };
  for (const [key, expected] of Object.entries(expectedContracts)) {
    if (contracts[key] !== expected) {
      throw new Error(`${file.name}: contracts.${key} must be ${JSON.stringify(expected)}`);
    }
  }
  const annotationsFilename = String(manifest.files?.annotations ?? '').trim();
  if (!annotationsFilename) throw new Error(`${file.name}: files.annotations must name the JSONL payload`);
  const annotationsFile = filesByName.get(annotationsFilename);
  if (!annotationsFile) throw new Error(`${file.name}: declared annotations file ${JSON.stringify(annotationsFilename)} was not selected`);
  const expectedHash = String(manifest.hashes?.annotations_sha256 ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
    throw new Error(`${file.name}: hashes.annotations_sha256 must be a lowercase SHA-256 digest`);
  }
  const actualHash = hashText(String(annotationsFile.content ?? ''));
  if (actualHash !== expectedHash) throw new Error(`${file.name}: annotations SHA-256 does not match the manifest`);
  const annotatorId = String(manifest.annotator_id ?? manifest.annotator?.annotator_id ?? '').trim() || null;
  return {
    name: annotationsFile.name,
    manifestName: file.name,
    annotationSetId,
    annotatorId,
    sha256: actualHash,
    documents: parseCanonicalJsonl(annotationsFile.name, annotationsFile.content, taxonomy),
  };
}

export function prepareAnnotationSources(files, taxonomy) {
  if (!Array.isArray(files)) throw new Error('Choose annotation files');
  const names = files.map((file) => String(file?.name ?? '').trim());
  if (names.some((name) => !name)) throw new Error('Every input file needs a filename');
  if (new Set(names).size !== names.length) throw new Error('Input filenames must be unique');
  const filesByName = new Map(files.map((file) => [String(file.name), file]));
  const manifestFiles = files.filter((file) => String(file.name).toLowerCase().endsWith('.json'));
  const referencedJsonl = new Set();
  const sources = manifestFiles.map((file) => {
    const source = parseAnnotationSetManifest(file, filesByName, taxonomy);
    if (referencedJsonl.has(source.name)) {
      throw new Error(`${source.name}: annotations payload is declared by more than one manifest`);
    }
    referencedJsonl.add(source.name);
    return source;
  });
  for (const file of files.filter((item) => String(item.name).toLowerCase().endsWith('.jsonl'))) {
    if (referencedJsonl.has(file.name)) continue;
    const sha256 = hashText(String(file.content ?? ''));
    sources.push({
      name: String(file.name),
      manifestName: null,
      annotationSetId: String(file.annotationSetId ?? '').trim() || `annotation-set-${sha256.slice(0, 16)}`,
      annotatorId: null,
      sha256,
      documents: parseCanonicalJsonl(String(file.name), file.content, taxonomy),
    });
  }
  const unsupported = files.filter((file) => !/\.jsonl?$/i.test(String(file.name)));
  if (unsupported.length > 0) throw new Error(`Unsupported input file: ${unsupported[0].name}`);
  if (sources.length < 2) throw new Error('Choose at least two completed annotation sets');
  const ids = sources.map((source) => source.annotationSetId);
  if (new Set(ids).size !== ids.length) throw new Error('annotation_set_id values must be unique');
  return sources;
}

export function createMergeProject(files, taxonomy) {
  const sources = prepareAnnotationSources(files, taxonomy);
  const documentIds = assertMatchingDocuments(sources);
  const datasetRevision = hashText(JSON.stringify(documentIds.map((documentId) => [
    documentId,
    hashText(sources[0].documents.get(documentId).text),
  ])));
  const datasetId = String(files[0]?.datasetId ?? '').trim() || `dataset-${datasetRevision.slice(0, 16)}`;
  const documents = documentIds.map((documentId) => {
    const first = sources[0].documents.get(documentId);
    const votes = new Map();
    for (const source of sources) {
      for (const span of source.documents.get(documentId).spans) {
        const key = spanKey(span);
        if (!votes.has(key)) votes.set(key, { span, presentIn: [] });
        votes.get(key).presentIn.push(source.annotationSetId);
      }
    }
    const consensusSpans = [];
    const disputedCandidates = [];
    for (const vote of votes.values()) {
      if (vote.presentIn.length === sources.length) {
        consensusSpans.push({
          ...vote.span,
          confirmed: true,
          consensus_span_id: consensusSpanIdentity(documentId, vote.span),
        });
      } else {
        disputedCandidates.push({
          span: vote.span,
          presentIn: vote.presentIn,
        });
      }
    }
    const disagreements = groupCandidates(disputedCandidates).map((group) => {
      const identity = [documentId, ...group.map((item) => spanKey(item.span))];
      const disagreementId = stableId('disagreement', identity);
      return {
        disagreement_id: disagreementId,
        begin: Math.min(...group.map((item) => item.span.begin)),
        end: Math.max(...group.map((item) => item.span.end)),
        status: 'pending',
        decision: null,
        candidates: group.map((item) => ({
          candidate_id: stableId('candidate', [disagreementId, spanKey(item.span)]),
          span: { ...item.span },
          present_in: [...item.presentIn],
          missing_from: sources.map((source) => source.annotationSetId).filter((identity) => !item.presentIn.includes(identity)),
        })),
      };
    });
    return {
      document_id: documentId,
      text: first.text,
      metadata: { ...first.metadata },
      curation_status: 'unconfirmed',
      confirmed_at: null,
      confirmed_by: null,
      consensus_spans: consensusSpans.sort(compareSpans),
      consensus_span_overrides: [],
      curator_spans: [],
      disagreements,
    };
  });
  return {
    project_version: 'meddeid.curation-project.v1',
    project_id: stableId('project', sources.map((source) => [source.annotationSetId, source.sha256])),
    created_at: new Date().toISOString(),
    contracts: {
      schema_version: 'meddeid.schema.v1',
      offset_unit: 'unicode_codepoints',
      taxonomy_contract_version: taxonomy.contract_version,
      taxonomy_version: taxonomy.taxonomy_version,
    },
    dataset: {
      dataset_id: datasetId,
      dataset_revision: datasetRevision,
      offset_unit: 'unicode_codepoints',
    },
    decision_events: [],
    sources: sources.map((source) => ({
      filename: source.name,
      manifest_filename: source.manifestName,
      annotation_set_id: source.annotationSetId,
      annotator_id: source.annotatorId,
      sha256: source.sha256,
      documents: source.documents.size,
      spans: [...source.documents.values()].reduce((sum, doc) => sum + doc.spans.length, 0),
    })),
    documents,
  };
}

export function finalSpansForDocument(document) {
  const overrides = new Map((document.consensus_span_overrides ?? []).map((override) => [
    override.consensus_span_id,
    override,
  ]));
  const spans = document.consensus_spans.flatMap((span) => {
    const consensusSpanId = span.consensus_span_id ?? consensusSpanIdentity(document.document_id, span);
    const override = overrides.get(consensusSpanId);
    if (override?.action === 'delete') return [];
    if (override?.action === 'update') {
      return [{
        ...override.span,
        confirmed: true,
        consensus_span_id: consensusSpanId,
        consensus_override: true,
      }];
    }
    return [{ ...span, consensus_span_id: consensusSpanId }];
  });
  for (const disagreement of document.disagreements) {
    if (disagreement.decision?.type === 'custom_spans') {
      spans.push(...disagreement.decision.spans.map((span) => ({ ...span, confirmed: true })));
      continue;
    }
    if (disagreement.decision?.type !== 'accept_candidate') continue;
    const candidate = disagreement.candidates.find(
      (item) => item.candidate_id === disagreement.decision.candidate_id,
    );
    if (candidate) spans.push({ ...candidate.span, confirmed: true });
  }
  spans.push(...(document.curator_spans ?? []).map((span) => ({ ...span, confirmed: true })));
  return spans.sort(compareSpans);
}

export function projectStats(project) {
  if (!project) return { documents: 0, confirmedDocuments: 0, consensusSpans: 0, disagreements: 0, resolved: 0, pending: 0 };
  const disagreements = project.documents.flatMap((doc) => doc.disagreements);
  return {
    documents: project.documents.length,
    confirmedDocuments: project.documents.filter((doc) => doc.curation_status === 'confirmed').length,
    consensusSpans: project.documents.reduce((sum, doc) => sum + doc.consensus_spans.length, 0),
    disagreements: disagreements.length,
    resolved: disagreements.filter((item) => item.status === 'resolved').length,
    pending: disagreements.filter((item) => item.status !== 'resolved').length,
  };
}

export function serializeProject(project, publishedGold = null) {
  if (!project) return { project: null, stats: projectStats(null), publishedGold };
  return {
    project: {
      ...project,
      documents: project.documents.map((doc) => ({ ...doc, spans: finalSpansForDocument(doc) })),
    },
    stats: projectStats(project),
    publishedGold,
  };
}
