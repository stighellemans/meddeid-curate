import express from "express";
import fs from "node:fs";
export function createComparisonRouter({
  store,
  finalize = () => store.finalize(),
  allowImport = true,
}) {
  const app = express.Router();
  app.get("/bootstrap", async (_req, res, next) => {
    try {
      res.json(await store.bootstrap());
    } catch (error) {
      next(error);
    }
  });
  app.post("/import", async (req, res) => {
    if (!allowImport)
      return res
        .status(409)
        .json({
          error:
            "Create a new comparison from the library. Existing comparisons keep their original inputs.",
        });
    try {
      res.json(
        await store.importFiles(req.body?.files, {
          curatorId: req.body?.curatorId,
          curatedFile: req.body?.curatedFile,
        }),
      );
    } catch (error) {
      res
        .status(error?.statusCode ?? 400)
        .json({ error: "Import failed", detail: error.message });
    }
  });
  app.post(
    "/documents/:documentId/disagreements/:disagreementId",
    async (req, res) => {
      try {
        res.json(
          await store.resolveDisagreement(
            req.params.documentId,
            req.params.disagreementId,
            req.body ?? {},
          ),
        );
      } catch (error) {
        res
          .status(error?.statusCode ?? 500)
          .json({ error: "Decision failed", detail: error.message });
      }
    },
  );
  app.post("/documents/:documentId/confirm", async (req, res) => {
    try {
      res.json(
        await store.confirmDocument(req.params.documentId, req.body ?? {}),
      );
    } catch (error) {
      res
        .status(error?.statusCode ?? 500)
        .json({ error: "Document confirmation failed", detail: error.message });
    }
  });
  app.post("/documents/:documentId/curator-spans", async (req, res) => {
    try {
      res.json(
        await store.mutateCuratorSpan(req.params.documentId, req.body ?? {}),
      );
    } catch (error) {
      res
        .status(error?.statusCode ?? 500)
        .json({ error: "Curator span change failed", detail: error.message });
    }
  });
  app.post("/history/undo", async (req, res) => {
    try {
      res.json(await store.undo(req.body ?? {}));
    } catch (error) {
      res
        .status(error?.statusCode ?? 500)
        .json({ error: "Undo failed", detail: error.message });
    }
  });
  app.post("/history/redo", async (req, res) => {
    try {
      res.json(await store.redo(req.body ?? {}));
    } catch (error) {
      res
        .status(error?.statusCode ?? 500)
        .json({ error: "Redo failed", detail: error.message });
    }
  });
  app.post("/finalize", async (_req, res) => {
    try {
      res.json(await finalize());
    } catch (error) {
      res
        .status(error?.statusCode ?? 500)
        .json({ error: "Finalize failed", detail: error.message });
    }
  });
  app.get("/export", async (_req, res) => {
    const current = await store.publishedGold();
    if (!current || !fs.existsSync(current.annotationsPath)) {
      res.status(404).json({ error: "No finalized export exists" });
      return;
    }
    res.download(current.annotationsPath, "meddeid-adjudicated.jsonl");
  });

  return app;
}
