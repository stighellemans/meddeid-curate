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
const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  ),
  kind = path.basename(rootDir).replace("meddeid-", "");
const row = {
  document_id: "first",
  text: "Alex Example",
  annotated: true,
  metadata: { lang: "en-GB" },
  spans: [{ begin: 0, end: 12, label: "Name:Patient" }],
};
const rows = [row, { ...row, document_id: "second" }];
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
async function reviewer(dir, name, records = rows) {
  const id = crypto.randomUUID(),
    base = path.join(dir, "annotate", id);
  await fs.mkdir(path.join(base, "work"), { recursive: true });
  await fs.writeFile(
    path.join(base, "assignment.json"),
    JSON.stringify({ id, dataset: "Study", name, split: "training" }),
  );
  await fs.writeFile(path.join(base, "work/annotations.jsonl"), jsonl(records));
  return (
    await readWorkspaceSource(
      dir,
      { kind: "annotate", id },
      { requireHash: false },
    )
  ).source;
}
async function serve(workspaceDir) {
  const app = express();
  app.use(express.json());
  app.use("/api", await createWorkspaceRouter({ rootDir, workspaceDir, kind }));
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  return {
    call: async (route, body, status = 200, revision = "initial", method) => {
      const res = await fetch(
        `http://127.0.0.1:${server.address().port}/api${route}`,
        {
          method: method || (body ? "POST" : "GET"),
          headers: {
            "Content-Type": "application/json",
            "X-Workspace-Revision": revision,
          },
          body: body ? JSON.stringify(body) : undefined,
        },
      );
      const data = res.headers.get("content-type")?.includes("application/zip")
        ? { bytes: new Uint8Array(await res.arrayBuffer()) }
        : await res.json();
      assert.equal(res.status, status, JSON.stringify(data));
      return data;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), kind + "-updates-")),
    api = await serve(dir),
    a = await reviewer(dir, "A"),
    b = await reviewer(dir, "B");
  const payload =
    kind === "curate"
      ? {
          dataset: "Study",
          name: "Comparison",
          curatorId: "test",
          sources: [a, b],
        }
      : { dataset: "Study", name: "Detailed", source: a };
  const item = (
    await api.call(
      kind === "curate" ? "/workspace/comparisons" : "/workspace/import",
      payload,
      201,
    )
  ).assignment;
  const base = "/assignments/" + item.id,
    up = base + "/source-update";
  return { dir, api, a, b, item, base, up };
}
async function confirm(api, base, revision = "initial") {
  const boot = await api.call(base + "/bootstrap");
  if (kind === "curate") {
    for (const doc of boot.project.documents)
      await api.call(
        base + `/documents/${doc.document_id}/confirm`,
        { curatorId: "test" },
        200,
        revision,
      );
  } else {
    for (const item of boot.items)
      await api.call(
        base + "/items/save",
        {
          itemId: item.itemId,
          status: "confirmed",
          segments: [{ begin: 0, end: 12, category: "given" }],
        },
        200,
        revision,
      );
  }
}
async function change(ctx, records) {
  await fs.writeFile(
    path.join(ctx.dir, "annotate", ctx.a.id, "work/annotations.jsonl"),
    jsonl(records),
  );
  if (kind === "curate")
    await fs.writeFile(
      path.join(ctx.dir, "annotate", ctx.b.id, "work/annotations.jsonl"),
      jsonl(records),
    );
}
test("in-place source updates preserve compatible work, reject stale previews/tabs, restore and recover interrupted commits", async () => {
  const c = await setup();
  let api = c.api;
  try {
    await confirm(api, c.base);
    if (kind === "curate") await api.call(c.base + "/finalize", {});
    const itemDir = path.join(c.dir, kind, c.item.id);
    await fs.mkdir(path.join(itemDir, "exports"), { recursive: true });
    await fs.writeFile(path.join(itemDir, "exports/keep.txt"), "old export");
    await fs.mkdir(path.join(itemDir, "work/rebase-backups/legacy"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(itemDir, "work/rebase-backups/legacy/saved.json"),
      "legacy saved work",
    );
    assert.equal((await api.call(c.up)).state, "current");
    const changed = [{ ...row, text: "John Example" }, rows[1]];
    await change(c, changed);
    assert.equal((await api.call(c.up)).state, "available");
    const preview = await api.call(c.up + "/preview", {});
    assert(preview.token);
    if (kind === "curate") {
      assert.equal(preview.report.summary.preservedConfirmedDocuments, 1);
      assert.equal(preview.report.summary.reviewRequiredDocuments, 1);
    } else {
      assert.equal(preview.report.summary.confirmedPreserved, 1);
      assert.equal(preview.report.summary.requiresReview, 1);
    }
    assert.equal(
      (await api.call(c.base + "/details")).assignment.reviewed,
      2,
      "preview must not modify saved work",
    );
    const result = await api.call(c.up + "/apply", { token: preview.token }),
      revision = result.revision;
    assert.equal(
      (await api.call(c.base + "/details")).assignment.id,
      c.item.id,
    );
    assert.equal((await api.call(c.base + "/details")).assignment.reviewed, 1);
    assert.equal((await api.call(c.up)).state, "current");
    if (kind === "curate")
      assert.equal(
        (await api.call(c.base + "/details")).assignment.results.length,
        1,
      );
    const exported = await api.call(c.base + "/export", {}, 200, revision);
    const bundle = unzipSync(exported.bytes);
    assert(bundle["workspace-manifest.json"]);
    assert(
      bundle[kind === "curate" ? "work/project.json" : "annotations.jsonl"],
    );
    const boot = await api.call(c.base + "/bootstrap");
    await api.call(
      kind === "curate"
        ? c.base + "/documents/second/confirm"
        : c.base + "/items/save",
      kind === "curate"
        ? { curatorId: "test" }
        : {
            itemId: boot.items[0].itemId,
            status: "confirmed",
            segments: [{ begin: 0, end: 12, category: "given" }],
          },
      409,
    );
    await change(c, [
      { ...changed[0], metadata: { lang: "en-GB", edition: 2 } },
      rows[1],
    ]);
    const stale = await api.call(c.up + "/preview", {}, 200, revision);
    await change(c, [
      { ...changed[0], metadata: { lang: "en-GB", edition: 3 } },
      rows[1],
    ]);
    await api.call(c.up + "/apply", { token: stale.token }, 409, revision);
    const savedPreview = await api.call(c.up + "/preview", {}, 200, revision);
    await confirm(api, c.base, revision);
    await api.call(
      c.up + "/apply",
      { token: savedPreview.token },
      409,
      revision,
    );
    const versions = (await api.call(c.up + "/history")).versions;
    assert.equal(versions.length, 1);
    const restore = await api.call(
      c.up + "/restore-preview",
      { versionId: versions[0].id },
      200,
      revision,
    );
    const restored = await api.call(
      c.up + "/apply",
      { token: restore.token },
      200,
      revision,
    );
    assert.notEqual(restored.revision, revision);
    assert.equal((await api.call(c.base + "/details")).assignment.reviewed, 2);
    assert.equal((await api.call(c.up)).state, "available");
    assert.equal(
      await fs.readFile(
        path.join(itemDir, "work/rebase-backups/legacy/saved.json"),
        "utf8",
      ),
      "legacy saved work",
    );
    const history = (await api.call(c.up + "/history")).versions;
    assert.equal(history.length, 2);
    assert.equal(
      await fs.readFile(path.join(itemDir, "exports/keep.txt"), "utf8"),
      "old export",
    );
    await api.close();
    // Simulate interruption after the durable journal but during file replacement.
    await fs.writeFile(
      path.join(itemDir, ".source-update-journal.json"),
      JSON.stringify({ before: history[0].id }),
    );
    await fs.rm(path.join(itemDir, "work"), { recursive: true });
    api = await serve(c.dir);
    assert.equal(
      (await api.call(c.base + "/details")).assignment.id,
      c.item.id,
    );
    await assert.rejects(
      fs.access(path.join(itemDir, ".source-update-journal.json")),
    );
  } finally {
    await api.close();
    await fs.rm(c.dir, { recursive: true, force: true });
  }
});
test("100 successive updates keep one review and deduplicate recovery files without nested backups", async () => {
  const c = await setup();
  let revision = "initial";
  try {
    await confirm(c.api, c.base);
    for (let i = 1; i <= 100; i++) {
      await change(c, [
        { ...row, metadata: { lang: "en-GB", edition: i } },
        rows[1],
      ]);
      const preview = await c.api.call(c.up + "/preview", {}, 200, revision);
      revision = (
        await c.api.call(
          c.up + "/apply",
          { token: preview.token },
          200,
          revision,
        )
      ).revision;
    }
    assert.equal((await c.api.call("/workspace")).assignments.length, 1);
    assert.equal((await c.api.call(c.up + "/history")).versions.length, 100);
    const base = path.join(c.dir, kind, c.item.id, ".source-history"),
      names = await fs.readdir(base);
    assert.equal(names.filter((n) => n.endsWith(".json")).length, 100);
    const manifests = await Promise.all(
      names
        .filter((n) => n.endsWith(".json"))
        .map(async (n) =>
          JSON.parse(await fs.readFile(path.join(base, n), "utf8")),
        ),
    );
    const referenced = manifests.flatMap((m) => Object.values(m.files));
    const stored = await fs.readdir(path.join(base, "objects"));
    assert.equal(stored.length, new Set(referenced).size);
    assert(
      stored.length < referenced.length,
      "unchanged files should share stored objects",
    );
    await assert.rejects(
      fs.access(path.join(c.dir, kind, c.item.id, "work/rebase-backups")),
    );
  } finally {
    await c.api.close();
    await fs.rm(c.dir, { recursive: true, force: true });
  }
});
