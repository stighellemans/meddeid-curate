import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { isAppleDevice, shortcutModifier } from './platform-shortcuts.js';
import { buildTextParts, textPartSnippet, textPartTone } from './text-parts.js';

const API_ROOT = '/api';

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function labelColor(label) {
  const hue = (hashString(String(label ?? '')) * 47) % 360;
  return `hsl(${hue} 74% 88%)`;
}

function UndoIcon() {
  return (
    <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </svg>
  );
}

async function api(path, options = {}) {
  const response = await fetch(`${API_ROOT}${path}`, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.detail ?? payload?.error ?? response.statusText);
  return payload;
}

function splitCanonicalLabel(label) {
  const [category = '', subtype = ''] = String(label ?? '').split(':', 2);
  return { category, subtype };
}

function composeCanonicalLabel(category, subtype, taxonomy) {
  const allowed = taxonomy?.subtypes_by_category?.[category] ?? [];
  return allowed.length > 0 ? `${category}:${subtype || allowed[0]}` : category;
}

function decisionLabel(disagreement, project) {
  if (!disagreement.decision) return 'Unresolved';
  if (disagreement.decision.type === 'reject_all') return 'No span retained';
  if (disagreement.decision.type === 'custom_spans') {
    return `${disagreement.decision.spans.length} custom curated span${disagreement.decision.spans.length === 1 ? '' : 's'}`;
  }
  const candidate = disagreement.candidates.find(
    (item) => item.candidate_id === disagreement.decision.candidate_id,
  );
  return candidate ? `${candidate.span.label} · ${candidate.span.text}` : 'Candidate retained';
}

function disagreementTone(disagreement) {
  if (disagreement.status !== 'resolved') return 'pending';
  if (disagreement.decision?.type === 'reject_all') return 'removed';
  if (disagreement.decision?.type === 'custom_spans') return 'custom';
  return 'included';
}

function disagreementSnippet(text, disagreement) {
  const chars = Array.from(text);
  const begin = Math.max(0, disagreement.begin - 12);
  const end = Math.min(chars.length, disagreement.end + 12);
  return `${begin > 0 ? '…' : ''}${chars.slice(begin, end).join('')}${end < chars.length ? '…' : ''}`;
}

function TextComparison({ document, disagreement }) {
  const chars = Array.from(document.text);
  const ranges = [
    ...document.consensus_spans.map((span) => ({ ...span, kind: 'consensus' })),
    ...(disagreement?.candidates ?? []).map((candidate) => ({ ...candidate.span, kind: 'conflict' })),
  ];
  const boundaries = [...new Set([0, chars.length, ...ranges.flatMap((range) => [range.begin, range.end])])]
    .filter((value) => value >= 0 && value <= chars.length)
    .sort((left, right) => left - right);
  return (
    <div className="document-text" aria-label="Immutable document text">
      {boundaries.slice(0, -1).map((begin, index) => {
        const end = boundaries[index + 1];
        const covering = ranges.filter((range) => range.begin < end && begin < range.end);
        const kind = covering.some((range) => range.kind === 'conflict')
          ? 'conflict'
          : covering.some((range) => range.kind === 'consensus')
            ? 'consensus'
            : 'plain';
        return (
          <span key={`${begin}-${end}`} className={`text-segment ${kind}`}>
            {chars.slice(begin, end).join('')}
          </span>
        );
      })}
    </div>
  );
}

function SegmentedText({ text, ranges, windowRange, label, onCandidate, onEditableSpan, textRef, onTextSelection }) {
  const chars = Array.from(text);
  const windowBegin = windowRange?.begin ?? 0;
  const windowEnd = windowRange?.end ?? chars.length;
  const visibleRanges = ranges.filter((range) => range.begin < windowEnd && windowBegin < range.end);
  const boundaries = [...new Set([windowBegin, windowEnd, ...visibleRanges.flatMap((range) => [
    Math.max(windowBegin, range.begin),
    Math.min(windowEnd, range.end),
  ])])]
    .filter((value) => value >= windowBegin && value <= windowEnd)
    .sort((left, right) => left - right);
  return (
    <div className="lane-text" aria-label={label} ref={textRef} onMouseUp={onTextSelection} data-window-begin={windowBegin} data-window-end={windowEnd}>
      {boundaries.slice(0, -1).map((begin, index) => {
        const end = boundaries[index + 1];
        const covering = visibleRanges
          .filter((range) => range.begin < end && begin < range.end)
          .sort((left, right) => Number(Boolean(right.current)) - Number(Boolean(left.current)));
        const range = covering[0];
        const content = chars.slice(begin, end).join('');
        if (!range) return <span key={`${begin}-${end}`}>{content}</span>;
        if (range.candidateId || (range.current && range.editableAction)) {
          return (
            <button
              className={`lane-segment ${range.state}`}
              key={`${begin}-${end}-${range.candidateId ?? `editable-${range.editableAction.kind}-${range.editableAction.curatorSpanId ?? range.editableAction.consensusSpanId ?? range.editableAction.disagreementId}-${range.editableAction.spanIndex ?? 0}`}`}
              onClick={() => range.candidateId ? onCandidate?.(range.candidateId, range.disagreementId) : onEditableSpan?.(range.editableAction)}
              title={range.candidateId ? `${range.label} · click to merge into curated result` : `${range.label} · click to edit curated span`}
              data-label={range.label}
              style={{ '--label-color': labelColor(range.label) }}
            >
              {content}
            </button>
          );
        }
        return <mark className={`lane-segment ${range.state}`} data-label={range.label} style={{ '--label-color': labelColor(range.label) }} key={`${begin}-${end}-${range.label}`}>{content}</mark>;
      })}
    </div>
  );
}

function CuratedPane({ document, disagreement, windowRange, textRef, onTextSelection, onEditSpan }) {
  const editableOutcomes = document.disagreements.flatMap((item) => {
    const spans = item.decision?.type === 'custom_spans'
      ? item.decision.spans
      : item.decision?.type === 'accept_candidate'
        ? item.candidates.filter((candidate) => candidate.candidate_id === item.decision.candidate_id).map((candidate) => candidate.span)
        : [];
    return spans.map((span, spanIndex) => ({
      span,
      spanIndex,
      disagreementId: item.disagreement_id,
      custom: item.decision?.type === 'custom_spans',
    }));
  });
  const ranges = (document.spans ?? []).map((span) => {
    const directSpan = span.curator_span_id
      ? (document.curator_spans ?? []).find((item) => item.curator_span_id === span.curator_span_id)
      : null;
    const outcome = editableOutcomes.find((item) => item.span.begin === span.begin && item.span.end === span.end && item.span.label === span.label);
    const consensusSpanId = span.consensus_span_id ?? null;
    return {
      ...span,
      state: directSpan || outcome?.custom || span.consensus_override ? 'curator-authored' : 'curated',
      current: Boolean(directSpan || outcome || consensusSpanId),
      editableAction: directSpan
        ? { kind: 'curator', curatorSpanId: directSpan.curator_span_id }
        : outcome
          ? { kind: 'disagreement', disagreementId: outcome.disagreementId, spanIndex: outcome.spanIndex }
          : consensusSpanId
            ? { kind: 'consensus', consensusSpanId }
            : null,
    };
  });
  return (
    <section className="curated-pane">
      <div className="lane-heading">
        <div><span className="lane-avatar curator-avatar">C</span><span><strong>Curated result</strong><small>Final primary-gold working copy</small></span></div>
        <em>{document.spans?.length ?? 0} spans</em>
      </div>
      <SegmentedText
        text={document.text}
        ranges={ranges}
        windowRange={windowRange}
        label="Curated document text"
        textRef={textRef}
        onTextSelection={onTextSelection}
        onEditableSpan={onEditSpan}
      />
    </section>
  );
}

function AnnotationLane({ document, source, sourceIndex, disagreement, windowRange, onCandidate }) {
  const ranges = document.consensus_spans.map((span) => ({ ...span, state: 'agreed', label: span.label }));
  for (const item of document.disagreements) {
    for (const candidate of item.candidates) {
      if (!candidate.present_in.includes(source.annotation_set_id)) continue;
      let state = item.status === 'pending' ? 'disagreed' : 'rejected';
      if (item.decision?.type === 'accept_candidate' && item.decision.candidate_id === candidate.candidate_id) state = 'accepted';
      if (item.decision?.type === 'custom_spans') state = 'rejected';
      ranges.push({
        ...candidate.span,
        state,
        label: candidate.span.label,
        candidateId: candidate.candidate_id,
        disagreementId: item.disagreement_id,
        current: item.disagreement_id === disagreement?.disagreement_id,
      });
    }
  }
  const hasCurrentCandidate = disagreement?.candidates.some((candidate) => (
    candidate.present_in.includes(source.annotation_set_id)
  ));
  const visibleCandidateCount = ranges.filter((range) => (
    range.candidateId && range.begin < (windowRange?.end ?? document.text.length) && (windowRange?.begin ?? 0) < range.end
  )).length;
  return (
    <section className={`annotator-lane ${hasCurrentCandidate ? 'has-current' : ''}`}>
      <div className="lane-heading">
        <div>
          <span className="lane-avatar">{String.fromCharCode(65 + sourceIndex)}</span>
          <span><strong>{source.annotator_id ?? source.filename}</strong><small>{source.annotation_set_id}</small></span>
        </div>
        <em>{visibleCandidateCount > 0 ? `${visibleCandidateCount} clickable alternative${visibleCandidateCount === 1 ? '' : 's'}` : 'No difference in this part'}</em>
      </div>
      <SegmentedText
        text={document.text}
        ranges={ranges}
        windowRange={windowRange}
        label={`Read-only annotations from ${source.filename}`}
        onCandidate={onCandidate}
      />
    </section>
  );
}

function ImportScreen({ onImported, existingProject }) {
  const [files, setFiles] = React.useState([]);
  const [curatorId, setCuratorId] = React.useState(() => localStorage.getItem('meddeid.curatorId') ?? 'curator-01');
  const [dragging, setDragging] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const annotationFileCount = files.filter((file) => file.name.toLowerCase().endsWith('.jsonl')).length;

  function chooseFiles(fileList) {
    setFiles([...fileList].filter((file) => /\.jsonl?$/i.test(file.name)));
    setError('');
  }

  async function importFiles() {
    if (annotationFileCount < 2) {
      setError('Choose at least two completed annotation JSONL files, with their manifests when available.');
      return;
    }
    if (!curatorId.trim()) {
      setError('Enter a pseudonymous curator ID for the audit trail.');
      return;
    }
    if (existingProject && !window.confirm('Replace the current working curation project with these files?')) return;
    setBusy(true);
    setError('');
    try {
      localStorage.setItem('meddeid.curatorId', curatorId.trim());
      const uploadFiles = await Promise.all(files.map(async (file) => ({
        name: file.name,
        content: await file.text(),
      })));
      onImported(await api('/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ curatorId: curatorId.trim(), files: uploadFiles }),
      }));
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="import-page">
      <section className="import-intro">
        <span className="eyebrow">Independent annotation reconciliation</span>
        <h1>Build one defensible gold standard.</h1>
        <p>
          Compare two or more completed canonical annotation files. Exact agreement is retained automatically;
          overlapping differences become explicit review decisions with a durable audit trail.
        </p>
        <div className="principles">
          <span>Immutable text</span><span>Unicode code-point offsets</span><span>Append-only decisions</span>
        </div>
      </section>
      <section className="import-card">
        <div className="step-label">01 · Identify curator</div>
        <label className="field">
          <span>Pseudonymous curator ID</span>
          <input value={curatorId} onChange={(event) => setCuratorId(event.target.value)} placeholder="curator-01" />
        </label>
        <div className="step-label">02 · Add completed annotation sets</div>
        <label
          className={`drop-zone ${dragging ? 'dragging' : ''}`}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); chooseFiles(event.dataTransfer.files); }}
        >
          <input type="file" accept=".json,.jsonl,application/json" multiple onChange={(event) => chooseFiles(event.target.files)} />
          <strong>Drop annotation sets here</strong>
          <span>JSONL plus optional package manifests · at least two sets</span>
        </label>
        {files.length > 0 && (
          <div className="file-list">
            {files.map((file, index) => (
              <div className="file-row" key={`${file.name}-${file.size}`}>
                <span className="file-index">{String(index + 1).padStart(2, '0')}</span>
                <strong>{file.name}</strong>
                <span>{Math.max(1, Math.round(file.size / 1024))} KB</span>
              </div>
            ))}
          </div>
        )}
        {error && <div className="error-message" role="alert">{error}</div>}
        <button className="primary-button import-button" onClick={importFiles} disabled={busy || annotationFileCount < 2}>
          {busy ? 'Validating and comparing…' : `Compare ${annotationFileCount || ''} annotation sets`}
        </button>
        <p className="privacy-note">Files are processed by the localhost application and are never uploaded externally.</p>
      </section>
    </main>
  );
}

function CurateWorkspace({ payload, setPayload, onNewProject }) {
  const { project, stats, publishedGold, taxonomy } = payload;
  const [filter, setFilter] = React.useState('pending');
  const [selectedDocId, setSelectedDocId] = React.useState(() =>
    project.documents.find((doc) => doc.curation_status !== 'confirmed')?.document_id
      ?? project.documents[0]?.document_id,
  );
  const [selectedDisagreementId, setSelectedDisagreementId] = React.useState(null);
  const [selectedPartIndex, setSelectedPartIndex] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [customSpans, setCustomSpans] = React.useState([]);
  const [selectedCustomIndex, setSelectedCustomIndex] = React.useState(-1);
  const [selectedCuratorSpanId, setSelectedCuratorSpanId] = React.useState(null);
  const [selectedConsensusSpanId, setSelectedConsensusSpanId] = React.useState(null);
  const curatedTextRef = React.useRef(null);

  const visibleDocuments = project.documents.filter((doc) => {
    if (filter === 'all') return true;
    const confirmed = doc.curation_status === 'confirmed';
    return filter === 'pending' ? !confirmed : confirmed;
  });
  const selectedDocument = project.documents.find((doc) => doc.document_id === selectedDocId)
    ?? visibleDocuments[0]
    ?? project.documents[0];
  const textParts = React.useMemo(
    () => buildTextParts(
      selectedDocument?.text ?? '',
      selectedDocument?.disagreements ?? [],
      560,
      selectedDocument?.curator_spans ?? [],
    ),
    [selectedDocument],
  );
  const focusedPart = textParts[Math.min(selectedPartIndex, textParts.length - 1)] ?? textParts[0];
  const focusedDisagreements = focusedPart?.disagreements ?? [];
  const selectedDisagreement = focusedDisagreements.find(
    (item) => item.disagreement_id === selectedDisagreementId,
  ) ?? focusedDisagreements.find((item) => item.status !== 'resolved')
    ?? focusedDisagreements[0]
    ?? null;

  React.useEffect(() => {
    if (selectedDocument && selectedDocument.document_id !== selectedDocId) setSelectedDocId(selectedDocument.document_id);
  }, [selectedDocument, selectedDocId]);

  React.useEffect(() => {
    setCustomSpans([]);
    setSelectedCustomIndex(-1);
    setSelectedCuratorSpanId(null);
    setSelectedConsensusSpanId(null);
    const firstProblemPart = textParts.findIndex((part) => part.disagreements.some((item) => item.status !== 'resolved'));
    setSelectedPartIndex(firstProblemPart >= 0 ? firstProblemPart : 0);
  }, [selectedDocument?.document_id]);

  function navigateToDisagreement(disagreementId) {
    setCustomSpans([]);
    setSelectedCustomIndex(-1);
    setSelectedCuratorSpanId(null);
    setSelectedConsensusSpanId(null);
    setSelectedDisagreementId(disagreementId);
    const partIndex = textParts.findIndex((part) => part.disagreements.some((item) => item.disagreement_id === disagreementId));
    if (partIndex >= 0) setSelectedPartIndex(partIndex);
    setMessage('');
  }

  function navigateToPart(partIndex) {
    const part = textParts[partIndex];
    setSelectedPartIndex(partIndex);
    setSelectedDisagreementId(
      part?.disagreements.find((item) => item.status !== 'resolved')?.disagreement_id
        ?? part?.disagreements[0]?.disagreement_id
        ?? null,
    );
    setCustomSpans([]);
    setSelectedCustomIndex(-1);
    setSelectedCuratorSpanId(null);
    setSelectedConsensusSpanId(null);
    setMessage('');
  }

  function navigateToDocument(offset) {
    if (!selectedDocument || visibleDocuments.length === 0) return;
    const currentIndex = visibleDocuments.findIndex((doc) => doc.document_id === selectedDocument.document_id);
    const nextIndex = Math.max(0, Math.min(visibleDocuments.length - 1, currentIndex + offset));
    const nextDocument = visibleDocuments[nextIndex];
    if (!nextDocument || nextDocument.document_id === selectedDocument.document_id) return;
    setSelectedDocId(nextDocument.document_id);
    setSelectedDisagreementId(null);
    setMessage('');
  }

  React.useEffect(() => {
    function handleNavigationShortcut(event) {
      const target = event.target;
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const nextPartIndex = Math.max(0, Math.min(textParts.length - 1, selectedPartIndex + (event.key === 'ArrowRight' ? 1 : -1)));
        if (nextPartIndex !== selectedPartIndex) navigateToPart(nextPartIndex);
        return;
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        navigateToDocument(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (/^[1-9]$/.test(event.key)) {
        const partIndex = Number(event.key) - 1;
        if (partIndex >= textParts.length) return;
        event.preventDefault();
        navigateToPart(partIndex);
      }
    }
    window.addEventListener('keydown', handleNavigationShortcut);
    return () => window.removeEventListener('keydown', handleNavigationShortcut);
  }, [selectedDocument?.document_id, selectedPartIndex, textParts.length, visibleDocuments]);

  async function decide(decision, candidateId = null, spans = null, targetDisagreement = selectedDisagreement) {
    if (!selectedDocument || !targetDisagreement) return;
    setBusy(true);
    setMessage('');
    try {
      const next = await api(
        `/documents/${encodeURIComponent(selectedDocument.document_id)}/disagreements/${encodeURIComponent(targetDisagreement.disagreement_id)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision, candidateId, spans, curatorId: project.curator.curator_id }),
        },
      );
      setPayload(next);
      // Curation is deliberately non-linear: keep the curator on the same
      // document and disagreement after every decision until they navigate.
      setSelectedDocId(selectedDocument.document_id);
      setSelectedDisagreementId(targetDisagreement.disagreement_id);
      setMessage(
        decision === 'accept_candidate'
          ? 'Candidate retained.'
          : decision === 'reject_all'
            ? 'No span retained.'
            : decision === 'custom_spans'
              ? 'Custom curated resolution saved.'
              : 'Decision reopened.',
      );
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  function editCuratedSpan({ kind, curatorSpanId, consensusSpanId, disagreementId, spanIndex = 0 }) {
    if (kind === 'curator') {
      const span = selectedDocument?.curator_spans?.find((item) => item.curator_span_id === curatorSpanId);
      if (!span) return;
      setSelectedCuratorSpanId(curatorSpanId);
      setSelectedConsensusSpanId(null);
      setCustomSpans([]);
      setSelectedCustomIndex(-1);
      setMessage('');
      return;
    }
    if (kind === 'consensus') {
      const span = selectedDocument?.spans?.find((item) => item.consensus_span_id === consensusSpanId);
      if (!span) return;
      setSelectedCuratorSpanId(null);
      setSelectedConsensusSpanId(consensusSpanId);
      setCustomSpans([]);
      setSelectedCustomIndex(-1);
      setMessage('');
      return;
    }
    const disagreement = selectedDocument?.disagreements.find((item) => item.disagreement_id === disagreementId);
    if (!disagreement) return;
    const prior = disagreement.decision?.type === 'custom_spans'
      ? disagreement.decision.spans
      : disagreement.decision?.type === 'accept_candidate'
        ? disagreement.candidates
            .filter((candidate) => candidate.candidate_id === disagreement.decision.candidate_id)
            .map((candidate) => candidate.span)
        : [];
    const nextSpans = prior.map((span) => ({ begin: span.begin, end: span.end, label: span.label }));
    if (!nextSpans.length) return;
    setSelectedCuratorSpanId(null);
    setSelectedConsensusSpanId(null);
    setSelectedDisagreementId(disagreementId);
    setCustomSpans(nextSpans);
    setSelectedCustomIndex(Math.max(0, Math.min(spanIndex, nextSpans.length - 1)));
    setMessage('');
  }

  async function mutateCuratorSpan(
    action,
    span = null,
    curatorSpanId = selectedCuratorSpanId,
    consensusSpanId = selectedConsensusSpanId,
  ) {
    if (!selectedDocument) return null;
    setBusy(true);
    setMessage('');
    try {
      const next = await api(`/documents/${encodeURIComponent(selectedDocument.document_id)}/curator-spans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, curatorSpanId, consensusSpanId, span, curatorId: project.curator.curator_id }),
      });
      setPayload(next);
      const nextDocument = next.project.documents.find((item) => item.document_id === selectedDocument.document_id);
      if (action === 'delete') {
        setSelectedCuratorSpanId(null);
        setSelectedConsensusSpanId(null);
      } else if (action === 'add') {
        const added = nextDocument?.curator_spans?.find((item) => (
          item.begin === span.begin && item.end === span.end && item.label === span.label
        ));
        setSelectedCuratorSpanId(added?.curator_span_id ?? null);
        setSelectedConsensusSpanId(null);
      }
      setMessage(action === 'delete' ? 'Curator span deleted.' : 'Curator span saved automatically.');
      return next;
    } catch (error) {
      setMessage(error.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function updateSelectedCustomLabel(category, subtype = '') {
    if (!selectedCustomSpan) return;
    const label = composeCanonicalLabel(category, subtype, taxonomy);
    if (selectedCuratorSpanId) {
      await mutateCuratorSpan('update', { ...selectedCustomSpan, label }, selectedCuratorSpanId);
      return;
    }
    if (selectedConsensusSpanId) {
      await mutateCuratorSpan('update', { ...selectedCustomSpan, label }, null, selectedConsensusSpanId);
      return;
    }
    const nextSpans = customSpans.map((span, index) => (
      index === selectedCustomIndex ? { ...span, label } : span
    ));
    setCustomSpans(nextSpans);
    await decide('custom_spans', null, nextSpans);
  }

  async function removeSelectedCuratedSpan() {
    if (selectedCuratorSpanId) {
      await mutateCuratorSpan('delete', null, selectedCuratorSpanId);
      return;
    }
    if (selectedConsensusSpanId) {
      await mutateCuratorSpan('delete', null, null, selectedConsensusSpanId);
      return;
    }
    if (selectedCustomIndex < 0) return;
    if (customSpans.length <= 1) {
      await decide('reject_all');
      setCustomSpans([]);
      setSelectedCustomIndex(-1);
      return;
    }
    const nextSpans = customSpans.filter((_span, index) => index !== selectedCustomIndex);
    setCustomSpans(nextSpans);
    setSelectedCustomIndex(Math.max(0, selectedCustomIndex - 1));
    await decide('custom_spans', null, nextSpans);
  }

  async function handleCuratedTextSelection() {
    const container = curatedTextRef.current;
    const selection = window.getSelection();
    if (!container || !selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return;
    try {
      const beforeStart = document.createRange();
      beforeStart.selectNodeContents(container);
      beforeStart.setEnd(range.startContainer, range.startOffset);
      const beforeEnd = document.createRange();
      beforeEnd.selectNodeContents(container);
      beforeEnd.setEnd(range.endContainer, range.endOffset);
      const begin = (focusedPart?.begin ?? 0) + Array.from(beforeStart.toString()).length;
      const end = (focusedPart?.begin ?? 0) + Array.from(beforeEnd.toString()).length;
      if (begin >= end) return;
      const fallbackLabel = selectedCustomSpan?.label
        ?? selectedDisagreement?.candidates[0]?.span.label
        ?? (taxonomy?.entity_labels?.includes('Name:Patient') ? 'Name:Patient' : null)
        ?? taxonomy?.entity_labels?.[0]
        ?? '';
      const nextSpan = { begin, end, label: fallbackLabel };
      const insideSelectedDisagreement = selectedDisagreement
        && begin >= selectedDisagreement.begin
        && end <= selectedDisagreement.end;
      if (insideSelectedDisagreement) {
        let nextSpans = [...customSpans];
        const selectedSpan = selectedCustomIndex >= 0 ? nextSpans[selectedCustomIndex] : null;
        const overlapsSelected = selectedSpan
          && Math.max(selectedSpan.begin, begin) < Math.min(selectedSpan.end, end);
        if (selectedSpan && overlapsSelected) {
          nextSpans[selectedCustomIndex] = nextSpan;
        } else {
          nextSpans.push(nextSpan);
          setSelectedCustomIndex(nextSpans.length - 1);
        }
        setSelectedCuratorSpanId(null);
        setSelectedConsensusSpanId(null);
        setCustomSpans(nextSpans);
        await decide('custom_spans', null, nextSpans);
      } else if (selectedCuratorSpanId && selectedCustomSpan
        && Math.max(selectedCustomSpan.begin, begin) < Math.min(selectedCustomSpan.end, end)) {
        await mutateCuratorSpan('update', nextSpan, selectedCuratorSpanId);
      } else if (selectedConsensusSpanId && selectedCustomSpan
        && Math.max(selectedCustomSpan.begin, begin) < Math.min(selectedCustomSpan.end, end)) {
        await mutateCuratorSpan('update', nextSpan, null, selectedConsensusSpanId);
      } else {
        setCustomSpans([]);
        setSelectedCustomIndex(-1);
        setSelectedConsensusSpanId(null);
        await mutateCuratorSpan('add', nextSpan, null, null);
      }
    } finally {
      selection.removeAllRanges();
    }
  }

  async function finalize() {
    setBusy(true);
    setMessage('');
    try {
      const result = await api('/finalize', { method: 'POST' });
      const next = await api('/bootstrap');
      setPayload(next);
      setMessage(result.reused ? 'Published gold is already current.' : 'Published current gold.');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmSelectedDocument() {
    if (!selectedDocument) return;
    const confirmedDocumentId = selectedDocument.document_id;
    const currentDocumentIndex = project.documents.findIndex((doc) => doc.document_id === confirmedDocumentId);
    const documentsAfterCurrent = [
      ...project.documents.slice(currentDocumentIndex + 1),
      ...project.documents.slice(0, currentDocumentIndex),
    ];
    const nextDocument = documentsAfterCurrent.find((doc) => (
      filter === 'all' || (filter === 'pending' ? doc.curation_status !== 'confirmed' : doc.curation_status === 'confirmed')
    ));
    setBusy(true);
    setMessage('');
    try {
      const next = await api(`/documents/${encodeURIComponent(confirmedDocumentId)}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ curatorId: project.curator.curator_id }),
      });
      setPayload(next);
      setSelectedDocId(nextDocument?.document_id ?? confirmedDocumentId);
      setSelectedDisagreementId(null);
      setMessage(`Confirmed the complete curated text for ${confirmedDocumentId}.`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function moveHistory(direction) {
    setBusy(true);
    setMessage('');
    try {
      const next = await api(`/history/${direction}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ curatorId: project.curator.curator_id }),
      });
      setPayload(next);
      if (next.historyDocumentId) setSelectedDocId(next.historyDocumentId);
      setSelectedDisagreementId(null);
      setCustomSpans([]);
      setSelectedCustomIndex(-1);
      setSelectedCuratorSpanId(null);
      setSelectedConsensusSpanId(null);
      setMessage(direction === 'undo' ? 'Undid the last curation change.' : 'Redid the last curation change.');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  const selectedIndex = selectedDocument?.disagreements.findIndex(
    (item) => item.disagreement_id === selectedDisagreement?.disagreement_id,
  ) ?? -1;
  const selectedCustomSpan = selectedCuratorSpanId
    ? selectedDocument?.curator_spans?.find((span) => span.curator_span_id === selectedCuratorSpanId) ?? null
    : selectedConsensusSpanId
      ? selectedDocument?.spans?.find((span) => span.consensus_span_id === selectedConsensusSpanId) ?? null
      : selectedCustomIndex >= 0
        ? customSpans[selectedCustomIndex] ?? null
        : null;
  const selectedCustomLabel = splitCanonicalLabel(selectedCustomSpan?.label);
  const selectedAllowedSubtypes = taxonomy?.subtypes_by_category?.[selectedCustomLabel.category] ?? [];
  const categoryKeys = { Name: 'N', Address_Location: 'A', Organization: 'O', ID: 'I', Age_Birthdate: 'L', Contactdetails: 'C', Date: 'D', Profession: 'B', Anonymize_Other: 'X' };
  const subtypeKeys = { Patient: 'P', Caregiver: 'Z', Other: 'F', Healthcare: 'H' };
  const selectedPendingCount = selectedDocument?.disagreements.filter((item) => item.status !== 'resolved').length ?? 0;
  const appleDevice = isAppleDevice();
  const modifier = shortcutModifier();
  const undoShortcut = `${modifier}Z`;
  const redoShortcut = appleDevice ? '⇧⌘Z' : 'Ctrl+Y';
  const confirmShortcut = `${modifier}Enter`;
  const deleteShortcut = `${modifier}Delete`;

  React.useEffect(() => {
    function handleWorkspaceShortcut(event) {
      const target = event.target;
      const typing = target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      const modifier = event.metaKey || event.ctrlKey;
      const token = event.key.toLowerCase();
      if (!modifier || event.altKey || typing || event.repeat) return;
      if (token === 'z') {
        event.preventDefault();
        void moveHistory(event.shiftKey ? 'redo' : 'undo');
        return;
      }
      if (token === 'y') {
        event.preventDefault();
        void moveHistory('redo');
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedCustomSpan) {
        event.preventDefault();
        void removeSelectedCuratedSpan();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (selectedDocument?.curation_status === 'confirmed') {
          setMessage('This text is already confirmed.');
        } else {
          void confirmSelectedDocument();
        }
      }
    }
    window.addEventListener('keydown', handleWorkspaceShortcut);
    return () => window.removeEventListener('keydown', handleWorkspaceShortcut);
  }, [payload.history?.canUndo, payload.history?.canRedo, selectedDocument?.document_id, selectedDocument?.curation_status, selectedCustomSpan, selectedPendingCount, busy]);

  return (
    <div className="workspace">
      <header className="topbar">
        <div className="brand"><div><strong>Curation Console</strong><small>{project.dataset.dataset_id} · {project.sources.length} annotation sets</small></div></div>
        <div className="progress-summary" aria-label={`${stats.confirmedDocuments} of ${stats.documents} texts confirmed`}>
          <div className="progress-copy"><strong>{stats.confirmedDocuments}/{stats.documents} texts confirmed</strong><span>{stats.documents ? Math.round((stats.confirmedDocuments / stats.documents) * 100) : 100}%</span></div>
          <div className="progress-track"><div className="progress-fill" style={{ width: `${stats.documents ? (stats.confirmedDocuments / stats.documents) * 100 : 100}%` }} /></div>
        </div>
        <div className="top-actions">
          <button className="secondary-button" onClick={onNewProject}>New comparison</button>
          <button className="primary-button" onClick={finalize} disabled={busy || stats.pending > 0 || stats.confirmedDocuments < stats.documents}>Publish gold</button>
          {publishedGold && <a className="download-button" href="/api/export">Download gold</a>}
        </div>
      </header>
      <aside className="document-sidebar">
        <div className="sidebar-heading">
          <div><span className="eyebrow">Documents</span><strong>{stats.documents} records</strong></div>
          <div className="filter-tabs">
            {[
              ['pending', 'To review'],
              ['resolved', 'Confirmed'],
              ['all', 'All'],
            ].map(([value, label]) => (
              <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="document-rows">
          {visibleDocuments.map((doc) => {
            const pending = doc.disagreements.filter((item) => item.status !== 'resolved').length;
            const confirmed = doc.curation_status === 'confirmed';
            return (
              <button
                key={doc.document_id}
                className={`document-row ${selectedDocument?.document_id === doc.document_id ? 'active' : ''}`}
                onClick={() => { setSelectedDocId(doc.document_id); setSelectedDisagreementId(null); }}
              >
                <span><strong>{doc.document_id}</strong><small>{doc.consensus_spans.length} agreed · {doc.disagreements.length} conflicts</small></span>
                <em className={pending ? 'pending-badge' : confirmed ? 'done-badge' : 'ready-badge'}>{pending || (confirmed ? '✓' : '•')}</em>
              </button>
            );
          })}
          {visibleDocuments.length === 0 && <p className="empty-filter">No documents in this view.</p>}
        </div>
        <div className="source-legend">
          <span className="eyebrow">Compared sets</span>
          {project.sources.map((source, index) => (
            <div key={source.annotation_set_id}><i>{String.fromCharCode(65 + index)}</i><span><strong>{source.filename}</strong><small>{source.annotation_set_id}</small></span></div>
          ))}
        </div>
      </aside>
      <main className="review-main">
        <section className="document-panel">
          <div className="panel-heading">
            <div><span className="eyebrow">Document curation</span><h1>{selectedDocument?.document_id}</h1><p>{project.documents.findIndex((doc) => doc.document_id === selectedDocument?.document_id) + 1}/{project.documents.length} documents · part {selectedPartIndex + 1}/{textParts.length} · [{focusedPart?.begin ?? 0}, {focusedPart?.end ?? 0}) of {Array.from(selectedDocument?.text ?? '').length} code points</p></div>
            <div className="document-toolbar" aria-label="Document history and confirmation">
              <button type="button" className="toolbar-button" aria-label="Undo" onClick={() => moveHistory('undo')} disabled={busy || !payload.history?.canUndo} title={`Undo last curation change (${undoShortcut})`}><UndoIcon /></button>
              <button type="button" className="toolbar-button" aria-label="Redo" onClick={() => moveHistory('redo')} disabled={busy || !payload.history?.canRedo} title={`Redo last curation change (${redoShortcut})`}><RedoIcon /></button>
              <div className="confirm-toolbar-group">
                <button
                  type="button"
                  className="primary-button toolbar-confirm-button"
                  aria-label="Confirm text"
                  onClick={confirmSelectedDocument}
                  disabled={busy || selectedDocument?.curation_status === 'confirmed'}
                  title={`Confirm the current curated text (${confirmShortcut})${selectedPendingCount > 0 ? `; ${selectedPendingCount} untouched difference${selectedPendingCount === 1 ? '' : 's'} will remain absent` : ''}`}
                >{selectedDocument?.curation_status === 'confirmed' ? '✓ Confirmed' : 'Confirm text'}</button>
                <small>{selectedDocument?.curation_status === 'confirmed'
                  ? 'Whole text confirmed'
                  : selectedPendingCount > 0
                    ? `${selectedPendingCount} optional difference${selectedPendingCount === 1 ? '' : 's'}`
                    : 'Ready to confirm'}</small>
              </div>
            </div>
          </div>
          {selectedDocument && (
            <div className="stacked-editors">
              <CuratedPane
                document={selectedDocument}
                disagreement={selectedDisagreement}
                windowRange={focusedPart}
                textRef={curatedTextRef}
                onTextSelection={handleCuratedTextSelection}
                onEditSpan={editCuratedSpan}
              />
              <div className="annotator-lanes-heading"><span>Read-only annotator panes</span><small>Click a highlighted span in a source lane to merge it into the curated result.</small></div>
              {project.sources.map((source, index) => (
                <AnnotationLane
                  key={source.annotation_set_id}
                  document={selectedDocument}
                  source={source}
                  sourceIndex={index}
                  disagreement={selectedDisagreement}
                  windowRange={focusedPart}
                  onCandidate={(candidateId, disagreementId) => {
                    setSelectedCuratorSpanId(null);
                    setSelectedConsensusSpanId(null);
                    setCustomSpans([]);
                    setSelectedCustomIndex(-1);
                    void decide(
                      'accept_candidate',
                      candidateId,
                      null,
                      selectedDocument.disagreements.find((item) => item.disagreement_id === disagreementId),
                    );
                  }}
                />
              ))}
            </div>
          )}
        </section>
        <section className="decision-panel">
          {selectedDocument ? (
            <>
              <section className="review-map" aria-label="Document difference map">
                <div className="review-map-legend"><span><i className="clean" />No difference</span><span><i className="pending" />Difference</span><span><i className="included" />Included</span><span><i className="removed" />Absent</span><span><i className="custom" />Curator edit</span></div>
                <div className="review-unit-list">
                  {textParts.map((part, index) => {
                    const tone = textPartTone(part);
                    const pendingInPart = part.disagreements.filter((item) => item.status !== 'resolved').length;
                    const partNumber = index + 1;
                    const status = part.curatorSpans?.length
                      ? `${part.curatorSpans.length} curator annotation${part.curatorSpans.length === 1 ? '' : 's'}`
                      : part.disagreements.length === 0
                        ? 'No conflicts'
                        : pendingInPart
                          ? `${pendingInPart} optional difference${pendingInPart === 1 ? '' : 's'}`
                          : `${part.disagreements.length} decided`;
                    return (
                      <button
                        key={`${part.begin}-${part.end}`}
                        className={`review-unit ${tone} ${index === selectedPartIndex ? 'active' : ''}`}
                        onClick={() => navigateToPart(index)}
                        aria-label={`Part ${index + 1}: ${status}`}
                        title={`Part ${index + 1} · ${status}`}
                      >
                        <kbd>{partNumber}</kbd>
                      </button>
                    );
                  })}
                </div>
              </section>
              {selectedCustomSpan ? (
                <div className="selected-span-compact">
                  <strong>&quot;{Array.from(selectedDocument.text).slice(selectedCustomSpan.begin, selectedCustomSpan.end).join('')}&quot;</strong>
                  <span className="selected-span-label" style={{ backgroundColor: labelColor(selectedCustomSpan.label) }}>{selectedCustomSpan.label}</span>
                  <button className="delete-span-button" onClick={removeSelectedCuratedSpan} disabled={busy} title={`Delete selected span (${deleteShortcut})`}>Delete</button>
                </div>
              ) : (
                <div className="conflict-heading">
                  <div>
                    <span className="eyebrow">{selectedDisagreement ? `Issue ${selectedIndex + 1} · ` : ''}Text part {selectedPartIndex + 1}</span>
                    <h2>{selectedDisagreement
                      ? selectedDisagreement.status === 'resolved'
                        ? decisionLabel(selectedDisagreement, project)
                        : 'Choose the correct labeled span'
                      : 'Add a labeled span to the curated result'}</h2>
                    <p className="issue-instruction">Click a labeled source span to keep it. To correct or add one, select text in <strong>Curated result</strong>, then choose its category and subtype.</p>
                    <p className="issue-snippet">{selectedDisagreement
                      ? disagreementSnippet(selectedDocument.text, selectedDisagreement)
                      : textPartSnippet(selectedDocument.text, focusedPart, 120)}</p>
                  </div>
                  <span className={`status-badge ${selectedDisagreement?.status ?? 'clear'}`}>{selectedDisagreement?.status === 'pending' ? 'difference' : selectedDisagreement?.status ?? 'clear'}</span>
                </div>
              )}
              <section className="work-panel">
                <div className="control-title">Category</div>
                <div className="shortcut-grid compact">
                  {(taxonomy?.categories ?? []).map((category) => (
                    <button key={category} className={`shortcut ${selectedCustomLabel.category === category ? 'active' : ''}`} onClick={() => updateSelectedCustomLabel(category, '')} disabled={!selectedCustomSpan}>
                      <kbd>{categoryKeys[category] ?? category[0]}</kbd><span>{category}</span>
                    </button>
                  ))}
                </div>
              </section>
              <section className="work-panel">
                <div className="control-title">Subtype</div>
                <div className="shortcut-grid compact">
                  {(taxonomy?.subtypes ?? []).map((subtype) => (
                    <button key={subtype} className={`shortcut ${selectedCustomLabel.subtype === subtype ? 'active' : ''}`} onClick={() => updateSelectedCustomLabel(selectedCustomLabel.category, subtype)} disabled={!selectedCustomSpan || !selectedAllowedSubtypes.includes(subtype)}>
                      <kbd>{subtypeKeys[subtype] ?? subtype[0]}</kbd><span>{subtype}</span>
                    </button>
                  ))}
                </div>
              </section>
              {message && <div className="decision-footer" role="status"><span>{message}</span></div>}
            </>
          ) : null}
        </section>
      </main>
      <footer className="audit-footer">
        <span>Curator <strong>{project.curator.curator_id}</strong></span>
        <span>{project.decision_events.length} append-only decision events</span>
        <span>Offset unit: Unicode code points</span>
      </footer>
    </div>
  );
}

function App() {
  const [payload, setPayload] = React.useState(null);
  const [showImport, setShowImport] = React.useState(false);
  const [loadError, setLoadError] = React.useState('');
  React.useEffect(() => {
    api('/bootstrap').then(setPayload).catch((error) => setLoadError(error.message));
  }, []);
  if (loadError) return <div className="fatal-error"><h1>MedDeID Curate could not start</h1><p>{loadError}</p></div>;
  if (!payload) return <div className="loading-screen">Loading curation workspace…</div>;
  if (!payload.project || showImport) {
    return <ImportScreen existingProject={payload.project} onImported={(next) => { setPayload(next); setShowImport(false); }} />;
  }
  return <CurateWorkspace payload={payload} setPayload={setPayload} onNewProject={() => setShowImport(true)} />;
}

const appRoot = globalThis.__meddeidCurateRoot
  ?? (globalThis.__meddeidCurateRoot = createRoot(document.getElementById('root')));
appRoot.render(<App />);
