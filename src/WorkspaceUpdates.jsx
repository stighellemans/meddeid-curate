import React, { useCallback, useEffect, useRef, useState } from "react";
export default function WorkspaceUpdates({
  assignment,
  kind,
  review,
  beforePreview,
  onUpdated,
}) {
  const revision = useRef(assignment.sourceRevision || "initial");
  const [status, setStatus] = useState(null),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState(null),
    [error, setError] = useState(""),
    [versions, setVersions] = useState(null),
    [view, setView] = useState("update");
  const dialog = useRef(null),
    alive = useRef(true),
    checking = useRef(false);
  const base = `/api/assignments/${assignment.id}/source-update`;
  const call = useCallback(
    async (route = "", body) => {
      const res = await fetch(base + route, {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Workspace-Revision": revision.current,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok)
        throw Error(
          data.error || data.detail || "Could not check source updates.",
        );
      return data;
    },
    [base],
  );
  const check = useCallback(async () => {
    if (checking.current) return;
    checking.current = true;
    try {
      const data = await call();
      if (alive.current) setStatus(data);
    } catch (e) {
      if (alive.current) setStatus({ state: "error", message: e.message });
    } finally {
      checking.current = false;
    }
  }, [call]);
  useEffect(() => {
    alive.current = true;
    check();
    const timer = setInterval(() => {
      if (!document.hidden) check();
    }, 30000);
    const focus = () => check();
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    const show = (e) => {
      if (e.detail === assignment.id) {
        setOpen(true);
        check();
      }
    };
    window.addEventListener("meddeid:source-updates", show);
    return () => {
      alive.current = false;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
      window.removeEventListener("meddeid:source-updates", show);
    };
  }, [check, assignment.id]);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  const stale = status?.revision && status.revision !== revision.current;
  async function prepare(versionId) {
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      await beforePreview();
      const data = await call(
        versionId ? "/restore-preview" : "/preview",
        versionId ? { versionId } : {},
      );
      setPreview(data);
      setView("update");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    setBusy(true);
    setError("");
    try {
      const result = await call("/apply", { token: preview.token });
      await onUpdated(result.report);
    } catch (e) {
      setError(e.message);
      setPreview(null);
      await check();
    } finally {
      setBusy(false);
    }
  }
  async function showHistory() {
    setView("history");
    setPreview(null);
    setError("");
    setBusy(true);
    try {
      setVersions((await call("/history")).versions);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const summary = preview?.report?.summary || {};
  const stats =
    kind === "curate"
      ? [
          ["Documents kept", summary.preservedDocuments],
          ["Documents to review", summary.reviewRequiredDocuments],
          ["Decisions kept", summary.preservedDecisions],
          ["Decisions to review", summary.resetDecisions],
          ["Documents removed", summary.removedDocuments],
        ]
      : [
          ["Confirmed spans kept", summary.confirmedPreserved],
          ["Spans to review", summary.requiresReview],
          ["New spans", summary.newItems],
          ["Previous spans archived", summary.unmatched],
        ];
  const restore = preview?.report?.restore;
  return (
    <>
      <button
        type="button"
        className={`ws-update-control ${status?.state === "available" ? "ws-update-available" : ""}`}
        onClick={() => {
          setView("update");
          setPreview(null);
          setError("");
          setOpen(true);
          check();
          if (
            status?.state === "available" &&
            !stale &&
            !review.dirty &&
            !review.saving
          )
            prepare();
        }}
        title={
          stale
            ? "Review updated in another tab"
            : status?.message || "Check upstream source versions"
        }
        aria-haspopup="dialog"
      >
        {stale
          ? "Review updated"
          : status?.state === "available"
            ? "Newer source available"
            : "Source updates"}
      </button>
      <dialog
        ref={dialog}
        className="ws-dialog ws-source-dialog ws-update-dialog"
        aria-label="Source updates"
        onCancel={(e) => {
          e.preventDefault();
          if (!busy) setOpen(false);
        }}
      >
        <div className="ws-dialog-heading">
          <h2>
            {view === "history"
              ? "Recovery versions"
              : restore
                ? "Restore review version"
                : "Source updates"}
          </h2>
          <button
            className="ws-icon-button"
            aria-label="Close source updates"
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </div>
        <div className="ws-source-form">
          <div className="ws-source-body">
            <p className="ws-dialog-intro">
              {assignment.dataset} / {assignment.name}
            </p>
            {view === "history" ? (
              <>
                <p className="ws-small">
                  Each update retains the previous review. Restoring also saves
                  your current work as a recovery version.
                </p>
                {versions?.length === 0 && <p>No recovery versions yet.</p>}
                {versions?.map((v) => (
                  <div className="ws-update-history" key={v.id}>
                    <span>
                      <strong>{new Date(v.createdAt).toLocaleString()}</strong>
                      <small>{v.label}</small>
                    </span>
                    <button
                      className="ws-button ws-secondary"
                      disabled={busy || review.saving || stale}
                      onClick={() => prepare(v.id)}
                    >
                      Preview restore
                    </button>
                  </div>
                ))}
              </>
            ) : (
              <>
                {stale ? (
                  <p role="status">
                    This review was updated in another tab. Reload the updated
                    review before continuing. Any unsaved draft must be resolved
                    first.
                  </p>
                ) : !preview ? (
                  <p role="status">
                    {status?.message || "Checking the source…"}
                  </p>
                ) : restore ? (
                  <p>
                    Your current work will be saved before restoring the
                    complete review from{" "}
                    {new Date(preview.report.createdAt).toLocaleString()}.
                  </p>
                ) : (
                  <>
                    <div className="ws-update-stats">
                      {stats
                        .filter(
                          ([, value], index) =>
                            value != null && (index < 2 || value > 0),
                        )
                        .map(([label, value]) => (
                          <div key={label}>
                            <strong>{value}</strong>
                            <span>{label}</span>
                          </div>
                        ))}
                    </div>
                    <p className="ws-small">
                      Compatible labels stay in this review. Changed or new
                      content needs review. The current state is retained in
                      Recovery versions.
                    </p>
                    {preview.report.details?.length > 0 && (
                      <details>
                        <summary>
                          See affected documents and spans (
                          {preview.report.details.length})
                        </summary>
                        <ul className="ws-update-details">
                          {preview.report.details.map((d, i) => (
                            <li key={i}>
                              <strong>{d.documentId}</strong> —{" "}
                              {d.reason ||
                                String(d.status || d.action).replaceAll(
                                  "_",
                                  " ",
                                )}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </>
                )}
                {review.saving && (
                  <p className="ws-small">
                    Waiting for your current save to finish…
                  </p>
                )}
                {review.dirty && !stale && (
                  <p className="ws-small">
                    Your current edits will be saved before preparing the
                    preview.
                  </p>
                )}
              </>
            )}
          </div>
          <div className="ws-source-footer">
            {error && (
              <p className="ws-error" role="alert">
                {error}
              </p>
            )}
            <div className="ws-dialog-actions">
              {view === "history" ? (
                <button
                  className="ws-button ws-secondary"
                  disabled={busy}
                  onClick={() => {
                    setView("update");
                    setError("");
                  }}
                >
                  Back
                </button>
              ) : (
                <button
                  className="ws-text-button"
                  disabled={busy}
                  onClick={showHistory}
                >
                  Recovery versions
                </button>
              )}
              {view !== "history" && (
                <>
                  {stale ? (
                    <button
                      className="ws-button ws-primary"
                      disabled={busy || review.dirty || review.saving}
                      onClick={() => onUpdated()}
                    >
                      Reload updated review
                    </button>
                  ) : preview ? (
                    <button
                      className="ws-button ws-primary"
                      disabled={busy || review.dirty || review.saving}
                      onClick={apply}
                    >
                      {busy
                        ? "Updating…"
                        : restore
                          ? "Restore this version"
                          : "Update this review"}
                    </button>
                  ) : status?.state === "available" ? (
                    <button
                      className="ws-button ws-primary"
                      disabled={busy || review.saving}
                      onClick={() => prepare()}
                    >
                      {busy
                        ? "Preparing…"
                        : review.dirty
                          ? "Save & preview update"
                          : "Preview update"}
                    </button>
                  ) : (
                    <button
                      className="ws-button ws-secondary"
                      disabled={busy}
                      onClick={check}
                    >
                      Check again
                    </button>
                  )}
                </>
              )}
              <button
                className="ws-button ws-secondary"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </dialog>
    </>
  );
}
