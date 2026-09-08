import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createComparisonRouter } from "./comparison-router.js";
import { createWorkspaceRouter } from "./workspace-router.js";
import { createProjectStore } from "./project-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 8793);
const host = process.env.HOST || "127.0.0.1";

const app = express();
app.use(express.json({ limit: "50mb" }));
if (process.env.MEDDEID_WORKSPACE_DIR) {
  app.use(
    "/api",
    await createWorkspaceRouter({
      rootDir,
      workspaceDir: path.resolve(process.env.MEDDEID_WORKSPACE_DIR),
    }),
  );
} else {
  const store = createProjectStore({ rootDir });
  await store.load();
  app.get("/api/workspace", (_req, res) => res.json({ mode: "legacy" }));
  app.use("/api", createComparisonRouter({ store }));
}
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "Unknown API action." }),
);
const distDir = path.join(rootDir, "dist");
if (fs.existsSync(path.join(distDir, "index.html"))) {
  app.use(express.static(distDir));
  app.get("*", (_req, res) => res.sendFile(path.join(distDir, "index.html")));
}

const server = app.listen(port, host, () => {
  console.log(`MedDeID Curate listening on http://${host}:${port}`);
});
server.on("error", (error) => {
  console.error("MedDeID Curate failed to start:", error);
  process.exit(1);
});
