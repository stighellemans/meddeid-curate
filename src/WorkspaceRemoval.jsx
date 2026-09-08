import React, { useEffect, useRef, useState } from "react";
async function call(url, body) {
  const response = await fetch(
    url,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.detail || result.error || "The operation failed.");
  return result;
}
const appNames = {
  annotate: "Annotate",
  curate: "Curate",
  subannotate: "Subannotate",
};
export default function WorkspaceRemoval({
  kind,
  assignmentId,
  close,
  onChanged,
}) {
  const dialog = useRef(null);
  const [view, setView] = useState(assignmentId ? "trash" : "list");
  const [selected, setSelected] = useState(assignmentId || "");
  const [info, setInfo] = useState(null);
  const [items, setItems] = useState([]);
  const [name, setName] = useState("");
  const [permanent, setPermanent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current.showModal();
    return () => previous?.focus?.();
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setInfo(null);
    setError("");
    setName("");
    setPermanent(false);
    const url =
      view === "list"
        ? "/api/workspace/trash"
        : view === "trash"
          ? `/api/assignments/${selected}/removal`
          : `/api/workspace/trash/${selected}/removal`;
    call(url)
      .then((result) => {
        if (active) {
          if (view === "list") setItems(result.items);
          else setInfo(result);
        }
      })
      .catch((error) => {
        if (active) setError(error.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [view, selected, revision]);
  async function mutate(action, id = selected) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const url =
        action === "trash"
          ? `/api/assignments/${id}/trash`
          : `/api/workspace/trash/${id}/${action}`;
      await call(url, { confirmName: name, confirmPermanent: permanent });
      await onChanged({ action, id });
      if (action === "trash") {
        close();
        return;
      }
      setNotice(
        action === "restore"
          ? "Restored to the workspace library."
          : "Permanently deleted.",
      );
      setView("list");
      setRevision((n) => n + 1);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  const title =
    view === "list"
      ? `${appNames[kind]} trash`
      : view === "trash"
        ? "Move to trash?"
        : "Permanently delete?";
  return (
    <dialog
      ref={dialog}
      className="ws-dialog ws-source-dialog ws-removal-dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
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
          ×
        </button>
      </div>
      <form
        className="ws-source-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (
            !busy &&
            !loading &&
            info &&
            name === info.assignment.name &&
            (view !== "delete" || permanent)
          )
            mutate(view);
        }}
      >
        <div className="ws-source-body">
          {loading && <p className="ws-small">Loading…</p>}
          {!loading && view === "list" && (
            <>
              <p className="ws-dialog-intro">
                Removed items stay here until you restore or permanently delete
                them. Nothing is automatically emptied.
              </p>
              {!items.length && <p className="ws-small">Trash is empty.</p>}
              {items.map((item) => (
                <article className="ws-trash-item" key={item.id}>
                  <strong>{item.name}</strong>
                  <span>{item.dataset}</span>
                  <small>
                    Removed {new Date(item.removedAt).toLocaleString()}
                  </small>
                  <div className="ws-trash-actions">
                    <button
                      type="button"
                      className="ws-button ws-secondary"
                      disabled={busy}
                      onClick={() => mutate("restore", item.id)}
                    >
                      Restore {item.name}
                    </button>
                    <button
                      type="button"
                      className="ws-text-danger"
                      disabled={busy}
                      onClick={() => {
                        setSelected(item.id);
                        setView("delete");
                        setNotice("");
                      }}
                    >
                      Permanently delete…
                    </button>
                  </div>
                </article>
              ))}
            </>
          )}
          {info && (
            <>
              <p className="ws-dialog-intro">
                <strong>
                  {appNames[kind]} · {info.assignment.dataset} /{" "}
                  {info.assignment.name}
                </strong>
              </p>
              <p className="ws-removal-warning">
                {view === "trash"
                  ? "This removes this item from the active workspace. Its inputs, saved work, exports and finalized versions move to trash together. You can restore the complete item later."
                  : "This permanently deletes this item’s inputs, saved work, exports and finalized versions from trash. This cannot be undone."}
              </p>
              <h3>Known downstream work</h3>
              {info.downstream.length ? (
                <ul className="ws-downstream">
                  {info.downstream.map((item) => (
                    <li key={`${item.kind}:${item.id}`}>
                      {appNames[item.kind]} · {item.dataset} / {item.name}
                      {item.inTrash ? " (in trash)" : ""}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="ws-small">
                  No downstream workspace items reference this input.
                </p>
              )}
              <p className="ws-small">
                Downstream items retain their frozen input copies and saved
                work. Downloaded copies outside this workspace are unaffected.
              </p>
              <label className="ws-field">
                Type “{info.assignment.name}” to confirm
                <input
                  autoComplete="off"
                  disabled={busy}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setError("");
                  }}
                  aria-label="Confirm item name"
                />
              </label>
              {view === "delete" && (
                <label className="ws-permanent-check">
                  <input
                    type="checkbox"
                    checked={permanent}
                    disabled={busy}
                    onChange={(e) => setPermanent(e.target.checked)}
                  />
                  I understand this permanently deletes the item and cannot be
                  undone.
                </label>
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
          {notice && (
            <p className="ws-small" role="status">
              {notice}
            </p>
          )}
          <div className="ws-dialog-actions">
            <button
              type="button"
              className="ws-button ws-secondary"
              disabled={busy}
              onClick={() => (view === "delete" ? setView("list") : close())}
            >
              {view === "list" ? "Close" : "Cancel"}
            </button>
            {view !== "list" && (
              <button
                className="ws-button ws-danger-button"
                disabled={
                  busy ||
                  loading ||
                  !info ||
                  name !== info.assignment.name ||
                  (view === "delete" && !permanent)
                }
              >
                {busy
                  ? "Working…"
                  : view === "trash"
                    ? "Move to trash"
                    : "Delete permanently"}
              </button>
            )}
          </div>
        </div>
      </form>
    </dialog>
  );
}
