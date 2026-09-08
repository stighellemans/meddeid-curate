import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  readWorkspaceSource,
  sha256,
  jsonBytes,
  workspaceError,
} from "./workspace-sources.js";
const managed = ["work", "inputs", "source.jsonl", "assignment.json"];
const omit = new Set([
  "exports",
  "rebase-backups",
  "rebase-reports",
  "profile-migrations",
]);
const exists = async (file) =>
  fs.access(file).then(
    () => true,
    (e) => {
      if (e.code === "ENOENT") return false;
      throw e;
    },
  );
const json = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
async function atomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}
async function files(dir, { archives = false } = {}) {
  const result = {};
  async function walk(rel) {
    const file = path.join(dir, rel);
    if (!(await exists(file))) return;
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink())
      throw workspaceError(
        "A managed review file is a symbolic link; update cannot continue.",
      );
    if (stat.isDirectory()) {
      for (const e of await fs.readdir(file))
        if (!e.startsWith(".") && (archives || !omit.has(e)))
          await walk(path.join(rel, e));
    } else result[rel] = await fs.readFile(file);
  }
  for (const rel of managed) await walk(rel);
  return result;
}
const digest = (bytes) =>
  sha256(
    jsonBytes(
      Object.fromEntries(
        Object.entries(bytes)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => [key, sha256(value)]),
      ),
    ),
  );
async function copyState(from, to) {
  for (const [rel, content] of Object.entries(await files(from)))
    await atomic(path.join(to, rel), content);
}
async function history(dir) {
  const base = path.join(dir, ".source-history");
  if (!(await exists(base))) return [];
  return (
    await Promise.all(
      (await fs.readdir(base))
        .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
        .map((name) => json(path.join(base, name))),
    )
  ).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
async function saveVersion(dir, label) {
  const state = await files(dir, { archives: true }),
    id = crypto.randomUUID(),
    base = path.join(dir, ".source-history");
  const entries = {};
  for (const [rel, bytes] of Object.entries(state)) {
    const hash = sha256(bytes);
    entries[rel] = hash;
    const file = path.join(base, "objects", hash);
    if (!(await exists(file))) await atomic(file, bytes);
  }
  const meta = JSON.parse(state["assignment.json"]);
  const item = {
    id,
    createdAt: new Date().toISOString(),
    label,
    source: meta.inputSource || meta.inputSources,
    files: entries,
  };
  await atomic(path.join(base, id + ".json"), jsonBytes(item));
  return item;
}
async function materialize(dir, item, target) {
  for (const [rel, hash] of Object.entries(item.files)) {
    if (
      !/^[a-f0-9]{64}$/.test(hash) ||
      path.isAbsolute(rel) ||
      rel.split(/[\\/]/).includes("..") ||
      !managed.includes(rel.split("/")[0])
    )
      throw workspaceError("Invalid recovery manifest.");
    const bytes = await fs.readFile(
      path.join(dir, ".source-history", "objects", hash),
    );
    if (sha256(bytes) !== hash)
      throw workspaceError("Recovery file checksum mismatch.");
    await atomic(path.join(target, rel), bytes);
  }
}
async function replaceState(dir, stage) {
  for (const rel of managed) {
    const target = path.join(dir, rel);
    await fs.rm(target, { recursive: true, force: true });
    if (await exists(path.join(stage, rel)))
      await fs.rename(path.join(stage, rel), target);
  }
}
// A durable journal points to a verified recovery snapshot before any live file
// changes. An interrupted commit is rolled back before the item can be opened.
export async function recoverSourceUpdate(dir) {
  const journal = path.join(dir, ".source-update-journal.json");
  if (!(await exists(journal))) return;
  const { before } = await json(journal),
    versions = await history(dir),
    item = versions.find((v) => v.id === before);
  if (!item) throw workspaceError("Source update recovery version is missing.");
  const stage = path.join(dir, ".source-recovery");
  await fs.rm(stage, { recursive: true, force: true });
  await materialize(dir, item, stage);
  await replaceState(dir, stage);
  await fs.rm(journal);
  await fs.rm(stage, { recursive: true, force: true });
}
export function assertSourceRevision(ctx, req) {
  if (req.method === "GET" || req.method === "HEAD") return;
  const actual = ctx.meta.sourceRevision || "initial";
  if ((req.get("X-Workspace-Revision") || "initial") !== actual)
    throw workspaceError(
      "This review was updated in another tab. Reload it before saving; your draft has not been applied.",
      409,
    );
}
export function registerWorkspaceUpdates({
  app,
  workspaceDir,
  kind,
  rootDir,
  context,
  exclusive,
  contexts,
  stageSourceUpdate,
  validateStagedReview,
}) {
  const endpoint = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res)).catch(next);
  const wrap = (fn) =>
    endpoint(async (req, res) => {
      const ctx = await context(req.params.id);
      await exclusive(ctx, () => fn(ctx, req, res));
    });
  async function newest(ref) {
    if (ref.kind === "annotate")
      return readWorkspaceSource(
        workspaceDir,
        { kind: ref.kind, id: ref.id },
        { requireHash: false },
      );
    const dir = path.join(workspaceDir, "curate", ref.id, "results");
    const versions = [];
    for (const e of await fs.readdir(dir, { withFileTypes: true }))
      if (e.isDirectory() && /^[a-f0-9]{64}$/.test(e.name)) {
        const record = await json(path.join(dir, e.name, "result.json"));
        versions.push({ ...record, resultId: e.name });
      }
    versions.sort(
      (a, b) =>
        b.publishedAt.localeCompare(a.publishedAt) ||
        b.resultId.localeCompare(a.resultId),
    );
    if (!versions.length)
      throw workspaceError("No published curation version is available.");
    return readWorkspaceSource(
      workspaceDir,
      { kind: ref.kind, id: ref.id, resultId: versions[0].resultId },
      { requireHash: false },
    );
  }
  async function inspect(ctx) {
    const refs =
      ctx.meta.inputSources ||
      (ctx.meta.inputSource ? [ctx.meta.inputSource] : []);
    if (!refs.length)
      return {
        state: "unlinked",
        message:
          "This review was imported from files and has no linked workspace source.",
        sources: [],
      };
    const snapshots = [];
    try {
      for (const ref of refs) snapshots.push(await newest(ref));
    } catch (error) {
      return {
        state: "blocked",
        message:
          "The upstream source is unavailable or still being reviewed. Finish and save the source review, or publish its curation result, then check again.",
        detail: error.message,
        sources: [],
      };
    }
    const changed = snapshots.some(
      (s, i) =>
        s.source.sha256 !== refs[i].sha256 ||
        (s.source.resultId || "") !== (refs[i].resultId || ""),
    );
    let upstreamPending = false;
    if (!changed && refs[0]?.kind === "curate") {
      const meta = await json(
        path.join(workspaceDir, "curate", refs[0].id, "assignment.json"),
      );
      const published = await json(
        path.join(
          workspaceDir,
          "curate",
          refs[0].id,
          "results",
          refs[0].resultId,
          "result.json",
        ),
      );
      upstreamPending =
        published.projectSha256 !==
        sha256(
          await fs.readFile(
            path.join(workspaceDir, "curate", refs[0].id, "work/project.json"),
          ),
        );
      for (const ref of meta.inputSources || []) {
        try {
          if ((await newest(ref)).source.sha256 !== ref.sha256)
            upstreamPending = true;
        } catch {
          upstreamPending = true;
        }
      }
    }
    return {
      state: changed ? "available" : upstreamPending ? "pending" : "current",
      message: changed
        ? "Newer source available"
        : upstreamPending
          ? "Upstream changes are waiting for curation and publication."
          : "Using the latest available source.",
      sources: snapshots.map((s) => s.source),
      snapshots,
    };
  }
  app.get(
    "/assignments/:id/source-update",
    wrap(async (ctx, _req, res) => {
      const { snapshots, ...info } = await inspect(ctx);
      res
        .set("Cache-Control", "no-store")
        .json({ ...info, revision: ctx.meta.sourceRevision || "initial" });
    }),
  );
  app.get(
    "/assignments/:id/source-update/history",
    wrap(async (ctx, _req, res) =>
      res.set("Cache-Control", "no-store").json({
        versions: (await history(ctx.dir)).map(({ files, ...item }) => item),
      }),
    ),
  );
  async function preview(ctx, req, res, restore = false) {
    assertSourceRevision(ctx, req);
    const base = path.join(ctx.dir, ".source-preview");
    await fs.rm(base, { recursive: true, force: true });
    await fs.mkdir(base, { recursive: true });
    try {
      const from = digest(await files(ctx.dir));
      let report,
        metaPatch = {},
        sources = [],
        label;
      if (restore) {
        const entry = (await history(ctx.dir)).find(
          (v) => v.id === req.body?.versionId,
        );
        if (!entry) throw workspaceError("Recovery version not found.", 404);
        await materialize(ctx.dir, entry, base);
        await validateStagedReview({
          rootDir,
          stageDir: base,
          currentDir: ctx.dir,
        });
        report = {
          restore: true,
          createdAt: entry.createdAt,
          summary: {},
          details: [],
        };
        label = "Before restoring " + entry.createdAt;
      } else {
        const info = await inspect(ctx);
        if (info.state !== "available") throw workspaceError(info.message, 409);
        sources = info.sources;
        await copyState(ctx.dir, base);
        const result = await stageSourceUpdate({
          rootDir,
          currentDir: ctx.dir,
          stageDir: base,
          snapshots: info.snapshots,
        });
        report = result.report;
        metaPatch = result.metaPatch;
        label = "Before source update";
      }
      const meta = await json(path.join(base, "assignment.json"));
      Object.assign(meta, metaPatch, {
        sourceRevision: crypto.randomUUID(),
        sourceUpdatedAt: new Date().toISOString(),
      });
      await atomic(path.join(base, "assignment.json"), jsonBytes(meta));
      const token = crypto.randomUUID();
      await atomic(
        path.join(base, ".preview.json"),
        jsonBytes({
          token,
          from,
          report,
          sources,
          restore,
          label,
          stageHash: digest(await files(base)),
        }),
      );
      res.json({ token, report, sources });
    } catch (error) {
      await fs.rm(base, { recursive: true, force: true });
      if (!error.statusCode && !error.code) error.statusCode = 400;
      throw error;
    }
  }
  app.post(
    "/assignments/:id/source-update/preview",
    wrap((ctx, req, res) => preview(ctx, req, res)),
  );
  app.post(
    "/assignments/:id/source-update/restore-preview",
    wrap((ctx, req, res) => preview(ctx, req, res, true)),
  );
  app.post(
    "/assignments/:id/source-update/apply",
    wrap(async (ctx, req, res) => {
      assertSourceRevision(ctx, req);
      const base = path.join(ctx.dir, ".source-preview"),
        info = await json(path.join(base, ".preview.json")).catch(() => null);
      if (!info || info.token !== req.body?.token)
        throw workspaceError(
          "This preview has expired. Preview the update again.",
          409,
        );
      if (digest(await files(ctx.dir)) !== info.from)
        throw workspaceError(
          "Your review changed after the preview. Preview again to include the latest saves.",
          409,
        );
      if (digest(await files(base)) !== info.stageHash)
        throw workspaceError("The staged update changed. Preview again.", 409);
      if (!info.restore) {
        const latest = await inspect(ctx);
        if (
          latest.state !== "available" ||
          JSON.stringify(latest.sources) !== JSON.stringify(info.sources)
        )
          throw workspaceError(
            "The source changed again. Preview its newest version before updating.",
            409,
          );
      }
      const before = await saveVersion(ctx.dir, info.label),
        journal = path.join(ctx.dir, ".source-update-journal.json");
      await atomic(journal, jsonBytes({ before: before.id }));
      try {
        await replaceState(ctx.dir, base);
        await fs.rm(journal);
      } catch (error) {
        await recoverSourceUpdate(ctx.dir);
        throw error;
      }
      ctx.removed = true;
      contexts.delete(ctx.meta.id);
      await fs.rm(base, { recursive: true, force: true });
      res.json({
        updated: true,
        revision: (await json(path.join(ctx.dir, "assignment.json")))
          .sourceRevision,
        recoveryVersion: before.id,
        report: info.report,
      });
    }),
  );
}
