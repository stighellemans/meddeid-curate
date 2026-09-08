import {
  registerWorkspaceUpdates,
  recoverSourceUpdate,
  assertSourceRevision,
} from "./workspace-updates.js";
import {
  stageSourceUpdate,
  validateStagedReview,
} from "./workspace-update-adapter.js";
import { registerTrashRoutes } from "./workspace-trash.js";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { zipSync } from "fflate";
import { createProjectStore } from "./project-store.js";
import { createComparisonRouter } from "./comparison-router.js";
import {
  WORKSPACE_ID,
  sha256,
  jsonBytes,
  workspaceError,
  readWorkspaceSource,
  listWorkspaceSources,
  annotationSetFiles,
} from "./workspace-sources.js";

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
async function collect(dir, prefix = "") {
  const files = {};
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (
      entry.isSymbolicLink() ||
      entry.name.startsWith(".") ||
      entry.name === "exports" ||
      entry.name.endsWith(".tmp")
    )
      continue;
    const name = prefix + entry.name;
    if (entry.isDirectory())
      Object.assign(
        files,
        await collect(path.join(dir, entry.name), name + "/"),
      );
    else files[name] = await fs.readFile(path.join(dir, entry.name));
  }
  return files;
}
export async function createWorkspaceRouter({ rootDir, workspaceDir }) {
  const storageRoot = path.resolve(workspaceDir, "curate");
  await fs.mkdir(storageRoot, { recursive: true });
  const taxonomy = await readJson(
    path.join(rootDir, "contracts/taxonomy.json"),
  );
  const contexts = new Map();
  const app = express.Router();
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  const endpoint = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);
  function exclusive(ctx, fn) {
    const guarded = () => {
      if (ctx.removed)
        throw workspaceError(
          "This review changed or was moved to trash. Reload it from the workspace library.",
          410,
        );
      return fn();
    };
    const result = ctx.queue.then(guarded, guarded);
    ctx.queue = result.catch(() => {});
    return result;
  }
  async function versions(ctx) {
    const entries = await fs
      .readdir(path.join(ctx.dir, "results"), { withFileTypes: true })
      .catch((e) => {
        if (e.code === "ENOENT") return [];
        throw e;
      });
    const results = [];
    for (const entry of entries)
      if (entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)) {
        results.push({
          ...(await readJson(
            path.join(ctx.dir, "results", entry.name, "result.json"),
          )),
          resultId: entry.name,
        });
      }
    return results.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  }
  async function archiveResult(ctx, published, matchesCurrent = true) {
    const content = await fs.readFile(published.annotationsPath);
    const decisions = await fs.readFile(published.decisionsPath);
    if (
      sha256(content) !== published.manifest.hashes.annotations_sha256 ||
      sha256(decisions) !== published.manifest.hashes.decisions_sha256
    )
      throw workspaceError("Published result failed its checksum check.", 500);
    const projectSha256 = matchesCurrent
      ? sha256(await fs.readFile(path.join(ctx.dir, "work/project.json")))
      : null;
    const resultId = sha256(
      `${sha256(content)}:${sha256(decisions)}:${projectSha256}`,
    );
    const result = {
      kind: "curate",
      id: ctx.meta.id,
      resultId,
      sha256: sha256(content),
      projectSha256,
      publishedAt: published.manifest.published_at,
      dataset: ctx.meta.dataset,
      name: ctx.meta.name,
      split: ctx.meta.split || "",
    };
    const target = path.join(ctx.dir, "results", resultId);
    try {
      await fs.access(path.join(target, "result.json"));
      return await readJson(path.join(target, "result.json"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const staging = path.join(ctx.dir, "results", `.${crypto.randomUUID()}`);
    await fs.mkdir(staging, { recursive: true });
    try {
      await fs.writeFile(path.join(staging, "annotations.jsonl"), content);
      await fs.writeFile(path.join(staging, "decisions.jsonl"), decisions);
      await fs.writeFile(
        path.join(staging, "manifest.json"),
        jsonBytes(published.manifest),
      );
      await fs.writeFile(path.join(staging, "result.json"), jsonBytes(result));
      await fs.rename(staging, target);
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
    return result;
  }
  async function context(id) {
    if (!WORKSPACE_ID.test(id))
      throw workspaceError("Comparison not found.", 404);
    if (!contexts.has(id)) {
      const pending = (async () => {
        const dir = path.join(storageRoot, id);
        await recoverSourceUpdate(dir);
        let meta;
        try {
          meta = await readJson(path.join(dir, "assignment.json"));
        } catch {
          throw workspaceError("Comparison not found.", 404);
        }
        const store = createProjectStore({
          rootDir,
          dataDir: path.join(dir, "work"),
        });
        await store.load();
        const ctx = { dir, meta, store, queue: Promise.resolve() };
        ctx.router = createComparisonRouter({
          store,
          allowImport: false,
          finalize: async () => {
            const published = await store.finalize();
            return {
              ...published,
              workspaceResult: await archiveResult(ctx, published),
            };
          },
        });
        return ctx;
      })();
      contexts.set(id, pending);
      pending.catch(() => contexts.delete(id));
    }
    return contexts.get(id);
  }
  async function summary(ctx) {
    const payload = await ctx.store.bootstrap();
    const results = await versions(ctx);
    const projectSha = sha256(
      await fs.readFile(path.join(ctx.dir, "work/project.json")),
    );
    const currentResult =
      results.find((result) => result.projectSha256 === projectSha) || null;
    const stat = await fs.stat(path.join(ctx.dir, "work/project.json"));
    return {
      ...ctx.meta,
      documents: payload.stats.documents,
      total: payload.stats.documents,
      reviewed: payload.stats.confirmedDocuments,
      unit: "documents",
      complete: !!currentResult,
      pending: payload.stats.pending,
      results,
      latestResult: currentResult,
      updatedAt: stat.mtime.toISOString(),
      storagePath: ctx.dir,
      outputPath: currentResult
        ? path.join(
            ctx.dir,
            "results",
            currentResult.resultId,
            "annotations.jsonl",
          )
        : path.join(ctx.dir, "work/project.json"),
    };
  }
  // Copy a pre-workspace project once. Its original files remain available for rollback.
  const legacyFile = path.join(storageRoot, "project.json");
  const legacyId = "00000000-0000-4000-8000-000000000001";
  const legacyDir = path.join(storageRoot, legacyId);
  const migrationMarker = path.join(storageRoot, ".legacy-migrated.json");
  if (
    !(await fs.access(migrationMarker).then(
      () => true,
      () => false,
    )) &&
    (await fs.access(legacyFile).then(
      () => true,
      () => false,
    )) &&
    !(await fs.access(path.join(legacyDir, "assignment.json")).then(
      () => true,
      () => false,
    ))
  ) {
    const project = await readJson(legacyFile);
    const staging = path.join(storageRoot, `.migration-${crypto.randomUUID()}`);
    await fs.mkdir(path.join(staging, "work"), { recursive: true });
    try {
      await fs.copyFile(legacyFile, path.join(staging, "work/project.json"));
      if (
        await fs.access(path.join(storageRoot, "exports")).then(
          () => true,
          () => false,
        )
      )
        await fs.cp(
          path.join(storageRoot, "exports"),
          path.join(staging, "work/exports"),
          { recursive: true },
        );
      await fs.writeFile(
        path.join(staging, "assignment.json"),
        jsonBytes({
          id: legacyId,
          kind: "curate",
          dataset: project.dataset?.dataset_id || "Existing dataset",
          name: "Previous comparison",
          split: "",
          createdAt: new Date().toISOString(),
          migratedFrom: legacyFile,
        }),
      );
      await fs.rename(staging, legacyDir);
      const ctx = await context(legacyId);
      const published = await ctx.store.publishedGold();
      // An older export might predate current edits. Preserve it without claiming the working state is finalized.
      if (published) {
        await archiveResult(ctx, published, false);
      }
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
  registerWorkspaceUpdates({
    app,
    workspaceDir,
    kind: "curate",
    rootDir,
    context,
    exclusive,
    contexts,
    stageSourceUpdate,
    validateStagedReview,
  });

  registerTrashRoutes({
    app,
    workspaceDir,
    kind: "curate",
    context,
    exclusive,
    contexts,
  });

  app.get(
    "/workspace",
    endpoint(async (_req, res) => {
      const assignments = [];
      for (const entry of await fs.readdir(storageRoot, {
        withFileTypes: true,
      }))
        if (entry.isDirectory() && WORKSPACE_ID.test(entry.name)) {
          try {
            const ctx = await context(entry.name);
            assignments.push(await exclusive(ctx, () => summary(ctx)));
          } catch (error) {
            assignments.push({
              id: entry.name,
              name: "Unavailable comparison",
              dataset: "",
              error: error.message,
            });
          }
        }
      assignments.sort((a, b) =>
        (b.updatedAt || "").localeCompare(a.updatedAt || ""),
      );
      res.json({
        mode: "workspace",
        kind: "curate",
        storagePath: storageRoot,
        assignments,
      });
    }),
  );
  app.get(
    "/workspace/sources",
    endpoint(async (_req, res) =>
      res.json(
        await listWorkspaceSources(workspaceDir, { includeCurate: false }),
      ),
    ),
  );
  app.post(
    "/workspace/comparisons",
    endpoint(async (req, res) => {
      const { dataset, name, curatorId, sources, curatedFile } = req.body || {};
      if (
        typeof dataset !== "string" ||
        !dataset.trim() ||
        typeof name !== "string" ||
        !name.trim()
      )
        throw workspaceError("Give the dataset and comparison a name.");
      let files = req.body.files,
        inputSources = [];
      if (sources) {
        if (
          !Array.isArray(sources) ||
          sources.length < 2 ||
          sources.some((s) => s.kind !== "annotate") ||
          new Set(sources.map((s) => s.id)).size !== sources.length
        )
          throw workspaceError(
            "Select at least two different completed annotation assignments.",
          );
        const snapshots = await Promise.all(
          sources.map((s) => readWorkspaceSource(workspaceDir, s)),
        );
        inputSources = snapshots.map((s) => s.source);
        files = snapshots.flatMap((s) => annotationSetFiles(s, taxonomy));
      }
      const splits = new Set(inputSources.map((s) => s.split).filter(Boolean));
      if (splits.size > 1)
        throw workspaceError(
          "Choose reviewer assignments from the same split.",
        );
      const split = String(req.body.split || inputSources[0]?.split || "")
        .trim()
        .slice(0, 80);
      if (splits.size && !splits.has(split))
        throw workspaceError("The comparison split must match its sources.");
      if (
        !Array.isArray(files) ||
        !files.length ||
        files.some(
          (f) =>
            typeof f.name !== "string" ||
            path.basename(f.name) !== f.name ||
            !/^[^./\\][^/\\]*\.(jsonl|json)$/.test(f.name) ||
            typeof f.content !== "string",
        ) ||
        new Set(files.map((f) => f.name)).size !== files.length
      )
        throw workspaceError(
          "Choose JSONL files with distinct names and any matching manifests.",
        );
      const id = crypto.randomUUID(),
        staging = path.join(storageRoot, `.import-${id}`),
        dir = path.join(storageRoot, id);
      try {
        await fs.mkdir(path.join(staging, "inputs"), { recursive: true });
        const store = createProjectStore({
          rootDir,
          dataDir: path.join(staging, "work"),
        });
        await store.load();
        await store.importFiles(files, { curatorId, curatedFile });
        for (const file of files)
          await fs.writeFile(
            path.join(staging, "inputs", file.name),
            file.content,
          );
        if (curatedFile)
          await fs.writeFile(
            path.join(staging, "inputs", "prior-curated.snapshot"),
            curatedFile.content,
          );
        await fs.writeFile(
          path.join(staging, "assignment.json"),
          jsonBytes({
            id,
            kind: "curate",
            dataset: dataset.trim().slice(0, 120),
            name: name.trim().slice(0, 120),
            split,
            createdAt: new Date().toISOString(),
            inputSources,
          }),
        );
        await fs.rename(staging, dir);
      } finally {
        await fs.rm(staging, { recursive: true, force: true });
      }
      const ctx = await context(id);
      res.status(201).json({ assignment: await summary(ctx) });
    }),
  );
  app.get(
    "/assignments/:id/details",
    endpoint(async (req, res) => {
      const ctx = await context(req.params.id);
      res.json({ assignment: await exclusive(ctx, () => summary(ctx)) });
    }),
  );
  app.post(
    "/assignments/:id/export",
    endpoint(async (req, res) => {
      const ctx = await context(req.params.id);
      await exclusive(ctx, async () => {
        const info = await summary(ctx),
          files = await collect(ctx.dir);
        files["workspace-manifest.json"] = jsonBytes({
          version: "meddeid.workspace.v1",
          status: info.complete ? "completed" : "in_progress",
          assignment: ctx.meta,
          hashes: Object.fromEntries(
            Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)]),
          ),
        });
        const bytes = Buffer.from(zipSync(files));
        const filename = `curate-${ctx.meta.id}-${Date.now()}.zip`;
        await fs.mkdir(path.join(ctx.dir, "exports"), { recursive: true });
        await fs.writeFile(path.join(ctx.dir, "exports", filename), bytes);
        res.setHeader("Content-Type", "application/zip");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`,
        );
        res.send(bytes);
      });
    }),
  );
  app.use(
    "/assignments/:id",
    endpoint(async (req, res, next) => {
      const ctx = await context(req.params.id);
      await exclusive(
        ctx,
        () =>
          new Promise((resolve, reject) => {
            assertSourceRevision(ctx, req);
            const done = () => {
              res.off("finish", done);
              res.off("close", done);
              resolve();
            };
            res.once("finish", done);
            res.once("close", done);
            ctx.router(req, res, (error) => {
              done();
              error ? reject(error) : next();
            });
          }),
      );
    }),
  );
  app.use((error, _req, res, _next) =>
    res
      .status(error.statusCode || (error.code === "ENOENT" ? 404 : 400))
      .json({ error: error.message }),
  );
  return app;
}
