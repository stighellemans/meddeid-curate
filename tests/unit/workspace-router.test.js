import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { unzipSync } from "fflate";
import { createWorkspaceRouter } from "../../server/workspace-router.js";
import { readWorkspaceSource, sha256 } from "../../server/workspace-sources.js";
import { createProjectStore } from "../../server/project-store.js";
const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const row = {
  document_id: "same-doc",
  text: "Alex Example",
  annotated: true,
  spans: [{ begin: 0, end: 12, label: "Name:Patient" }],
};
const jsonl = (rows) =>
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
async function serve(workspaceDir) {
  const app = express();
  app.use(express.json());
  app.use("/api", await createWorkspaceRouter({ rootDir, workspaceDir }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return {
    call: async (route, body) =>
      fetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      }),
    close: () => new Promise((r) => server.close(r)),
  };
}
async function reviewer(workspaceDir, name, rows = [row], split = "training") {
  const id = crypto.randomUUID(),
    dir = path.join(workspaceDir, "annotate", id);
  await fs.mkdir(path.join(dir, "work"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "assignment.json"),
    JSON.stringify({ id, name, dataset: "Study", split }),
  );
  const content = jsonl(rows);
  await fs.writeFile(path.join(dir, "work/annotations.jsonl"), content);
  return { kind: "annotate", id, sha256: sha256(content) };
}
async function ok(api, route, body, status = 200) {
  const response = await api.call(route, body);
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}
test("comparisons isolate identical documents, freeze inputs, retain versions, and survive restart", async () => {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "curate-library-"),
  );
  let api = await serve(workspaceDir);
  try {
    const a = await reviewer(workspaceDir, "A"),
      b = await reviewer(workspaceDir, "B", [{ ...row, spans: [] }]);
    const create = () =>
      ok(
        api,
        "/workspace/comparisons",
        {
          dataset: "Study",
          name: "Training",
          curatorId: "test",
          sources: [a, b],
        },
        201,
      );
    const one = (await create()).assignment,
      two = (await create()).assignment;
    assert.notEqual(one.id, two.id);
    const base = `/assignments/${one.id}`;
    const initial = await ok(api, base + "/bootstrap");
    const conflict = initial.project.documents[0].disagreements[0];
    assert.equal(initial.project.sources.length, 2);
    assert.equal(initial.stats.pending, 1);
    await fs.writeFile(
      path.join(workspaceDir, "annotate", a.id, "work/annotations.jsonl"),
      jsonl([{ ...row, spans: [] }]),
    );
    assert.equal((await ok(api, base + "/bootstrap")).stats.pending, 1);
    assert.equal(
      (
        await api.call("/workspace/comparisons", {
          dataset: "Study",
          name: "stale",
          curatorId: "test",
          sources: [a, b],
        })
      ).status,
      409,
    );
    assert.equal((await api.call(base + "/import", { files: [] })).status, 409);
    await ok(
      api,
      base + `/documents/same-doc/disagreements/${conflict.disagreement_id}`,
      {
        curatorId: "test",
        decision: "accept_candidate",
        candidateId: conflict.candidates[0].candidate_id,
      },
    );
    assert.equal(
      (await ok(api, `/assignments/${two.id}/bootstrap`)).stats.pending,
      1,
    );
    await ok(api, base + "/documents/same-doc/confirm", { curatorId: "test" });
    const published = await ok(api, base + "/finalize", {});
    const v1 = published.workspaceResult;
    assert.equal((await ok(api, base + "/details")).assignment.complete, true);
    assert.equal(
      (await ok(api, base + "/finalize", {})).workspaceResult.resultId,
      v1.resultId,
    );
    const frozen = await readWorkspaceSource(workspaceDir, v1);
    assert.equal(
      JSON.parse(frozen.content.toString()).spans[0].label,
      "Name:Patient",
    );
    await ok(
      api,
      base + `/documents/same-doc/disagreements/${conflict.disagreement_id}`,
      {
        curatorId: "test",
        decision: "custom_spans",
        spans: [{ begin: 0, end: 4, label: "Name:Other" }],
      },
    );
    assert.equal((await ok(api, base + "/details")).assignment.complete, false);
    await ok(api, base + "/documents/same-doc/confirm", { curatorId: "test" });
    const v2 = (await ok(api, base + "/finalize", {})).workspaceResult;
    assert.notEqual(v1.resultId, v2.resultId);
    assert.equal(
      (await readWorkspaceSource(workspaceDir, v1)).content.toString(),
      frozen.content.toString(),
    );
    await api.close();
    api = await serve(workspaceDir);
    const details = (await ok(api, base + "/details")).assignment;
    assert.equal(details.results.length, 2);
    assert.equal(details.latestResult.resultId, v2.resultId);
    assert.equal((await ok(api, "/workspace")).assignments.length, 2);
    const response = await api.call(base + "/export", {});
    assert.equal(response.status, 200);
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const manifest = JSON.parse(Buffer.from(files["workspace-manifest.json"]));
    assert.equal(manifest.status, "completed");
    for (const [name, hash] of Object.entries(manifest.hashes))
      assert.equal(sha256(files[name]), hash, name);
    assert(files[`results/${v1.resultId}/annotations.jsonl`]);
    assert(files[`results/${v2.resultId}/annotations.jsonl`]);
  } finally {
    await api.close();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});
test("source selection rejects incomplete, mixed splits and mismatched texts without creating comparisons", async () => {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "curate-invalid-"),
  );
  const api = await serve(workspaceDir);
  try {
    const a = await reviewer(workspaceDir, "A");
    const incomplete = await reviewer(workspaceDir, "incomplete", [
      { ...row, annotated: false },
    ]);
    const otherSplit = await reviewer(
      workspaceDir,
      "other",
      [row],
      "validation",
    );
    const otherText = await reviewer(workspaceDir, "mismatch", [
      { ...row, text: "Other person" },
    ]);
    for (const b of [incomplete, otherSplit, otherText, a]) {
      const response = await api.call("/workspace/comparisons", {
        dataset: "Study",
        name: "Invalid",
        curatorId: "test",
        sources: [a, b],
      });
      assert.equal(response.status, 400, await response.text());
    }
    assert.equal((await ok(api, "/workspace")).assignments.length, 0);
    assert.deepEqual(await fs.readdir(path.join(workspaceDir, "curate")), []);
    const sources = await ok(api, "/workspace/sources");
    assert.equal(sources.sources.length, 3);
    assert.equal(sources.unavailable.length, 1);
    const same = await reviewer(
      workspaceDir,
      "Identical but independently reviewed",
    );
    const compared = await ok(
      api,
      "/workspace/comparisons",
      {
        dataset: "Study",
        name: "Agreement",
        curatorId: "test",
        sources: [a, same],
      },
      201,
    );
    const boot = await ok(
      api,
      `/assignments/${compared.assignment.id}/bootstrap`,
    );
    assert.equal(boot.project.sources.length, 2);
    assert.equal(boot.stats.pending, 0);
  } finally {
    await api.close();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});
test("legacy project is copied once and old gold is retained without overwriting the original", async () => {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "curate-migrate-"),
  );
  let api;
  try {
    const dataDir = path.join(workspaceDir, "curate");
    const store = createProjectStore({ rootDir, dataDir });
    await store.load();
    await store.importFiles(
      [
        { name: "a.jsonl", content: jsonl([row]) },
        {
          name: "b.jsonl",
          content: jsonl([{ ...row, metadata: { reviewer: "B" } }]),
        },
      ],
      { curatorId: "test" },
    );
    await store.confirmDocument("same-doc", { curatorId: "test" });
    await store.finalize();
    const original = await fs.readFile(path.join(dataDir, "project.json"));
    api = await serve(workspaceDir);
    let entries = (await ok(api, "/workspace")).assignments;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].results.length, 1);
    await ok(api, `/assignments/${entries[0].id}/finalize`, {});
    assert.equal(
      (await ok(api, `/assignments/${entries[0].id}/details`)).assignment
        .complete,
      true,
    );
    await api.close();
    api = await serve(workspaceDir);
    entries = (await ok(api, "/workspace")).assignments;
    assert.equal(entries.length, 1);
    assert.deepEqual(
      await fs.readFile(path.join(dataDir, "project.json")),
      original,
    );
  } finally {
    if (api) await api.close();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});
