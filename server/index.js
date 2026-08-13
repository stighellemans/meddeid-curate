import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectStore } from './project-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 8793);
const host = process.env.HOST || '127.0.0.1';
const store = createProjectStore({ rootDir });
await store.load();

const app = express();
app.use(express.json({ limit: '50mb' }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/bootstrap', async (_req, res) => res.json(await store.bootstrap()));
app.post('/api/import', async (req, res) => {
  try {
    res.json(await store.importFiles(req.body?.files, { curatorId: req.body?.curatorId }));
  } catch (error) {
    res.status(error?.statusCode ?? 400).json({ error: 'Import failed', detail: error.message });
  }
});
app.post('/api/documents/:documentId/disagreements/:disagreementId', async (req, res) => {
  try {
    res.json(await store.resolveDisagreement(req.params.documentId, req.params.disagreementId, req.body ?? {}));
  } catch (error) {
    res.status(error?.statusCode ?? 500).json({ error: 'Decision failed', detail: error.message });
  }
});
app.post('/api/documents/:documentId/confirm', async (req, res) => {
  try {
    res.json(await store.confirmDocument(req.params.documentId, req.body ?? {}));
  } catch (error) {
    res.status(error?.statusCode ?? 500).json({ error: 'Document confirmation failed', detail: error.message });
  }
});
app.post('/api/documents/:documentId/curator-spans', async (req, res) => {
  try {
    res.json(await store.mutateCuratorSpan(req.params.documentId, req.body ?? {}));
  } catch (error) {
    res.status(error?.statusCode ?? 500).json({ error: 'Curator span change failed', detail: error.message });
  }
});
app.post('/api/history/undo', async (req, res) => {
  try {
    res.json(await store.undo(req.body ?? {}));
  } catch (error) {
    res.status(error?.statusCode ?? 500).json({ error: 'Undo failed', detail: error.message });
  }
});
app.post('/api/history/redo', async (req, res) => {
  try {
    res.json(await store.redo(req.body ?? {}));
  } catch (error) {
    res.status(error?.statusCode ?? 500).json({ error: 'Redo failed', detail: error.message });
  }
});
app.post('/api/finalize', async (_req, res) => {
  try {
    res.json(await store.finalize());
  } catch (error) {
    res.status(error?.statusCode ?? 500).json({ error: 'Finalize failed', detail: error.message });
  }
});
app.get('/api/export', async (_req, res) => {
  const current = await store.publishedGold();
  if (!current || !fs.existsSync(current.annotationsPath)) {
    res.status(404).json({ error: 'No finalized export exists' });
    return;
  }
  res.download(current.annotationsPath, 'meddeid-adjudicated.jsonl');
});

const distDir = path.join(rootDir, 'dist');
if (fs.existsSync(path.join(distDir, 'index.html'))) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

const server = app.listen(port, host, () => {
  console.log(`MedDeID Curate listening on http://${host}:${port}`);
});
server.on('error', (error) => {
  console.error('MedDeID Curate failed to start:', error);
  process.exit(1);
});
