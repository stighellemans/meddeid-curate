// Shared on-disk handoff contract used by the independently deployed apps.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
export const WORKSPACE_ID = /^[a-f0-9-]{36}$/;
export const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
export const jsonBytes = (value) =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export const workspaceError = (message, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
async function dirs(dir) {
  return fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}
function rowsFrom(content, kind) {
  const rows = content
    .toString()
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  if (
    !rows.length ||
    rows.some(
      (row) =>
        typeof row.document_id !== "string" ||
        typeof row.text !== "string" ||
        !Array.isArray(row.spans),
    )
  )
    throw workspaceError("Invalid canonical annotation source.");
  if (
    rows.some((row) =>
      kind === "annotate"
        ? row.annotated !== true
        : row.annotated !== true && row.completed !== true,
    )
  )
    throw workspaceError("Every source document must be reviewed.");
  if (
    rows.some(
      (row) =>
        row.adjudication &&
        (!["agreed", "adjudicated"].includes(row.adjudication.status) ||
          !Array.isArray(row.adjudication.disagreements) ||
          row.adjudication.disagreements.some((d) => d.status !== "resolved")),
    )
  )
    throw workspaceError("The source contains unfinished adjudication.");
  return rows;
}
export async function readWorkspaceSource(
  workspaceDir,
  selection,
  { requireHash = true } = {},
) {
  if (
    !selection ||
    !WORKSPACE_ID.test(selection.id || "") ||
    !["annotate", "curate"].includes(selection.kind)
  )
    throw workspaceError("Invalid workspace source.");
  if (requireHash && !/^[a-f0-9]{64}$/.test(selection.sha256 || ""))
    throw workspaceError("Select a source version first.");
  const dir = path.join(workspaceDir, selection.kind, selection.id);
  const meta = JSON.parse(
    await fs.readFile(path.join(dir, "assignment.json"), "utf8"),
  );
  let content,
    result = null;
  if (selection.kind === "annotate")
    content = await fs.readFile(path.join(dir, "work/annotations.jsonl"));
  else {
    if (!/^[a-f0-9]{64}$/.test(selection.resultId || ""))
      throw workspaceError("Select a finalized comparison version.");
    const resultDir = path.join(dir, "results", selection.resultId);
    result = JSON.parse(
      await fs.readFile(path.join(resultDir, "result.json"), "utf8"),
    );
    content = await fs.readFile(path.join(resultDir, "annotations.jsonl"));
    if (sha256(content) !== result.sha256)
      throw workspaceError(
        "Finalized result checksum does not match its manifest.",
      );
  }
  const hash = sha256(content);
  if (requireHash && selection.sha256 !== hash)
    throw workspaceError(
      "The source changed after you selected it. Refresh the list and select its current version.",
      409,
    );
  const rows = rowsFrom(content, selection.kind);
  return {
    content,
    source: {
      kind: selection.kind,
      id: selection.id,
      ...(result
        ? { resultId: selection.resultId, publishedAt: result.publishedAt }
        : {}),
      sha256: hash,
      dataset: meta.dataset,
      name: meta.name,
      split: meta.split || "",
      documents: rows.length,
      spans: rows.reduce((n, row) => n + row.spans.length, 0),
    },
  };
}
export async function listWorkspaceSources(
  workspaceDir,
  { includeCurate = true } = {},
) {
  const sources = [];
  const unavailable = [];
  for (const kind of includeCurate ? ["annotate", "curate"] : ["annotate"]) {
    for (const entry of await dirs(path.join(workspaceDir, kind))) {
      if (!entry.isDirectory() || !WORKSPACE_ID.test(entry.name)) continue;
      const id = entry.name;
      if (kind === "annotate") {
        try {
          sources.push(
            (
              await readWorkspaceSource(
                workspaceDir,
                { kind, id },
                { requireHash: false },
              )
            ).source,
          );
        } catch (error) {
          if (error.code !== "ENOENT")
            unavailable.push({ kind, id, reason: error.message });
        }
      } else {
        for (const version of await dirs(
          path.join(workspaceDir, kind, id, "results"),
        )) {
          if (!version.isDirectory() || !/^[a-f0-9]{64}$/.test(version.name))
            continue;
          try {
            sources.push(
              (
                await readWorkspaceSource(
                  workspaceDir,
                  { kind, id, resultId: version.name },
                  { requireHash: false },
                )
              ).source,
            );
          } catch (error) {
            unavailable.push({ kind, id, reason: error.message });
          }
        }
      }
    }
  }
  sources.sort(
    (a, b) =>
      (b.publishedAt || "").localeCompare(a.publishedAt || "") ||
      `${a.dataset}/${a.name}`.localeCompare(`${b.dataset}/${b.name}`),
  );
  return { sources, unavailable };
}
export function annotationSetFiles({ content, source }, taxonomy) {
  const filename = `reviewer-${source.id}.jsonl`;
  const manifest = {
    manifest_version: "meddeid.annotation-set.v1",
    annotation_set_id: source.id,
    status: "completed",
    contracts: {
      schema_version: "meddeid.schema.v1",
      offset_unit: "unicode_codepoints",
      taxonomy_contract_version: taxonomy.contract_version,
      taxonomy_version: taxonomy.taxonomy_version,
    },
    files: { annotations: filename },
    hashes: { annotations_sha256: source.sha256 },
    counts: { documents: source.documents, spans: source.spans },
  };
  return [
    { name: filename, content: content.toString() },
    {
      name: `reviewer-${source.id}.manifest.json`,
      content: jsonBytes(manifest).toString(),
    },
  ];
}
