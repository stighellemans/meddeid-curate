import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createWorkspaceRouter } from "../../server/workspace-router.js";
const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const kind = path.basename(rootDir).replace("meddeid-", "");
const row = {
  document_id: "trash-doc",
  text: "Alex Example",
  annotated: true,
  spans: [{ begin: 0, end: 12, label: "Name:Patient" }],
};
const files = [
  { name: "a.jsonl", content: JSON.stringify(row) + "\n" },
  {
    name: "b.jsonl",
    content: JSON.stringify({ ...row, metadata: { reviewer: "B" } }) + "\n",
  },
];
async function serve(workspaceDir) {
  const app = express();
  app.use(express.json());
  app.use("/api", await createWorkspaceRouter({ rootDir, kind, workspaceDir }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return {
    async call(route, body, status = 200, method) {
      const res = await fetch(
        `http://127.0.0.1:${server.address().port}/api${route}`,
        {
          method: method || (body ? "POST" : "GET"),
          headers: { "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        },
      );
      const data = await res.json();
      assert.equal(res.status, status, JSON.stringify(data));
      return data;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
async function tree(dir) {
  const result = {};
  async function walk(base, rel = "") {
    for (const e of await fs.readdir(base, { withFileTypes: true })) {
      if (e.name === ".trash.json") continue;
      const name = path.join(rel, e.name);
      if (e.isDirectory()) await walk(path.join(base, e.name), name);
      else
        result[name] = (await fs.readFile(path.join(base, e.name))).toString(
          "base64",
        );
    }
  }
  await walk(dir);
  return result;
}
test("trash requires confirmation, preserves all files across restart, restores safely and purges only the chosen item", async () => {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `${kind}-trash-`),
  );
  let api = await serve(workspaceDir);
  try {
    const params = {
      dataset: "Trash safety fixture",
      name: "Recoverable item",
      curatorId: "test",
      files,
      filename: "notes.jsonl",
      content: files[0].content,
    };
    const { assignment } = await api.call(
      kind === "curate" ? "/workspace/comparisons" : "/workspace/import",
      params,
      201,
    );
    const base = `/assignments/${assignment.id}`,
      active = path.join(workspaceDir, kind, assignment.id),
      trash = path.join(workspaceDir, kind, ".trash", assignment.id),
      trashBase = `/workspace/trash/${assignment.id}`;
    const boot = await api.call(base + "/bootstrap");
    let saveRoute, saveBody, saveMethod;
    if (kind === "curate") {
      saveRoute = base + "/documents/trash-doc/confirm";
      saveBody = { curatorId: "test" };
      await api.call(saveRoute, saveBody);
      await api.call(base + "/finalize", {});
    } else if (kind === "annotate") {
      saveRoute = base + "/documents/trash-doc";
      saveMethod = "PUT";
      saveBody = {
        annotated: true,
        spans: [{ begin: 0, end: 12, label: "Name:Other" }],
      };
      await api.call(saveRoute, saveBody, 200, saveMethod);
    } else {
      saveRoute = base + "/items/save";
      saveBody = {
        itemId: boot.items[0].itemId,
        status: "confirmed",
        segments: [
          { begin: 0, end: 4, category: "given" },
          { begin: 4, end: 5, category: "formatting" },
          { begin: 5, end: 12, category: "family" },
        ],
      };
      await api.call(saveRoute, saveBody);
    }
    await fs.mkdir(path.join(active, "exports"), { recursive: true });
    await fs.writeFile(path.join(active, "exports/keep.txt"), "saved export");
    let dependentDir;
    if (kind !== "subannotate") {
      const id = "11111111-1111-4111-8111-111111111111",
        target = kind === "annotate" ? "curate" : "subannotate";
      dependentDir = path.join(workspaceDir, target, id);
      await fs.mkdir(dependentDir, { recursive: true });
      const ref = { kind, id: assignment.id };
      await fs.writeFile(
        path.join(dependentDir, "assignment.json"),
        JSON.stringify({
          id,
          name: "Downstream work",
          dataset: "Fixture",
          ...(target === "curate"
            ? { inputSources: [ref] }
            : { inputSource: ref }),
        }),
      );
      await fs.writeFile(
        path.join(dependentDir, "frozen.jsonl"),
        files[0].content,
      );
    }
    const dependentBefore = dependentDir ? await tree(dependentDir) : null;
    const detailsBefore = (await api.call(base + "/details")).assignment;
    const before = await tree(active),
      impact = await api.call(base + "/removal");
    assert.equal(impact.assignment.name, params.name);
    assert.equal(impact.downstream.length, kind === "subannotate" ? 0 : 1);
    await api.call(base + "/trash", { confirmName: "wrong" }, 400);
    assert.deepEqual(await tree(active), before);
    await api.call(base + "/trash", { confirmName: params.name });
    await assert.rejects(fs.access(active));
    assert.deepEqual(await tree(trash), before);
    assert.equal((await api.call("/workspace")).assignments.length, 0);
    assert.equal((await api.call("/workspace/trash")).items.length, 1);
    await api.call(saveRoute, saveBody, 404, saveMethod);
    await assert.rejects(fs.access(active));
    await api.close();
    api = await serve(workspaceDir);
    assert.equal((await api.call("/workspace")).assignments.length, 0);
    assert.equal(
      (await api.call("/workspace/trash")).items[0].id,
      assignment.id,
    );
    await fs.mkdir(active);
    await api.call(trashBase + "/restore", {}, 409);
    await fs.rmdir(active);
    await api.call(trashBase + "/restore", {});
    assert.deepEqual(await tree(active), before);
    assert.equal(
      (await api.call(base + "/details")).assignment.reviewed,
      detailsBefore.reviewed,
    );
    if (kind === "curate")
      assert.deepEqual(
        (await api.call(base + "/details")).assignment.results,
        detailsBefore.results,
      );
    await api.call(
      trashBase + "/delete",
      { confirmName: params.name, confirmPermanent: true },
      404,
    );
    await api.call(base + "/trash", { confirmName: params.name });
    await api.call(
      trashBase + "/delete",
      { confirmName: "wrong", confirmPermanent: true },
      400,
    );
    await api.call(trashBase + "/delete", { confirmName: params.name }, 400);
    assert.deepEqual(await tree(trash), before);
    await api.call(trashBase + "/delete", {
      confirmName: params.name,
      confirmPermanent: true,
    });
    assert.equal((await api.call("/workspace/trash")).items.length, 0);
    await assert.rejects(fs.access(trash));
    if (dependentDir)
      assert.deepEqual(await tree(dependentDir), dependentBefore);
  } finally {
    await api.close();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test("removed legacy comparisons do not reappear after trash or permanent deletion", async () => {
  const { createProjectStore } = await import("../../server/project-store.js");
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "curate-trash-legacy-"),
  );
  let api;
  try {
    const dataDir = path.join(workspaceDir, "curate"),
      store = createProjectStore({ rootDir, dataDir });
    await store.load();
    await store.importFiles(files, { curatorId: "test" });
    const original = await fs.readFile(path.join(dataDir, "project.json"));
    api = await serve(workspaceDir);
    const item = (await api.call("/workspace")).assignments[0];
    await api.call(`/assignments/${item.id}/trash`, { confirmName: item.name });
    await api.close();
    api = await serve(workspaceDir);
    assert.equal((await api.call("/workspace")).assignments.length, 0);
    await api.call(`/workspace/trash/${item.id}/delete`, {
      confirmName: item.name,
      confirmPermanent: true,
    });
    await api.close();
    api = await serve(workspaceDir);
    assert.equal((await api.call("/workspace")).assignments.length, 0);
    assert.equal((await api.call("/workspace/trash")).items.length, 0);
    assert.deepEqual(
      await fs.readFile(path.join(dataDir, "project.json")),
      original,
    );
  } finally {
    if (api) await api.close();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});
