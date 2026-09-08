import fs from "node:fs/promises";
import path from "node:path";
import { createMergeProject, parseCanonicalJsonl } from "./merge-engine.js";
import {
  annotationSetFiles,
  jsonBytes,
  sha256,
  WORKSPACE_ID,
  workspaceError,
} from "./workspace-sources.js";

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}
const sameRecord = (left, right) =>
  !!left &&
  !!right &&
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

const signature = (value) => JSON.stringify(canonical(value));
const spanSignature = (span) =>
  signature([span.begin, span.end, span.label, span.text]);
const overlap = (left, right) =>
  Math.max(left.begin, right.begin) < Math.min(left.end, right.end);
const candidateSignature = (candidate) =>
  signature({
    span: spanSignature(candidate.span),
    presentIn: [...candidate.present_in].sort(),
    missingFrom: [...candidate.missing_from].sort(),
  });
const disagreementSignature = (disagreement) =>
  signature({
    begin: disagreement.begin,
    end: disagreement.end,
    candidates: disagreement.candidates.map(candidateSignature).sort(),
  });
function decisionCount(document) {
  if (!document) return 0;
  return (
    (document.disagreements || []).filter(
      (item) => item.status === "resolved" && item.decision,
    ).length +
    (document.curator_spans || []).length +
    (document.consensus_span_overrides || []).length
  );
}
function changedSourceRegions(beforeRows, afterRows) {
  const regions = [];
  for (let index = 0; index < beforeRows.length; index++) {
    const prior = beforeRows[index]?.spans || [],
      next = afterRows[index]?.spans || [];
    const counts = (spans) => {
      const result = new Map();
      for (const span of spans) {
        const key = spanSignature(span),
          entry = result.get(key);
        result.set(key, { span, count: (entry?.count || 0) + 1 });
      }
      return result;
    };
    const oldCounts = counts(prior),
      newCounts = counts(next);
    for (const key of new Set([...oldCounts.keys(), ...newCounts.keys()])) {
      const oldEntry = oldCounts.get(key),
        newEntry = newCounts.get(key);
      if ((oldEntry?.count || 0) !== (newEntry?.count || 0))
        regions.push(oldEntry?.span || newEntry.span);
    }
  }
  return regions;
}
function carryCompatibleDecisions(before, after, beforeRows, afterRows) {
  if (before.text !== after.text) return 0;
  let preserved = 0;
  const changedRegions = changedSourceRegions(beforeRows, afterRows);
  const outsideChanges = (span) =>
    !changedRegions.some((region) => overlap(span, region));
  for (const prior of before.disagreements || []) {
    if (prior.status !== "resolved" || !prior.decision) continue;
    const key = disagreementSignature(prior);
    // IDs are derived storage identifiers, not proof of compatible candidates.
    // Reject duplicate semantic matches rather than choosing one arbitrarily.
    if (
      before.disagreements.filter((item) => disagreementSignature(item) === key)
        .length !== 1
    )
      continue;
    const matches = after.disagreements.filter(
      (item) => disagreementSignature(item) === key,
    );
    if (matches.length !== 1) continue;
    const next = matches[0],
      decision = structuredClone(prior.decision);
    if (decision.type === "accept_candidate") {
      const oldCandidates = prior.candidates.filter(
        (candidate) => candidate.candidate_id === decision.candidate_id,
      );
      if (oldCandidates.length !== 1) continue;
      const candidates = next.candidates.filter(
        (candidate) =>
          candidateSignature(candidate) ===
          candidateSignature(oldCandidates[0]),
      );
      if (candidates.length !== 1) continue;
      decision.candidate_id = candidates[0].candidate_id;
    } else if (decision.type === "custom_spans") {
      if (
        !Array.isArray(decision.spans) ||
        !decision.spans.length ||
        decision.spans.some(
          (span) =>
            span.begin < next.begin ||
            span.end > next.end ||
            !outsideChanges(span),
        )
      )
        continue;
    } else if (decision.type !== "reject_all") continue;
    next.decision = decision;
    next.status = "resolved";
    preserved++;
  }
  for (const prior of before.consensus_span_overrides || []) {
    const originals = before.consensus_spans.filter(
      (span) => span.consensus_span_id === prior.consensus_span_id,
    );
    if (originals.length !== 1) continue;
    const original = originals[0];
    const matches = after.consensus_spans.filter(
      (span) => spanSignature(span) === spanSignature(original),
    );
    if (matches.length !== 1 || !outsideChanges(original)) continue;
    if (
      prior.action !== "delete" &&
      (prior.action !== "update" || !prior.span || !outsideChanges(prior.span))
    )
      continue;
    if (
      before.consensus_span_overrides.filter(
        (item) => item.consensus_span_id === prior.consensus_span_id,
      ).length !== 1
    )
      continue;
    after.consensus_span_overrides.push({
      ...structuredClone(prior),
      consensus_span_id: matches[0].consensus_span_id,
    });
    preserved++;
  }
  for (const span of before.curator_spans || []) {
    if (
      !outsideChanges(span) ||
      before.curator_spans.filter(
        (item) => item.curator_span_id === span.curator_span_id,
      ).length !== 1
    )
      continue;
    after.curator_spans.push(structuredClone(span));
    preserved++;
  }
  return preserved;
}

// The caller owns the transaction and recovery history. This function writes
// only an isolated stage; it never changes the current comparison or publishes.
export async function stageSourceUpdate({
  rootDir,
  currentDir,
  stageDir,
  snapshots,
}) {
  if (path.resolve(stageDir) === path.resolve(currentDir)) {
    throw workspaceError(
      "A separate staging directory is required for source updates.",
    );
  }
  const [taxonomy, meta, previous] = await Promise.all([
    readJson(path.join(rootDir, "contracts/taxonomy.json")),
    readJson(path.join(currentDir, "assignment.json")),
    readJson(path.join(currentDir, "work/project.json")),
  ]);
  const previousSources = meta.inputSources || [];
  if (
    !Array.isArray(snapshots) ||
    snapshots.length < 2 ||
    snapshots.some(
      (snapshot) =>
        snapshot.source?.kind !== "annotate" ||
        !WORKSPACE_ID.test(snapshot.source?.id),
    ) ||
    new Set(snapshots.map((snapshot) => snapshot.source.id)).size !==
      snapshots.length
  ) {
    throw workspaceError(
      "Select at least two different completed annotation assignments.",
    );
  }
  const inputSources = snapshots.map((snapshot) => snapshot.source);
  if (
    previousSources.length !== inputSources.length ||
    previousSources.some(
      (source) =>
        !inputSources.some(
          (next) => next.id === source.id && next.kind === source.kind,
        ),
    )
  ) {
    throw workspaceError(
      "Updating a comparison must keep the same reviewer assignments.",
    );
  }
  // Use the original reviewer order: the first reviewer supplies document metadata.
  const ordered = previousSources.map((source) =>
    snapshots.find((snapshot) => snapshot.source.id === source.id),
  );
  const splits = new Set(
    inputSources.map((source) => source.split).filter(Boolean),
  );
  if (splits.size > 1)
    throw workspaceError("Choose reviewer assignments from the same split.");
  if (splits.size && !splits.has(meta.split || ""))
    throw workspaceError("The comparison split must match its sources.");

  const oldDocuments = [],
    newDocuments = [];
  for (let index = 0; index < ordered.length; index++) {
    const snapshot = ordered[index],
      prior = previousSources[index];
    const filename = `reviewer-${prior.id}.jsonl`;
    const previousContent = await fs.readFile(
      path.join(currentDir, "inputs", filename),
    );
    if (sha256(previousContent) !== prior.sha256)
      throw workspaceError(
        "A frozen reviewer input failed its checksum check. Restore the comparison before updating.",
      );
    oldDocuments.push(
      parseCanonicalJsonl(filename, previousContent.toString(), taxonomy),
    );
    newDocuments.push(
      parseCanonicalJsonl(filename, snapshot.content.toString(), taxonomy),
    );
  }
  const files = ordered.flatMap((snapshot) =>
    annotationSetFiles(snapshot, taxonomy),
  );
  // This also validates checksums, completion, matching document IDs and text
  // across every new reviewer, using the same merge contract as creation.
  const project = createMergeProject(files, taxonomy);
  const beforeById = new Map(
    previous.documents.map((document) => [document.document_id, document]),
  );
  const afterIds = new Set(
    project.documents.map((document) => document.document_id),
  );
  const details = [];
  const summary = {
    documents: project.documents.length,
    preservedDocuments: 0,
    reviewRequiredDocuments: 0,
    addedDocuments: 0,
    removedDocuments: 0,
    preservedConfirmedDocuments: 0,
    resetConfirmedDocuments: 0,
    preservedDecisions: 0,
    resetDecisions: 0,
  };
  project.documents = project.documents.map((document) => {
    const id = document.document_id,
      before = beforeById.get(id);
    const unchanged =
      before &&
      before.text === document.text &&
      oldDocuments.every((docs, index) =>
        sameRecord(docs.get(id), newDocuments[index].get(id)),
      );
    if (unchanged) {
      const preservedDecisions = decisionCount(before);
      summary.preservedDecisions += preservedDecisions;
      summary.preservedDocuments++;
      if (before.curation_status === "confirmed")
        summary.preservedConfirmedDocuments++;
      details.push({
        documentId: id,
        status: "preserved",
        preservedDecisions,
        resetDecisions: 0,
        reason:
          "All reviewer annotations, text and metadata are unchanged; curation and confirmation are preserved.",
      });
      return structuredClone(before);
    }
    const preservedDecisions = before
      ? carryCompatibleDecisions(
          before,
          document,
          oldDocuments.map((docs) => docs.get(id)),
          newDocuments.map((docs) => docs.get(id)),
        )
      : 0;
    const resetDecisions = decisionCount(before) - preservedDecisions;
    summary.preservedDecisions += preservedDecisions;
    summary.resetDecisions += resetDecisions;
    summary.reviewRequiredDocuments++;
    if (!before) summary.addedDocuments++;
    if (before?.curation_status === "confirmed")
      summary.resetConfirmedDocuments++;
    details.push({
      documentId: id,
      status: before ? "review_required" : "added",
      preservedDecisions,
      resetDecisions,
      reason: !before
        ? "New document; curation is required."
        : before.text !== document.text
          ? "Document text changed; review the rebuilt comparison again."
          : "Reviewer annotations or metadata changed; compatible decisions are preserved, but whole-document confirmation is required again.",
    });
    return document;
  });
  for (const document of previous.documents)
    if (!afterIds.has(document.document_id)) {
      const resetDecisions = decisionCount(document);
      summary.resetDecisions += resetDecisions;
      summary.removedDocuments++;
      details.push({
        documentId: document.document_id,
        status: "removed",
        preservedDecisions: 0,
        resetDecisions,
        reason:
          "Removed from all reviewer inputs; previous curation remains in the recovery version.",
      });
    }
  project.project_id = previous.project_id;
  project.created_at = previous.created_at;
  project.dataset.dataset_id = previous.dataset.dataset_id;
  project.curator = structuredClone(previous.curator);
  if (previous.curated_seed)
    project.curated_seed = structuredClone(previous.curated_seed);
  project.decision_events = structuredClone(previous.decision_events || []);
  const sequence = project.decision_events.length + 1;
  project.decision_events.push({
    event_id: `decision-event-${String(sequence).padStart(6, "0")}`,
    sequence,
    occurred_at: new Date().toISOString(),
    curator_id: previous.curator?.curator_id || null,
    document_id: null,
    disagreement_id: null,
    action: "update_reviewer_sources",
    preserved_decisions: summary.preservedDecisions,
    reset_decisions: summary.resetDecisions,
    previous_sources: previousSources,
    sources: ordered.map((snapshot) => snapshot.source),
    reset_documents: details
      .filter((detail) => ["review_required", "added"].includes(detail.status))
      .map((detail) => detail.documentId),
    removed_documents: details
      .filter((detail) => detail.status === "removed")
      .map((detail) => detail.documentId),
  });

  await fs.mkdir(path.join(stageDir, "inputs"), { recursive: true });
  await fs.mkdir(path.join(stageDir, "work"), { recursive: true });
  for (const file of files)
    await fs.writeFile(path.join(stageDir, "inputs", file.name), file.content);
  await fs.writeFile(
    path.join(stageDir, "work/project.json"),
    jsonBytes(project),
  );
  // These are mutable publication copies, not the immutable results/ archive.
  // They no longer describe the updated comparison, even if all work survived.
  await fs.rm(path.join(stageDir, "work/exports"), {
    recursive: true,
    force: true,
  });
  return {
    report: {
      summary,
      details,
      affectedDocumentIds: details
        .filter((detail) =>
          ["review_required", "added"].includes(detail.status),
        )
        .map((detail) => detail.documentId),
    },
    metaPatch: { inputSources: ordered.map((snapshot) => snapshot.source) },
  };
}

export async function validateStagedReview({ rootDir, stageDir }) {
  const { createProjectStore } = await import("./project-store.js");
  const store = createProjectStore({
    rootDir,
    dataDir: path.join(stageDir, "work"),
  });
  await store.load();
  await store.bootstrap();
}
