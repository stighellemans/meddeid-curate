import fs from "node:fs/promises";
import path from "node:path";
const ID = /^[a-f0-9-]{36}$/;
const fail = (message, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const entries = async (dir) =>
  fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
const exists = async (file) =>
  fs.access(file).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
const writeJson = (file, value) =>
  fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");

// These routes operate on one application's items only. The existing item queue
// drains saves before a move; its retired context then rejects queued requests.
export function registerTrashRoutes({
  app,
  workspaceDir,
  kind,
  context,
  exclusive,
  contexts,
}) {
  const root = path.resolve(workspaceDir, kind),
    trash = path.join(root, ".trash");
  let lifecycle = Promise.resolve();
  function serialized(fn) {
    const result = lifecycle.then(fn, fn);
    lifecycle = result.catch(() => {});
    return result;
  }
  const endpoint = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);
  function itemDir(id) {
    if (!ID.test(id || "")) throw fail("Item not found.", 404);
    return path.join(trash, id);
  }
  async function trashed(id) {
    const dir = itemDir(id);
    try {
      const meta = await readJson(path.join(dir, "assignment.json"));
      if (meta.id !== id)
        throw fail("Trash metadata does not match its folder.", 409);
      return {
        dir,
        meta,
        receipt: await readJson(path.join(dir, ".trash.json")),
      };
    } catch (error) {
      if (error.code === "ENOENT")
        throw fail("Item is no longer in trash.", 404);
      throw error;
    }
  }
  function confirm(req, meta) {
    if (req.body?.confirmName !== meta.name)
      throw fail("Type the exact assignment or comparison name to confirm.");
  }
  async function dependents(id) {
    const found = [];
    for (const appKind of ["annotate", "curate", "subannotate"])
      for (const inTrash of [false, true]) {
        const base = path.join(
          workspaceDir,
          appKind,
          ...(inTrash ? [".trash"] : []),
        );
        for (const entry of await entries(base)) {
          if (!entry.isDirectory() || !ID.test(entry.name)) continue;
          let meta;
          try {
            meta = await readJson(
              path.join(base, entry.name, "assignment.json"),
            );
          } catch (error) {
            if (error.code === "ENOENT") continue;
            throw fail(
              "Could not inspect downstream work. Resolve unreadable assignment metadata before removing this item.",
              409,
            );
          }
          const refs = [
            ...(meta.inputSources || []),
            ...(meta.inputSource ? [meta.inputSource] : []),
          ];
          if (refs.some((ref) => ref.kind === kind && ref.id === id))
            found.push({
              id: meta.id,
              kind: appKind,
              name: meta.name,
              dataset: meta.dataset,
              inTrash,
            });
        }
      }
    return found;
  }
  async function impact(meta) {
    return {
      assignment: { id: meta.id, kind, name: meta.name, dataset: meta.dataset },
      downstream: await dependents(meta.id),
    };
  }
  app.get(
    "/workspace/trash",
    endpoint(async (_req, res) =>
      serialized(async () => {
        const items = [];
        for (const entry of await entries(trash))
          if (entry.isDirectory() && ID.test(entry.name)) {
            const item = await trashed(entry.name);
            items.push({ ...item.meta, removedAt: item.receipt.removedAt });
          }
        items.sort((a, b) => b.removedAt.localeCompare(a.removedAt));
        res.set("Cache-Control", "no-store").json({ items });
      }),
    ),
  );
  app.get(
    "/assignments/:id/removal",
    endpoint(async (req, res) => {
      const ctx = await context(req.params.id);
      res
        .set("Cache-Control", "no-store")
        .json(await exclusive(ctx, () => impact(ctx.meta)));
    }),
  );
  app.post(
    "/assignments/:id/trash",
    endpoint(async (req, res) =>
      serialized(async () => {
        const ctx = await context(req.params.id);
        await exclusive(ctx, async () => {
          confirm(req, ctx.meta);
          const info = await impact(ctx.meta);
          await fs.mkdir(trash, { recursive: true });
          const target = itemDir(ctx.meta.id);
          if (await exists(target))
            throw fail("An item with this ID is already in trash.", 409);
          // Keep the migration marker outside the item so purging it cannot resurrect
          // a preserved legacy comparison on the next application start.
          if (ctx.meta.migratedFrom)
            await writeJson(path.join(root, ".legacy-migrated.json"), {
              id: ctx.meta.id,
            });
          await writeJson(path.join(ctx.dir, ".trash.json"), {
            removedAt: new Date().toISOString(),
            kind,
            id: ctx.meta.id,
          });
          await fs.rename(ctx.dir, target);
          ctx.removed = true;
          contexts.delete(ctx.meta.id);
          res.json({ ...info, removed: true });
        });
      }),
    ),
  );
  app.get(
    "/workspace/trash/:id/removal",
    endpoint(async (req, res) =>
      serialized(async () => {
        const item = await trashed(req.params.id);
        res.set("Cache-Control", "no-store").json(await impact(item.meta));
      }),
    ),
  );
  app.post(
    "/workspace/trash/:id/restore",
    endpoint(async (req, res) =>
      serialized(async () => {
        const item = await trashed(req.params.id),
          target = path.join(root, item.meta.id);
        if (await exists(target))
          throw fail(
            "An active item already has this ID. Restore will not overwrite it.",
            409,
          );
        await fs.rename(item.dir, target);
        contexts.delete(item.meta.id);
        res.json({ assignment: item.meta, restored: true });
      }),
    ),
  );
  app.post(
    "/workspace/trash/:id/delete",
    endpoint(async (req, res) =>
      serialized(async () => {
        const item = await trashed(req.params.id);
        confirm(req, item.meta);
        if (req.body?.confirmPermanent !== true)
          throw fail("Confirm that permanent deletion cannot be undone.");
        await impact(item.meta); // Fail closed if downstream metadata cannot be inspected.
        await fs.rm(item.dir, { recursive: true });
        res.json({ deleted: true });
      }),
    ),
  );
}
