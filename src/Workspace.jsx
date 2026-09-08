import React, { useCallback, useEffect, useRef, useState } from "react";
import "./workspace.css";
import SourcePicker from "./SourcePicker.jsx";
import WorkspaceRemoval from "./WorkspaceRemoval.jsx";
import WorkspaceUpdates from "./WorkspaceUpdates.jsx";

function Icon({ name, size = 20 }) {
  const shapes = {
    folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z" />,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    upload: (
      <>
        <path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6" />
      </>
    ),
    download: <path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5" />,
    check: <path d="m5 12 4 4L19 6" />,
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 6 6" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {shapes[name] || shapes.folder}
    </svg>
  );
}
async function request(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw Object.assign(
      new Error(
        body.detail || body.error || "The request could not be completed.",
      ),
      { neutralFallbackAvailable: body.neutralFallbackAvailable === true },
    );
  }
  return response;
}
function Modal({ title, children, close, busy }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.showModal();
    return () => previous?.focus?.();
  }, []);
  return (
    <dialog
      ref={ref}
      className="ws-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <div className="ws-dialog-heading">
        <h2>{title}</h2>
        <button
          className="ws-icon-button"
          aria-label="Close dialog"
          disabled={busy}
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function profileLabel(descriptor) {
  const ids = descriptor?.profiles?.map((profile) => profile.profileId) || [
    descriptor?.profileId || "neutral",
  ];
  const labels = {
    neutral: "Language-neutral",
    "nl-BE": "Dutch · Belgium",
    "nl-NL": "Dutch · Netherlands",
    "en-GB": "English · United Kingdom",
    "en-US": "English · United States",
  };
  return ids.map((id) => labels[id] || id).join(" + ");
}
function dateLabel(value) {
  return value
    ? new Date(value).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : "";
}
export default function Workspace({ Editor, kind }) {
  const isSub = kind === "subannotate";
  const isCurate = kind === "curate";
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [initialSource, setInitialSource] = useState(() => {
    try {
      return kind === "subannotate"
        ? JSON.parse(
            new URLSearchParams(location.search).get("source") || "null",
          )
        : null;
    } catch {
      return null;
    }
  });
  const [workspace, setWorkspace] = useState(null);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return (
        localStorage.getItem(`meddeid.${kind}.workspaceCollapsed`) !== "false"
      );
    } catch {
      return true;
    }
  });
  function toggleWorkspace() {
    setCollapsed((previous) => {
      const next = !previous;
      try {
        localStorage.setItem(
          `meddeid.${kind}.workspaceCollapsed`,
          String(next),
        );
      } catch {
        /* optional preference */
      }
      return next;
    });
  }
  const [activeId, setActiveId] = useState(
    () => new URLSearchParams(location.search).get("assignment") || "",
  );
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const [removal, setRemoval] = useState(null);
  const [details, setDetails] = useState(null);
  const [file, setFile] = useState(null);
  const [dataset, setDataset] = useState("");
  const [name, setName] = useState("");
  const [split, setSplit] = useState("");
  const [busy, setBusy] = useState("");
  const [neutralAvailable, setNeutralAvailable] = useState(false);
  const [allowNeutralProfile, setAllowNeutralProfile] = useState(false);
  useEffect(() => {
    setNeutralAvailable(false);
    setAllowNeutralProfile(false);
    setError("");
  }, [file, dataset, name, split, importOpen]);
  const [review, setReview] = useState({
    dirty: false,
    saving: false,
    reviewed: 0,
    total: 0,
  });
  const editorState = useRef({});
  const [switchTarget, setSwitchTarget] = useState(null);
  const receiveState = useCallback((state) => {
    editorState.current = state;
    setReview((prev) =>
      ["dirty", "saving", "reviewed", "total", "failed", "revision"].every(
        (key) => prev[key] === state[key],
      )
        ? prev
        : state,
    );
  }, []);
  const refresh = useCallback(async () => {
    const payload = await (await request("/api/workspace")).json();
    setWorkspace(payload);
    return payload;
  }, []);
  useEffect(() => {
    refresh().catch((err) => setError(err.message));
  }, [refresh]);
  useEffect(() => {
    let collapseTimer;
    function beforeUnload(event) {
      if (editorState.current.dirty || editorState.current.saving) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    function collapseOutsideWorkspace(event) {
      if (!activeId || collapsed) return;
      // Keep controls and their dialogs usable. Wait for a click (rather than
      // pointerdown) so the layout stays still during text selection/dragging.
      const insideWorkspace = event
        .composedPath()
        .some(
          (node) =>
            node instanceof Element &&
            node.matches(
              ".ws-header, .ws-context, .ws-editor-toggle, .ws-dialog",
            ),
        );
      if (insideWorkspace) return;
      // Let the editor receive this click before changing its layout. A timer
      // runs after event propagation; synchronously collapsing in capture can
      // consume the native editor's delegated React click handler.
      clearTimeout(collapseTimer);
      collapseTimer = setTimeout(() => {
        setCollapsed(true);
        try {
          localStorage.setItem(`meddeid.${kind}.workspaceCollapsed`, "true");
        } catch {
          /* optional preference */
        }
      }, 0);
    }
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", collapseOutsideWorkspace, true);
    return () => {
      clearTimeout(collapseTimer);
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", collapseOutsideWorkspace, true);
    };
  }, [activeId, collapsed, kind]);
  useEffect(() => {
    if (isCurate && review.revision)
      refresh().catch((err) => setError(err.message));
  }, [isCurate, review.revision, refresh]);
  const assignments = workspace?.assignments || [];
  const active = assignments.find((entry) => entry.id === activeId);
  function navigate(id) {
    setActiveId(id);
    setError("");
    setNotice("");
    setSwitchTarget(null);
    editorState.current = {};
    setReview({ dirty: false, saving: false, reviewed: 0, total: 0 });
    const url = new URL(location.href);
    if (id) url.searchParams.set("assignment", id);
    else url.searchParams.delete("assignment");
    // Replace rather than push: browser Back never discards an editor draft.
    history.replaceState(null, "", url);
    refresh().catch((err) => setError(err.message));
  }
  function finishSwitch(target) {
    if (typeof target === "string") navigate(target);
    else location.assign(target.url);
  }
  function requestSwitch(target) {
    if (editorState.current.saving) {
      setError("Please wait for the current save to finish.");
      return;
    }
    if (editorState.current.dirty) {
      setSwitchTarget(target);
      return;
    }
    finishSwitch(target);
  }
  function switchAssignment(id) {
    if (id !== activeId) requestSwitch(id);
  }
  async function saveAndSwitch() {
    setBusy("switch");
    setError("");
    try {
      if (!(await editorState.current.save?.()))
        throw new Error(
          "Some changes could not be saved. Return to the editor to resolve them.",
        );
      // The save has finished; the unload guard must see that before navigation.
      editorState.current = {
        ...editorState.current,
        dirty: false,
        saving: false,
      };
      finishSwitch(switchTarget);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }
  async function importFile(event) {
    event.preventDefault();
    setBusy("import");
    setError("");
    try {
      if (!file) throw new Error("Choose a JSONL file first.");
      if (file.size > 20 * 1024 * 1024)
        throw new Error("Choose a file smaller than 20 MB.");
      const payload = await (
        await request("/api/workspace/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            allowNeutralProfile,
            content: await file.text(),
            filename: file.name,
            dataset,
            name,
            split,
          }),
        })
      ).json();
      await refresh();
      setImportOpen(false);
      setFile(null);
      setDataset("");
      setName("");
      setSplit("");
      navigate(payload.assignment.id);
    } catch (err) {
      setNeutralAvailable(err.neutralFallbackAvailable === true);
      setError(err.message);
    } finally {
      setBusy("");
    }
  }
  async function showStorage(assignment = active) {
    setError("");
    if (assignment) {
      try {
        const payload = await (
          await request(`/api/assignments/${assignment.id}/details`)
        ).json();
        setDetails(payload.assignment);
      } catch (err) {
        setError(err.message);
        return;
      }
    } else setDetails(null);
    setStorageOpen(true);
  }
  async function exportBundle() {
    setError("");
    setNotice("");
    setBusy("export");
    try {
      if (editorState.current.dirty || editorState.current.saving)
        throw new Error("Save your changes before downloading a bundle.");
      const response = await request(`/api/assignments/${activeId}/export`, {
        method: "POST",
        headers: { "X-Workspace-Revision": active.sourceRevision || "initial" },
      });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download =
        response.headers
          .get("Content-Disposition")
          ?.match(/filename="([^"]+)"/)?.[1] || `${kind}-bundle.zip`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setNotice(
        "Bundle downloaded. A copy is also saved in this assignment’s exports folder.",
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }
  if (workspace?.mode === "legacy") return <Editor />;
  if (!workspace)
    return (
      <div className="ws-loading">
        {error || "Opening your workspace…"}
        {error && (
          <button
            onClick={() => refresh().catch((err) => setError(err.message))}
          >
            Retry
          </button>
        )}
      </div>
    );
  const filtered = assignments.filter(
    (entry) =>
      (!query ||
        `${entry.dataset} ${entry.name}`
          .toLowerCase()
          .includes(query.toLowerCase())) &&
      (filter === "all" ||
        (filter === "completed" ? entry.complete : !entry.complete)),
  );
  const companion = import.meta.env.VITE_WORKSPACE_COMPANION_URL;
  const appUrls = {
    annotate:
      kind === "annotate"
        ? location.origin
        : import.meta.env.VITE_WORKSPACE_ANNOTATE_URL || companion,
    curate: isCurate
      ? location.origin
      : import.meta.env.VITE_WORKSPACE_CURATE_URL,
    subannotate: isSub
      ? location.origin
      : import.meta.env.VITE_WORKSPACE_SUBANNOTATE_URL ||
        (kind === "annotate" ? companion : ""),
  };
  const subUrl = appUrls.subannotate;
  async function continueInSubannotate() {
    setError("");
    try {
      if (review.dirty || review.saving)
        throw new Error("Finish saving before continuing.");
      const catalog = await (await request("/api/workspace/sources")).json();
      const source = isCurate
        ? (await (await request(`/api/assignments/${activeId}/details`)).json())
            .assignment.latestResult
        : catalog.sources.find(
            (s) => s.kind === "annotate" && s.id === activeId,
          );
      if (!source)
        throw new Error(
          isCurate
            ? "Publish the current curation first."
            : "Review every document before starting detailed review.",
        );
      const target = new URL(subUrl);
      target.searchParams.set("source", JSON.stringify(source));
      location.href = target.href;
    } catch (err) {
      setError(err.message);
    }
  }
  function closeSource() {
    setSourceOpen(false);
    setInitialSource(null);
    const url = new URL(location.href);
    url.searchParams.delete("source");
    history.replaceState(null, "", url);
  }
  return (
    <div
      className={`ws-shell ${active ? "ws-editing" : ""} ${active && collapsed ? "ws-collapsed" : ""}`}
    >
      <header className="ws-header" hidden={!!active && collapsed}>
        <button
          className="ws-brand"
          onClick={() => switchAssignment("")}
          aria-label="MedDeID workspace"
        >
          <span className="ws-mark">
            m<span>·</span>
          </span>
          <strong>MedDeID</strong>
        </button>
        <nav className="ws-app-nav" aria-label="Applications">
          {[
            ["annotate", "Annotate"],
            ["curate", "Curate"],
            ["subannotate", "Subannotate"],
          ]
            .filter(([app]) => appUrls[app])
            .map(([app, label]) => (
              <a
                key={app}
                href={appUrls[app]}
                className="ws-app-link"
                aria-current={app === kind ? "page" : undefined}
                onClick={(event) => {
                  // Preserve deliberate browser gestures such as Cmd/Ctrl-click.
                  if (
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey ||
                    event.button !== 0
                  )
                    return;
                  event.preventDefault();
                  if (app === kind) switchAssignment("");
                  else requestSwitch({ url: appUrls[app] });
                }}
              >
                {label}
              </a>
            ))}
        </nav>
        <button className="ws-local" onClick={() => showStorage()}>
          <span /> Local workspace <Icon name="folder" size={16} />
        </button>
      </header>
      {active ? (
        <>
          <div
            className="ws-context"
            id="workspace-controls"
            hidden={collapsed}
          >
            <button
              className="ws-button ws-secondary"
              onClick={() => switchAssignment("")}
            >
              <Icon name="grid" size={17} />{" "}
              {isCurate ? "All comparisons" : "All assignments"}
            </button>
            <div className="ws-context-selection">
              <span>
                {isCurate ? "DATASET / COMPARISON" : "DATASET / ASSIGNMENT"}
              </span>
              <select
                aria-label="Switch assignment"
                value={activeId}
                onChange={(event) => switchAssignment(event.target.value)}
              >
                {assignments
                  .filter((entry) => !entry.error)
                  .map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.dataset} / {entry.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="ws-save-status" aria-live="polite">
              <span
                className={
                  review.dirty || review.saving
                    ? "ws-pending-dot"
                    : "ws-saved-dot"
                }
              />
              {review.saving
                ? "Saving changes…"
                : review.failed
                  ? "Save failed — retry in editor"
                  : review.dirty
                    ? "Unsaved changes"
                    : "All changes saved"}
            </div>
            <button
              className="ws-button ws-secondary"
              onClick={() => showStorage()}
            >
              Files & results
            </button>
            {!isSub && subUrl && (
              <button
                className="ws-button ws-secondary"
                disabled={!!busy || review.dirty || review.saving}
                onClick={continueInSubannotate}
              >
                Continue in Subannotate <Icon name="arrow" size={17} />
              </button>
            )}
            <button
              className="ws-button ws-primary"
              disabled={!!busy || review.dirty || review.saving}
              onClick={exportBundle}
            >
              <Icon name="download" size={17} />
              {busy === "export" ? "Preparing…" : "Export bundle"}
            </button>
            <button
              className="ws-icon-button ws-collapse-action"
              aria-label="Collapse workspace controls"
              title="Collapse workspace controls"
              onClick={toggleWorkspace}
            >
              <Icon name="close" size={18} />
            </button>
          </div>
          {notice && (
            <div className="ws-notice" role="status">
              {notice}
              <button
                aria-label="Dismiss notification"
                onClick={() => setNotice("")}
              >
                ×
              </button>
            </div>
          )}
          {error && switchTarget === null && !storageOpen && (
            <div className="ws-error" role="alert">
              {error}
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                ×
              </button>
            </div>
          )}
          <div className="ws-editor">
            <Editor
              key={`${activeId}:${editorEpoch}`}
              apiRoot={`/api/assignments/${activeId}`}
              assignmentId={activeId}
              workspaceMetadata={active}
              sourceUpdateControl={
                (isSub || isCurate) && (
                  <WorkspaceUpdates
                    key={`${activeId}:${editorEpoch}`}
                    assignment={active}
                    kind={kind}
                    review={review}
                    beforePreview={async () => {
                      if (editorState.current.saving)
                        throw Error("Wait for the current save to finish.");
                      if (
                        editorState.current.dirty &&
                        !(await editorState.current.save?.())
                      )
                        throw Error(
                          "Save your current changes before updating.",
                        );
                    }}
                    onUpdated={async (report) => {
                      try {
                        if (isSub && report?.affectedItemIds?.length)
                          localStorage.setItem(
                            `meddeid.subannotate.${activeId}.position`,
                            report.affectedItemIds[0],
                          );
                        if (isCurate && report?.affectedDocumentIds?.length) {
                          localStorage.setItem(
                            `meddeid.curate.${activeId}.document`,
                            report.affectedDocumentIds[0],
                          );
                          localStorage.setItem(
                            `meddeid.curate.${activeId}.filter`,
                            "pending",
                          );
                        }
                      } catch {}
                      await refresh();
                      setEditorEpoch((n) => n + 1);
                      setDetails(null);
                      setReview({
                        dirty: false,
                        saving: false,
                        reviewed: 0,
                        total: 0,
                      });
                      setNotice(
                        "Review loaded. Compatible work was preserved; check the remaining unconfirmed items.",
                      );
                    }}
                  />
                )
              }
              onWorkspaceState={receiveState}
              onWorkspaceHome={() => switchAssignment("")}
              workspaceControl={
                <button
                  type="button"
                  className="ws-editor-toggle"
                  onClick={toggleWorkspace}
                  aria-expanded={!collapsed}
                  aria-controls="workspace-controls"
                  aria-label={
                    collapsed
                      ? "Show workspace controls"
                      : "Hide workspace controls"
                  }
                  title={`${active.dataset} / ${active.name} — ${review.saving ? "Saving" : review.dirty ? "Unsaved changes" : "All changes saved"}`}
                >
                  <Icon name="grid" size={15} />
                  <span>Workspace</span>
                  <span
                    className={
                      review.dirty || review.saving
                        ? "ws-pending-dot"
                        : "ws-saved-dot"
                    }
                  />
                </button>
              }
            />
          </div>
        </>
      ) : (
        <main className="ws-library">
          <div className="ws-hero">
            <div>
              <p className="ws-eyebrow">
                YOUR{" "}
                {isCurate
                  ? "CURATION"
                  : isSub
                    ? "DETAILED REVIEW"
                    : "ANNOTATION"}{" "}
                WORKSPACE
              </p>
              <h1>Pick up where you left off.</h1>
              <p>
                {isCurate
                  ? "Choose a saved comparison or start from completed reviewers."
                  : "Choose an assignment or bring in a new dataset."}
                <br />
                Your documents and progress stay together.
              </p>
            </div>
            <div className="ws-library-actions">
              {isSub && (
                <button
                  className="ws-button ws-primary"
                  onClick={() => setSourceOpen(true)}
                >
                  From workspace <Icon name="arrow" size={18} />
                </button>
              )}
              <button
                className="ws-button ws-primary ws-import-trigger"
                onClick={() => {
                  setError("");
                  isCurate ? setSourceOpen(true) : setImportOpen(true);
                }}
              >
                <Icon name="upload" size={18} />{" "}
                {isCurate ? "New comparison" : "Import dataset"}
              </button>
            </div>
          </div>
          {error && !importOpen && (
            <div className="ws-error" role="alert">
              {error}
            </div>
          )}
          {activeId && !active && (
            <div className="ws-error">
              This assignment is unavailable in this workspace. Choose one
              below.
            </div>
          )}
          <div className="ws-library-toolbar">
            <div className="ws-tabs" aria-label="Filter assignments">
              {[
                ["all", isCurate ? "All comparisons" : "All assignments"],
                ["in_progress", "In progress"],
                ["completed", "Completed"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  aria-pressed={filter === value}
                  className={filter === value ? "active" : ""}
                  onClick={() => setFilter(value)}
                >
                  {label}
                  {value === "all" && <span>{assignments.length}</span>}
                </button>
              ))}
            </div>
            <label className="ws-search">
              <Icon name="search" size={17} />
              <input
                aria-label="Search assignments"
                placeholder="Find a dataset or assignment"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
          <div className="ws-cards">
            {filtered.map((entry) => (
              <article className="ws-card" key={entry.id}>
                <div className="ws-card-top">
                  <span className="ws-folder">
                    <Icon name="folder" size={23} />
                  </span>
                  <span
                    className={`ws-badge ${entry.complete ? "complete" : ""}`}
                  >
                    {entry.error
                      ? "Needs attention"
                      : entry.complete
                        ? "Completed"
                        : "In progress"}
                  </span>
                </div>
                <p className="ws-dataset">{entry.dataset}</p>
                <h2>{entry.name}</h2>
                {entry.error ? (
                  <p className="ws-error">{entry.error}</p>
                ) : (
                  <>
                    <p className="ws-card-meta">
                      {entry.documents} documents
                      {entry.split ? ` · ${entry.split}` : ""}
                      {entry.languages?.length
                        ? ` · ${entry.languages.join(", ")}`
                        : ""}
                    </p>
                    <div className="ws-progress-copy">
                      <span>
                        {entry.reviewed} of {entry.total} {entry.unit} reviewed
                      </span>
                      <strong>
                        {entry.total
                          ? Math.round((entry.reviewed / entry.total) * 100)
                          : 100}
                        %
                      </strong>
                    </div>
                    <progress
                      value={entry.reviewed}
                      max={entry.total || 1}
                      aria-label={`${entry.name} review progress`}
                    />
                  </>
                )}
                <div className="ws-card-bottom">
                  <span>Saved {dateLabel(entry.updatedAt)}</span>
                  <button
                    disabled={!!entry.error}
                    onClick={() => navigate(entry.id)}
                  >
                    {entry.complete
                      ? isCurate
                        ? "Open comparison"
                        : "Open assignment"
                      : "Continue reviewing"}
                    <Icon name="arrow" size={17} />
                  </button>
                </div>
              </article>
            ))}
          </div>
          {!filtered.length && (
            <div className="ws-empty">
              <Icon name="folder" size={36} />
              <h2>
                {assignments.length
                  ? "No matching assignments"
                  : "Your first assignment starts here"}
              </h2>
              <p>
                {assignments.length
                  ? "Try another search or filter."
                  : isCurate
                    ? "Select completed reviewer assignments. Each comparison keeps its own progress."
                    : isSub
                      ? "Import completed primary annotations to start detailed review."
                      : "Import annotation-ready JSONL, with or without suggested spans."}
              </p>
              {!assignments.length && (
                <button
                  className="ws-button ws-primary"
                  onClick={() =>
                    isCurate || isSub
                      ? setSourceOpen(true)
                      : setImportOpen(true)
                  }
                >
                  {isCurate
                    ? "New comparison"
                    : isSub
                      ? "From workspace"
                      : "Import dataset"}
                </button>
              )}
            </div>
          )}
          <section className="ws-explainer">
            <div>
              <span className="ws-step">01</span>
              <div>
                <h3>Import once</h3>
                <p>Your source is kept alongside a separate working copy.</p>
              </div>
            </div>
            <div>
              <span className="ws-step">02</span>
              <div>
                <h3>Switch freely</h3>
                <p>Every assignment keeps its own progress and place.</p>
              </div>
            </div>
            <div>
              <span className="ws-step">03</span>
              <div>
                <h3>
                  {isSub ? "Keep the whole result" : "Continue in the next app"}
                </h3>
                <p>
                  {isSub
                    ? "Export your completed result when you need to share it."
                    : "Select saved results directly. Download bundles only when you need a portable copy."}
                </p>
              </div>
            </div>
          </section>
          <footer className="ws-footer">
            <span>
              <span className="ws-saved-dot" /> Saved in your local workspace
            </span>
            <button onClick={() => showStorage(null)}>
              View storage location <Icon name="arrow" size={14} />
            </button>
          </footer>
        </main>
      )}
      {(sourceOpen || (initialSource && !activeId)) && (
        <SourcePicker
          kind={kind}
          initialSource={initialSource}
          assignments={assignments}
          close={closeSource}
          created={(id) => {
            closeSource();
            navigate(id);
          }}
          resume={(id) => {
            closeSource();
            navigate(id);
          }}
        />
      )}
      {importOpen && (
        <Modal
          title="Import a dataset"
          close={() => {
            setImportOpen(false);
            setError("");
          }}
          busy={!!busy}
        >
          <p className="ws-dialog-intro">
            {isSub
              ? "Start from completed primary annotations. Each import creates a separate detailed-review assignment."
              : "Bring in annotation-ready documents. Each import creates a separate assignment with its own saved work."}
          </p>
          <form onSubmit={importFile}>
            <label className="ws-upload">
              <Icon name="upload" size={28} />
              <strong>{file ? file.name : "Choose your JSONL file"}</strong>
              <span>
                {isSub
                  ? "Completed annotations · up to 20 MB"
                  : "With or without model suggestions · up to 20 MB"}
              </span>
              <input
                aria-label="Dataset JSONL file"
                type="file"
                accept=".jsonl,application/json"
                required
                onChange={(event) => {
                  const selected = event.target.files?.[0];
                  setFile(selected || null);
                  if (selected && !dataset)
                    setDataset(
                      selected.name
                        .replace(/\.jsonl$/i, "")
                        .replace(/[-_]/g, " "),
                    );
                  if (!name) setName(isSub ? "Detailed review" : "Reviewer A");
                }}
              />
            </label>
            <label className="ws-field">
              Dataset name
              <input
                required
                maxLength={120}
                value={dataset}
                onChange={(event) => setDataset(event.target.value)}
                placeholder="e.g. Hospital study"
              />
            </label>
            <label className="ws-field">
              Assignment name
              <input
                required
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={
                  isSub ? "e.g. Detailed review" : "e.g. Training · Reviewer A"
                }
              />
            </label>
            <label className="ws-field">
              Split (optional)
              <input
                maxLength={80}
                value={split}
                onChange={(event) => setSplit(event.target.value)}
                placeholder="Training, validation, test…"
              />
            </label>
            <p className="ws-import-note">
              <Icon name="check" size={16} /> Your source file stays unchanged.
              Your edits are saved in this workspace.
            </p>
            {error && (
              <div className="ws-error" role="alert">
                {error}
              </div>
            )}
            {isSub && neutralAvailable && (
              <label className="ws-permanent-check">
                <input
                  type="checkbox"
                  checked={allowNeutralProfile}
                  disabled={!!busy}
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
                disabled={!!busy}
                onClick={() => {
                  setImportOpen(false);
                  setError("");
                }}
              >
                Cancel
              </button>
              <button
                className="ws-button ws-primary"
                disabled={!!busy || (neutralAvailable && !allowNeutralProfile)}
              >
                {busy === "import"
                  ? "Preparing assignment…"
                  : "Import & open assignment"}
                <Icon name="arrow" size={17} />
              </button>
            </div>
          </form>
        </Modal>
      )}
      {removal && (
        <WorkspaceRemoval
          kind={kind}
          assignmentId={removal.id}
          close={() => setRemoval(null)}
          onChanged={async ({ action, id }) => {
            if (action === "trash" && id === activeId) {
              navigate("");
              setStorageOpen(false);
              setDetails(null);
            }
            await refresh();
          }}
        />
      )}
      {storageOpen && (
        <Modal
          title={details ? "Files & results" : "Workspace storage"}
          close={() => {
            setStorageOpen(false);
            setError("");
          }}
          busy={false}
        >
          <p className="ws-dialog-intro">
            {details
              ? `${details.dataset} / ${details.name}`
              : "All imported datasets and saved assignments are kept in this folder."}
          </p>
          {isSub && details && (
            <p className="ws-small">
              <strong>Suggestion profile: </strong>
              {details.suggestionProfile
                ? `${profileLabel(details.suggestionProfile.descriptor)} · ${details.suggestionProfile.origin === "project-language" ? "inherited from project" : "explicit neutral fallback"} · pinned for this review`
                : `${profileLabel(details.profileDescriptor)} · existing review configuration`}
            </p>
          )}
          {details && (
            <>
              <div className="ws-file-summary">
                <span
                  className={`ws-badge ${details.complete ? "complete" : ""}`}
                >
                  {details.complete ? "Completed" : "In progress"}
                </span>
                <span>
                  {details.reviewed} of {details.total} {details.unit} reviewed
                </span>
              </div>
              <h3>
                {isCurate
                  ? details.complete
                    ? "Finalized result"
                    : "Saved comparison"
                  : "Current annotations"}
              </h3>
              <code className="ws-path">{details.outputPath}</code>
              <p className="ws-small">
                {isSub
                  ? "Detailed labels are saved separately from your primary annotations."
                  : "This working copy contains your saved changes. The original import is preserved."}
              </p>
            </>
          )}
          {details?.inputSources?.length > 0 && (
            <>
              <h3>Frozen reviewer inputs</h3>
              {details.inputSources.map((source) => (
                <p className="ws-small" key={source.id}>
                  {source.dataset} / {source.name} · version{" "}
                  {source.sha256.slice(0, 8)}
                </p>
              ))}
            </>
          )}
          {details?.inputSource && (
            <>
              <h3>Input version</h3>
              <p className="ws-small">
                {details.inputSource.dataset} / {details.inputSource.name} ·
                version {details.inputSource.sha256.slice(0, 8)}
              </p>
            </>
          )}
          {!!details?.results?.length && (
            <>
              <h3>Preserved final versions</h3>
              {details.results.map((result) => (
                <p className="ws-small" key={result.resultId}>
                  {new Date(result.publishedAt).toLocaleString()} · version{" "}
                  {result.sha256.slice(0, 8)}
                </p>
              ))}
            </>
          )}
          <h3>{details ? "Assignment folder" : "Workspace folder"}</h3>
          <code className="ws-path">
            {details?.storagePath || workspace.storagePath}
          </code>
          <p className="ws-small">
            {details
              ? "The source, working files and downloaded export copies live here."
              : "When using Docker, this is the container path inside your mounted workspace folder."}
          </p>
          {details && (
            <p className="ws-result-note">
              {details.complete
                ? "Your next download includes the completed result and its manifest."
                : "You can download a snapshot now. It will be marked as work in progress until review is complete."}
            </p>
          )}
          <div className="ws-dialog-actions">
            <button
              className="ws-button ws-secondary"
              onClick={() => setStorageOpen(false)}
            >
              Close
            </button>
            {details && active && (
              <button
                className="ws-button ws-primary"
                disabled={!!busy || review.dirty || review.saving}
                onClick={exportBundle}
              >
                <Icon name="download" size={17} />
                {busy === "export" ? "Preparing…" : "Export bundle"}
              </button>
            )}
          </div>
          {details && (isSub || isCurate) && (
            <button
              className="ws-text-button"
              onClick={() => {
                setStorageOpen(false);
                window.dispatchEvent(
                  new CustomEvent("meddeid:source-updates", {
                    detail: activeId,
                  }),
                );
              }}
            >
              Source updates & recovery versions
            </button>
          )}
          <div className="ws-storage-maintenance">
            {details ? (
              <>
                <button
                  className="ws-text-button"
                  onClick={() => setDetails(null)}
                >
                  Workspace storage
                </button>
                <button
                  className="ws-text-danger"
                  disabled={!!busy || review.dirty || review.saving}
                  onClick={() => {
                    setStorageOpen(false);
                    setRemoval({ id: details.id });
                  }}
                >
                  Remove from workspace…
                </button>
                {(review.dirty || review.saving) && (
                  <p className="ws-small">
                    Finish saving your changes before removing this item.
                  </p>
                )}
              </>
            ) : (
              <button
                className="ws-text-button"
                onClick={() => {
                  setStorageOpen(false);
                  setRemoval({});
                }}
              >
                Trash
              </button>
            )}
          </div>
          {notice && (
            <p role="status" className="ws-small">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="ws-error">
              {error}
            </p>
          )}
        </Modal>
      )}
      {switchTarget !== null && (
        <Modal
          title="Save before switching"
          close={() => {
            setSwitchTarget(null);
            setError("");
          }}
          busy={!!busy}
        >
          <p className="ws-dialog-intro">
            Save your changes before switching applications or assignments.
            Saving a draft keeps its existing review status.
          </p>
          {error && (
            <div className="ws-error" role="alert">
              {error}
            </div>
          )}
          <div className="ws-dialog-actions">
            <button
              className="ws-button ws-secondary"
              disabled={!!busy}
              onClick={() => {
                setSwitchTarget(null);
                setError("");
              }}
            >
              Return to editor
            </button>
            <button
              className="ws-button ws-primary"
              disabled={!!busy}
              onClick={saveAndSwitch}
            >
              {busy ? "Saving…" : "Save & switch"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
