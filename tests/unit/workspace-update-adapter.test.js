import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createProjectStore } from "../../server/project-store.js";
import { stageSourceUpdate } from "../../server/workspace-update-adapter.js";
import { annotationSetFiles, sha256 } from "../../server/workspace-sources.js";
const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const taxonomy = JSON.parse(
  await fs.readFile(path.join(rootDir, "contracts/taxonomy.json"), "utf8"),
);
const row = (id, label = "Name:Patient") => ({
  document_id: id,
  text: "Alex Example",
  annotated: true,
  metadata: { lang: "en-GB" },
  spans: [{ begin: 0, end: 12, label }],
});
function snapshot(id, rows, split = "training") {
  const content = Buffer.from(rows.map(JSON.stringify).join("\n") + "\n");
  return {
    content,
    source: {
      kind: "annotate",
      id,
      name: id,
      split,
      sha256: sha256(content),
      documents: rows.length,
      spans: rows.reduce((n, r) => n + r.spans.length, 0),
    },
  };
}
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "curate-update-"));
  const currentDir = path.join(dir, "current"),
    stageDir = path.join(dir, "stage");
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  const snapshots = [
    snapshot(ids[0], [row("keep"), row("change")]),
    snapshot(ids[1], [row("keep", "Name:Other"), row("change")]),
  ];
  const files = snapshots.flatMap((s) => annotationSetFiles(s, taxonomy));
  await fs.mkdir(path.join(currentDir, "inputs"), { recursive: true });
  for (const file of files)
    await fs.writeFile(
      path.join(currentDir, "inputs", file.name),
      file.content,
    );
  await fs.writeFile(
    path.join(currentDir, "assignment.json"),
    JSON.stringify({
      id: crypto.randomUUID(),
      split: "training",
      inputSources: snapshots.map((s) => s.source),
    }),
  );
  const store = createProjectStore({
    rootDir,
    dataDir: path.join(currentDir, "work"),
  });
  await store.load();
  await store.importFiles(files, { curatorId: "test" });
  const initial = (await store.bootstrap()).project;
  const conflict = initial.documents.find((d) => d.document_id === "keep")
    .disagreements[0];
  await store.resolveDisagreement("keep", conflict.disagreement_id, {
    decision: "accept_candidate",
    candidateId: conflict.candidates[0].candidate_id,
    curatorId: "test",
  });
  await store.confirmDocument("keep", { curatorId: "test" });
  await store.confirmDocument("change", { curatorId: "test" });
  await store.finalize();
  await fs.mkdir(path.join(currentDir, "results", "published"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(currentDir, "results", "published", "immutable.json"),
    "keep this publication",
  );
  await fs.mkdir(stageDir);
  await fs.cp(path.join(currentDir, "work"), path.join(stageDir, "work"), {
    recursive: true,
  });
  await fs.cp(path.join(currentDir, "inputs"), path.join(stageDir, "inputs"), {
    recursive: true,
  });
  const before = await fs.readFile(
    path.join(currentDir, "work/project.json"),
    "utf8",
  );
  return {
    dir,
    currentDir,
    stageDir,
    ids,
    snapshots,
    before,
    clean: () => fs.rm(dir, { recursive: true, force: true }),
  };
}
const readProject = (dir) =>
  fs.readFile(path.join(dir, "work/project.json"), "utf8").then(JSON.parse);

test("source updates preserve unchanged curation and confirmation, reset changed documents and never republish", async () => {
  const f = await fixture();
  try {
    const next = [
      snapshot(f.ids[0], [row("keep"), row("change", "Name:Other")]),
      f.snapshots[1],
    ];
    const result = await stageSourceUpdate({ rootDir, ...f, snapshots: next });
    const before = JSON.parse(f.before),
      after = await readProject(f.stageDir);
    assert.deepEqual(
      after.documents.find((d) => d.document_id === "keep"),
      before.documents.find((d) => d.document_id === "keep"),
    );
    const changed = after.documents.find((d) => d.document_id === "change");
    assert.equal(changed.curation_status, "unconfirmed");
    assert.equal(changed.confirmed_at, null);
    assert.equal(changed.disagreements[0].status, "pending");
    assert.deepEqual(result.report.summary, {
      documents: 2,
      preservedDocuments: 1,
      reviewRequiredDocuments: 1,
      addedDocuments: 0,
      removedDocuments: 0,
      preservedConfirmedDocuments: 1,
      resetConfirmedDocuments: 1,
      preservedDecisions: 1,
      resetDecisions: 0,
    });
    assert.equal(
      result.metaPatch.inputSources[0].sha256,
      next[0].source.sha256,
    );
    assert.equal(after.curator.curator_id, "test");
    assert.equal(after.project_id, before.project_id);
    assert.deepEqual(
      after.decision_events.slice(0, -1),
      before.decision_events,
    );
    assert.deepEqual(after.decision_events.at(-1).reset_documents, ["change"]);
    assert.equal(
      await fs.readFile(path.join(f.currentDir, "work/project.json"), "utf8"),
      f.before,
    );
    assert.equal(
      await fs.readFile(
        path.join(f.currentDir, "results/published/immutable.json"),
        "utf8",
      ),
      "keep this publication",
    );
    await assert.rejects(fs.access(path.join(f.stageDir, "work/exports")));
    assert.equal(
      (
        await fs.readFile(
          path.join(f.stageDir, "inputs", `reviewer-${f.ids[0]}.jsonl`),
        )
      ).toString(),
      next[0].content.toString(),
    );
  } finally {
    await f.clean();
  }
});

test("updates report added and removed documents and reset metadata changes", async () => {
  const f = await fixture();
  try {
    const replacement = { ...row("keep"), metadata: { lang: "en-US" } };
    const next = [
      snapshot(f.ids[0], [replacement, row("added")]),
      snapshot(f.ids[1], [replacement, row("added")]),
    ];
    const result = await stageSourceUpdate({ rootDir, ...f, snapshots: next });
    assert.equal(result.report.summary.addedDocuments, 1);
    assert.equal(result.report.summary.removedDocuments, 1);
    assert.equal(result.report.summary.reviewRequiredDocuments, 2);
    assert.equal(result.report.summary.preservedDocuments, 0);
    assert.deepEqual(
      result.report.details.map((d) => [d.documentId, d.status]),
      [
        ["added", "added"],
        ["keep", "review_required"],
        ["change", "removed"],
      ],
    );
  } finally {
    await f.clean();
  }
});

test("invalid sources fail before changing staging or active data", async () => {
  const f = await fixture();
  try {
    const oldStage = await fs.readFile(
      path.join(f.stageDir, "work/project.json"),
      "utf8",
    );
    const cases = [
      [snapshot(f.ids[0], [row("keep")]), f.snapshots[1]],
      [
        snapshot(f.ids[0], [
          { ...row("keep"), text: "Alex Changed" },
          row("change"),
        ]),
        f.snapshots[1],
      ],
      [
        snapshot(f.ids[0], [row("keep"), row("change")], "test"),
        f.snapshots[1],
      ],
      [
        snapshot(crypto.randomUUID(), [row("keep"), row("change")]),
        f.snapshots[1],
      ],
      [
        {
          ...f.snapshots[0],
          source: { ...f.snapshots[0].source, sha256: "a".repeat(64) },
        },
        f.snapshots[1],
      ],
    ];
    for (const snapshots of cases) {
      await assert.rejects(stageSourceUpdate({ rootDir, ...f, snapshots }));
      assert.equal(
        await fs.readFile(path.join(f.stageDir, "work/project.json"), "utf8"),
        oldStage,
      );
      assert.equal(
        await fs.readFile(path.join(f.currentDir, "work/project.json"), "utf8"),
        f.before,
      );
    }
    await assert.rejects(
      stageSourceUpdate({ rootDir, ...f, stageDir: f.currentDir }),
    );
    await fs.appendFile(
      path.join(f.currentDir, "inputs", `reviewer-${f.ids[0]}.jsonl`),
      "\n",
    );
    await assert.rejects(
      stageSourceUpdate({ rootDir, ...f }),
      /checksum check/,
    );
  } finally {
    await f.clean();
  }
});

async function decisionFixture() {
  const f = await fixture();
  const text = "Synthetic ".repeat(8);
  const span = (begin, label = "Name:Patient") => ({
    begin,
    end: begin + 4,
    label,
  });
  const makeRow = (spans) => ({
    document_id: "dense",
    text,
    annotated: true,
    metadata: { lang: "en-GB" },
    spans,
  });
  const rows = [
    makeRow([0, 10, 20, 30, 60, 70].map((begin) => span(begin))),
    makeRow(
      [0, 10, 20, 30, 60, 70].map((begin) =>
        span(begin, [20, 30].includes(begin) ? "Name:Patient" : "Name:Other"),
      ),
    ),
  ];
  const snapshots = rows.map((row, index) => snapshot(f.ids[index], [row]));
  for (const file of snapshots.flatMap((s) => annotationSetFiles(s, taxonomy)))
    await fs.writeFile(
      path.join(f.currentDir, "inputs", file.name),
      file.content,
    );
  const meta = JSON.parse(
    await fs.readFile(path.join(f.currentDir, "assignment.json"), "utf8"),
  );
  meta.inputSources = snapshots.map((s) => s.source);
  await fs.writeFile(
    path.join(f.currentDir, "assignment.json"),
    JSON.stringify(meta),
  );
  const store = createProjectStore({
    rootDir,
    dataDir: path.join(f.currentDir, "work"),
  });
  await store.load();
  await store.importFiles(
    snapshots.flatMap((s) => annotationSetFiles(s, taxonomy)),
    { curatorId: "test" },
  );
  const document = (await store.bootstrap()).project.documents[0];
  for (const disagreement of document.disagreements) {
    const decision =
      disagreement.begin === 60
        ? {
            decision: "custom_spans",
            spans: [{ begin: 60, end: 62, label: "Name:Patient" }],
          }
        : disagreement.begin === 70
          ? { decision: "reject_all" }
          : {
              decision: "accept_candidate",
              candidateId: disagreement.candidates.find(
                (c) => c.span.label === "Name:Patient",
              ).candidate_id,
            };
    await store.resolveDisagreement("dense", disagreement.disagreement_id, {
      ...decision,
      curatorId: "test",
    });
  }
  for (const begin of [20, 30])
    await store.mutateCuratorSpan("dense", {
      action: begin === 20 ? "update" : "delete",
      consensusSpanId: document.consensus_spans.find((s) => s.begin === begin)
        .consensus_span_id,
      ...(begin === 20 ? { span: span(begin, "Name:Other") } : {}),
      curatorId: "test",
    });
  for (const begin of [40, 50])
    await store.mutateCuratorSpan("dense", {
      action: "add",
      span: span(begin),
      curatorId: "test",
    });
  await store.confirmDocument("dense", { curatorId: "test" });
  const before = await fs.readFile(
    path.join(f.currentDir, "work/project.json"),
    "utf8",
  );
  return { ...f, text, span, rows, snapshots, before };
}

test("frequent local changes preserve independent decisions, custom spans and overrides with semantic ID remapping", async () => {
  const f = await decisionFixture();
  try {
    const old = JSON.parse(f.before),
      prior = old.documents[0];
    const oldDisagreement = prior.disagreements.find((d) => d.begin === 0),
      selected = oldDisagreement.candidates.find(
        (c) => c.candidate_id === oldDisagreement.decision.candidate_id,
      );
    oldDisagreement.disagreement_id = "legacy-disagreement";
    selected.candidate_id = "legacy-candidate";
    oldDisagreement.decision.candidate_id = "legacy-candidate";
    const agreed = prior.consensus_spans.find((s) => s.begin === 20),
      override = prior.consensus_span_overrides.find(
        (o) => o.consensus_span_id === agreed.consensus_span_id,
      );
    agreed.consensus_span_id = "legacy-consensus";
    override.consensus_span_id = "legacy-consensus";
    await fs.writeFile(
      path.join(f.currentDir, "work/project.json"),
      JSON.stringify(old),
    );
    const changed = {
      ...f.rows[0],
      spans: [
        ...f.rows[0].spans.map((s) =>
          [10, 30].includes(s.begin) ? { ...s, label: "Name:Other" } : s,
        ),
        f.span(50, "Name:Other"),
      ],
    };
    const result = await stageSourceUpdate({
      rootDir,
      ...f,
      snapshots: [snapshot(f.ids[0], [changed]), f.snapshots[1]],
    });
    const after = (await readProject(f.stageDir)).documents[0];
    assert.equal(after.curation_status, "unconfirmed");
    assert.equal(after.confirmed_by, null);
    const accepted = after.disagreements.find((d) => d.begin === 0);
    assert.equal(accepted.status, "resolved");
    assert.notEqual(accepted.decision.candidate_id, "legacy-candidate");
    assert.equal(
      accepted.candidates.find(
        (c) => c.candidate_id === accepted.decision.candidate_id,
      ).span.label,
      "Name:Patient",
    );
    assert.equal(
      after.disagreements.find((d) => d.begin === 60).decision.type,
      "custom_spans",
    );
    assert.equal(
      after.disagreements.find((d) => d.begin === 70).decision.type,
      "reject_all",
    );
    assert.equal(
      after.disagreements.find((d) => d.begin === 30).status,
      "pending",
    );
    assert.deepEqual(
      after.curator_spans.map((s) => s.begin),
      [40],
    );
    assert.equal(after.consensus_span_overrides.length, 1);
    assert.notEqual(
      after.consensus_span_overrides[0].consensus_span_id,
      "legacy-consensus",
    );
    assert.equal(after.consensus_span_overrides[0].span.begin, 20);
    assert.equal(result.report.summary.preservedDecisions, 5);
    assert.equal(result.report.summary.resetDecisions, 3);
    assert.equal(result.report.details[0].preservedDecisions, 5);
    assert.equal(result.report.details[0].resetDecisions, 3);
    assert.equal(
      (await readProject(f.currentDir)).documents[0].curation_status,
      "confirmed",
    );
  } finally {
    await f.clean();
  }
});

test("changed voter semantics reset the affected choice despite stable span-derived IDs", async () => {
  const f = await decisionFixture();
  try {
    const swapped = f.rows.map((row, index) => ({
      ...row,
      spans: row.spans.map((span) =>
        span.begin === 0
          ? { ...span, label: index === 0 ? "Name:Other" : "Name:Patient" }
          : span,
      ),
    }));
    const result = await stageSourceUpdate({
      rootDir,
      ...f,
      snapshots: swapped.map((row, index) => snapshot(f.ids[index], [row])),
    });
    const after = (await readProject(f.stageDir)).documents[0];
    assert.equal(
      after.disagreements.find((d) => d.begin === 0).status,
      "pending",
    );
    assert.equal(result.report.summary.preservedDecisions, 7);
    assert.equal(result.report.summary.resetDecisions, 1);
  } finally {
    await f.clean();
  }
});

test("text changes reset all decisions; metadata changes preserve compatible decisions but reset confirmation", async () => {
  const f = await decisionFixture();
  try {
    const metadataOnly = f.rows.map((row, index) =>
      snapshot(f.ids[index], [{ ...row, metadata: { lang: "en-US" } }]),
    );
    const metadataResult = await stageSourceUpdate({
      rootDir,
      ...f,
      snapshots: metadataOnly,
    });
    assert.equal(metadataResult.report.summary.preservedDecisions, 8);
    assert.equal(metadataResult.report.summary.resetDecisions, 0);
    assert.equal(
      (await readProject(f.stageDir)).documents[0].curation_status,
      "unconfirmed",
    );
    const changedText = f.rows.map((row, index) =>
      snapshot(f.ids[index], [
        { ...row, text: "Changed   " + row.text.slice(10) },
      ]),
    );
    const textResult = await stageSourceUpdate({
      rootDir,
      ...f,
      snapshots: changedText,
    });
    const after = (await readProject(f.stageDir)).documents[0];
    assert.equal(textResult.report.summary.preservedDecisions, 0);
    assert.equal(textResult.report.summary.resetDecisions, 8);
    assert.ok(after.disagreements.every((d) => d.status === "pending"));
    assert.deepEqual(after.curator_spans, []);
    assert.deepEqual(after.consensus_span_overrides, []);
  } finally {
    await f.clean();
  }
});

test("ambiguous saved candidate identity resets only that disagreement", async () => {
  const f = await decisionFixture();
  try {
    const project = JSON.parse(f.before),
      disagreement = project.documents[0].disagreements.find(
        (d) => d.begin === 0,
      );
    for (const candidate of disagreement.candidates)
      candidate.candidate_id = disagreement.decision.candidate_id;
    await fs.writeFile(
      path.join(f.currentDir, "work/project.json"),
      JSON.stringify(project),
    );
    const snapshots = f.rows.map((row, index) =>
      snapshot(f.ids[index], [{ ...row, metadata: { lang: "en-US" } }]),
    );
    const result = await stageSourceUpdate({ rootDir, ...f, snapshots });
    const after = (await readProject(f.stageDir)).documents[0];
    assert.equal(
      after.disagreements.find((d) => d.begin === 0).status,
      "pending",
    );
    assert.equal(
      after.disagreements.find((d) => d.begin === 10).status,
      "resolved",
    );
    assert.equal(result.report.summary.resetDecisions, 1);
    assert.equal(result.report.summary.preservedDecisions, 7);
  } finally {
    await f.clean();
  }
});
