import React, { useEffect, useRef, useState } from "react";
const keyOf = (source) =>
  `${source.kind}:${source.id}:${source.resultId || ""}:${source.sha256}`;
export default function SourcePicker({
  kind,
  initialSource,
  assignments,
  close,
  created,
  resume,
}) {
  const curate = kind === "curate";
  const ref = useRef(null);
  const [catalog, setCatalog] = useState(null);
  const [selected, setSelected] = useState(
    initialSource ? [keyOf(initialSource)] : [],
  );
  const [mode, setMode] = useState("workspace");
  const [files, setFiles] = useState([]);
  const [curatedFile, setCuratedFile] = useState(null);
  const [dataset, setDataset] = useState(initialSource?.dataset || "");
  const [name, setName] = useState(curate ? "Curation" : "Detailed review");
  const [split, setSplit] = useState(initialSource?.split || "");
  const [curatorId, setCuratorId] = useState(
    () => localStorage.getItem("meddeid.curatorId") || "curator-01",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [neutralAvailable, setNeutralAvailable] = useState(false);
  const [allowNeutralProfile, setAllowNeutralProfile] = useState(false);
  // Validation describes one input selection. Once that selection changes,
  // remove its stale message and let the next submission validate again.
  useEffect(() => {
    setError("");
    setNeutralAvailable(false);
    setAllowNeutralProfile(false);
  }, [selected, files, curatedFile, dataset, name, split, curatorId, mode]);
  async function refresh() {
    setError("");
    try {
      const response = await fetch("/api/workspace/sources");
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setCatalog(body);
    } catch (error) {
      setError(error.message);
    }
  }
  useEffect(() => {
    ref.current?.showModal();
    refresh();
  }, []);
  const sources = catalog?.sources || [];
  const chosen = sources.filter((s) => selected.includes(keyOf(s)));
  const existing =
    !curate && chosen.length === 1
      ? assignments.filter(
          (a) => a.inputSource && keyOf(a.inputSource) === keyOf(chosen[0]),
        )
      : [];
  function choose(source, checked) {
    setSelected((prev) =>
      curate
        ? checked
          ? [...prev, keyOf(source)]
          : prev.filter((k) => k !== keyOf(source))
        : [keyOf(source)],
    );
    if (!chosen.length || !curate) {
      setDataset(source.dataset);
      setSplit(source.split || "");
    }
  }
  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const fileData =
        mode === "files"
          ? await Promise.all(
              files.map(async (f) => ({
                name: f.name,
                content: await f.text(),
              })),
            )
          : undefined;
      const prior =
        mode === "files" && curatedFile
          ? { name: curatedFile.name, content: await curatedFile.text() }
          : undefined;
      const body = {
        dataset,
        name,
        split,
        curatorId,
        allowNeutralProfile,
        ...(mode === "files"
          ? { files: fileData, curatedFile: prior }
          : curate
            ? { sources: chosen }
            : { source: chosen[0] }),
      };
      const response = await fetch(
        `/api/workspace/${curate ? "comparisons" : "import"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const result = await response.json();
      if (!response.ok) {
        setNeutralAvailable(result.neutralFallbackAvailable === true);
        throw new Error(result.detail || result.error);
      }
      if (curate) localStorage.setItem("meddeid.curatorId", curatorId);
      created(result.assignment.id);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={ref}
      className="ws-dialog ws-source-dialog"
      aria-label={curate ? "New comparison" : "Start detailed review"}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <div className="ws-dialog-heading">
        <h2>{curate ? "New comparison" : "Start detailed review"}</h2>
        <button
          className="ws-icon-button"
          aria-label="Close dialog"
          disabled={busy}
          onClick={close}
        >
          ×
        </button>
      </div>
      <form onSubmit={submit} className="ws-source-form">
        <div className="ws-source-body">
          <p className="ws-dialog-intro">
            {curate
              ? "Select completed reviewers for the same documents. This comparison keeps its own decisions and frozen copies of the inputs."
              : "Choose completed annotations or a finalized curation version. Your detailed review keeps a separate copy of that exact result and inherits its project language for suggestions."}
          </p>
          {curate && (
            <div className="ws-tabs">
              <button
                type="button"
                disabled={busy}
                aria-pressed={mode === "workspace"}
                className={mode === "workspace" ? "active" : ""}
                onClick={() => setMode("workspace")}
              >
                From workspace
              </button>
              <button
                type="button"
                disabled={busy}
                aria-pressed={mode === "files"}
                className={mode === "files" ? "active" : ""}
                onClick={() => setMode("files")}
              >
                Import files
              </button>
            </div>
          )}

          {mode === "workspace" ? (
            <>
              <div className="ws-source-heading">
                <strong>
                  {curate
                    ? "Completed reviewer assignments"
                    : "Available results"}
                </strong>
                <button
                  type="button"
                  className="ws-button ws-secondary"
                  disabled={busy}
                  onClick={refresh}
                >
                  Refresh
                </button>
              </div>
              <div className="ws-source-list">
                {sources.map((source) => (
                  <label
                    className={`ws-source-option ${selected.includes(keyOf(source)) ? "selected" : ""}`}
                    key={keyOf(source)}
                  >
                    <input
                      type={curate ? "checkbox" : "radio"}
                      name="source"
                      checked={selected.includes(keyOf(source))}
                      onChange={(e) => choose(source, e.target.checked)}
                      disabled={busy}
                    />
                    <span>
                      <strong>
                        {source.dataset} / {source.name}
                      </strong>
                      <small>
                        {source.split ? `${source.split} · ` : ""}
                        {source.documents} documents ·{" "}
                        {source.kind === "curate"
                          ? `Curated · ${new Date(source.publishedAt).toLocaleString()}`
                          : "Annotated"}{" "}
                        · version {source.sha256.slice(0, 8)}
                      </small>
                    </span>
                  </label>
                ))}
                {!sources.length && (
                  <p className="ws-small">
                    {catalog
                      ? "No completed sources yet. Finish an Annotate assignment or publish a Curate result, then refresh."
                      : "Loading saved results…"}
                  </p>
                )}
              </div>
              {!!catalog?.unavailable?.length && (
                <p className="ws-small">
                  {catalog.unavailable.length} unfinished or invalid source
                  {catalog.unavailable.length === 1 ? " is" : "s are"} excluded.
                </p>
              )}
              {!!selected.length && chosen.length !== selected.length && (
                <p className="ws-error">
                  A selected version is no longer available. Select its current
                  version.
                </p>
              )}
            </>
          ) : (
            <>
              <label className="ws-field">
                Reviewer JSONL files and optional matching manifests
                <input
                  disabled={busy}
                  type="file"
                  multiple
                  accept=".jsonl,.json"
                  required
                  onChange={(e) => setFiles(Array.from(e.target.files || []))}
                />
              </label>
              <label className="ws-field">
                Previous curated JSONL (optional)
                <input
                  disabled={busy}
                  type="file"
                  accept=".jsonl"
                  onChange={(e) => setCuratedFile(e.target.files?.[0] || null)}
                />
              </label>
            </>
          )}
          <label className="ws-field">
            Dataset name
            <input
              disabled={busy}
              required
              value={dataset}
              maxLength={120}
              onChange={(e) => setDataset(e.target.value)}
            />
          </label>
          <label className="ws-field">
            {curate ? "Comparison name" : "Assignment name"}
            <input
              disabled={busy}
              required
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="ws-field">
            Split (optional)
            <input
              disabled={busy}
              value={split}
              maxLength={80}
              readOnly={mode === "workspace" && chosen.some((s) => s.split)}
              placeholder="Training, validation, test…"
              onChange={(e) => setSplit(e.target.value)}
            />
          </label>
          {curate && (
            <label className="ws-field">
              Curator ID
              <input
                disabled={busy}
                required
                value={curatorId}
                onChange={(e) => setCuratorId(e.target.value)}
              />
            </label>
          )}
          {existing.map((entry) => (
            <div className="ws-existing" key={entry.id}>
              <span>
                Already started: <strong>{entry.name}</strong> ·{" "}
                {entry.reviewed}/{entry.total} reviewed
              </span>
              <button
                type="button"
                className="ws-button ws-secondary"
                disabled={busy}
                onClick={() => resume(entry.id)}
              >
                Resume saved review
              </button>
            </div>
          ))}
        </div>
        <div className="ws-source-footer">
          {error && (
            <p className="ws-error" role="alert">
              {error}
            </p>
          )}
          {neutralAvailable && !curate && (
            <label className="ws-permanent-check">
              <input
                type="checkbox"
                checked={allowNeutralProfile}
                disabled={busy}
                onChange={(e) => setAllowNeutralProfile(e.target.checked)}
              />
              Use language-neutral suggestions for this review.
              Language-specific suggestions will be unavailable.
            </label>
          )}
          <div className="ws-dialog-actions">
            <button
              type="button"
              className="ws-button ws-secondary"
              disabled={busy}
              onClick={close}
            >
              Cancel
            </button>
            <button
              className="ws-button ws-primary"
              disabled={
                busy ||
                (neutralAvailable && !allowNeutralProfile) ||
                (mode === "workspace" &&
                  (chosen.length !== selected.length ||
                    chosen.length < (curate ? 2 : 1)))
              }
            >
              {busy
                ? "Preparing…"
                : curate
                  ? "Create & open comparison"
                  : existing.length
                    ? "Create separate review"
                    : "Create & open detailed review"}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
