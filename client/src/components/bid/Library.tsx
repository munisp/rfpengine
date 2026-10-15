import { type FormEvent, useEffect, useMemo, useState } from "react";
import {
  BookOpenCheck,
  FileText,
  FileWarning,
  Filter,
  Link2,
  Plus,
  Save,
  Search,
  ShieldAlert,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import {
  type EvidenceDocument,
  type Workspace,
  type WorkspaceData,
} from "@shared/bid";
import { Modal, PageHead, PanelTitle } from "./ui";

export type LibraryProps = {
  workspace: Workspace;
  onChange: (data: WorkspaceData) => void;
  onSave: () => void;
  saving: boolean;
  onImport: () => void;
  onReuse: () => void;
  search: string;
};

type RemovedDocument = { document: EvidenceDocument; index: number };
type NoteDraft = { name: string; category: string; text: string };

const emptyNote: NoteDraft = { name: "", category: "Knowledge note", text: "" };

function localId() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isSolicitation(document: EvidenceDocument) {
  return document.category.trim().toLowerCase() === "solicitation";
}

function isTextDocument(document: EvidenceDocument) {
  return document.name.trim().toLowerCase().endsWith(".txt");
}

function timestampLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "Date not recorded";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: value.includes("T") ? "numeric" : undefined,
    minute: value.includes("T") ? "2-digit" : undefined,
  }).format(date);
}

export function Library({
  workspace,
  onChange,
  onSave,
  saving,
  onImport,
  onReuse,
  search,
}: LibraryProps) {
  const [documents, setDocuments] = useState<EvidenceDocument[]>(
    workspace.data.documents
  );
  const [selectedId, setSelectedId] = useState<string>(
    workspace.data.documents[0]?.id ?? ""
  );
  const [category, setCategory] = useState("All");
  const [libraryQuery, setLibraryQuery] = useState("");
  const [removedDocuments, setRemovedDocuments] = useState<RemovedDocument[]>(
    []
  );
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState<NoteDraft>(emptyNote);

  useEffect(() => {
    setDocuments(workspace.data.documents);
    setSelectedId(workspace.data.documents[0]?.id ?? "");
    setCategory("All");
    setLibraryQuery("");
    setRemovedDocuments([]);
  }, [workspace.id]);

  useEffect(() => {
    setDocuments(workspace.data.documents);
    setSelectedId(id =>
      workspace.data.documents.some(document => document.id === id)
        ? id
        : (workspace.data.documents[0]?.id ?? "")
    );
  }, [workspace.version]);

  const categories = useMemo(
    () => [
      "All",
      ...Array.from(new Set(documents.map(document => document.category))).sort(
        (a, b) => a.localeCompare(b)
      ),
    ],
    [documents]
  );
  const globalQuery = search.trim().toLowerCase();
  const query = libraryQuery.trim().toLowerCase();
  const filteredDocuments = useMemo(
    () =>
      documents.filter(document => {
        const matchesCategory =
          category === "All" || document.category === category;
        const haystack =
          `${document.name} ${document.category} ${document.text}`.toLowerCase();
        return (
          matchesCategory &&
          (!globalQuery || haystack.includes(globalQuery)) &&
          (!query || haystack.includes(query))
        );
      }),
    [category, documents, globalQuery, query]
  );
  const selectedDocument =
    documents.find(document => document.id === selectedId) ??
    filteredDocuments[0];

  const saveDocuments = (next: EvidenceDocument[]) => {
    setDocuments(next);
    onChange({ ...workspace.data, documents: next });
  };

  const updateDocument = <K extends keyof EvidenceDocument>(
    id: string,
    key: K,
    value: EvidenceDocument[K]
  ) => {
    const next = documents.map(document =>
      document.id === id ? { ...document, [key]: value } : document
    );
    saveDocuments(next);
  };

  const removeDocument = (document: EvidenceDocument) => {
    const index = documents.findIndex(entry => entry.id === document.id);
    const next = documents.filter(entry => entry.id !== document.id);
    setRemovedDocuments(removed => [...removed, { document, index }]);
    saveDocuments(next);
    setSelectedId(next[Math.max(0, index - 1)]?.id ?? next[0]?.id ?? "");
  };

  const undoRemove = () => {
    const mostRecent = removedDocuments.at(-1);
    if (!mostRecent) return;
    const next = [...documents];
    next.splice(
      Math.min(mostRecent.index, next.length),
      0,
      mostRecent.document
    );
    saveDocuments(next);
    setSelectedId(mostRecent.document.id);
    setRemovedDocuments(removed => removed.slice(0, -1));
  };

  const addKnowledgeNote = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = note.name.trim() || "Untitled knowledge note";
    const filename = title.toLowerCase().endsWith(".txt")
      ? title
      : `${title}.txt`;
    const created: EvidenceDocument = {
      id: localId(),
      name: filename,
      category: note.category,
      text: note.text,
      approved: false,
      uploadedAt: new Date().toISOString(),
    };
    saveDocuments([...documents, created]);
    setSelectedId(created.id);
    setNote(emptyNote);
    setNoteOpen(false);
  };

  return (
    <>
      <PageHead
        eyebrow="EVIDENCE LIBRARY"
        title="Ground every claim in a source"
        description="Review usable source text, distinguish solicitation references from approved evidence, and preserve the citation trail."
        action={
          <div className="page-head-actions">
            <button className="button secondary" onClick={onReuse}>
              <BookOpenCheck size={16} />
              Reuse approved content
            </button>
            <button
              className="button secondary"
              type="button"
              onClick={onImport}
            >
              <Upload size={16} />
              Import evidence
            </button>
            <button
              className="button primary"
              type="button"
              onClick={onSave}
              disabled={saving}
            >
              <Save size={16} />
              {saving ? "Saving…" : "Save library"}
            </button>
          </div>
        }
      />

      <div className="library-notice" role="note">
        <ShieldAlert size={17} />
        <p>
          <strong>Approval is claim-specific.</strong> Solicitation documents
          remain reference sources and can never be approved as evidence for a
          claim.
        </p>
      </div>

      <section
        className="panel library-panel"
        aria-labelledby="library-heading"
      >
        <PanelTitle
          title="Evidence sources"
          subtitle="Select a source to inspect its citation, extracted text, and review status."
          action={
            <div className="library-panel-actions">
              <button
                className="button secondary"
                type="button"
                onClick={() => setNoteOpen(true)}
              >
                <Plus size={15} />
                Add knowledge note
              </button>
              {removedDocuments.length > 0 && (
                <button
                  className="button secondary"
                  type="button"
                  onClick={undoRemove}
                >
                  <Undo2 size={15} />
                  Undo remove
                </button>
              )}
            </div>
          }
        />

        <div className="library-toolbar">
          <label className="field library-search-field">
            <span className="visually-hidden">Search evidence library</span>
            <Search size={16} />
            <input
              className="input"
              value={libraryQuery}
              onChange={event => setLibraryQuery(event.target.value)}
              placeholder="Search source name or extracted text"
            />
          </label>
          <label className="field category-filter">
            <span>
              <Filter size={15} />
              Category
            </span>
            <select
              className="input"
              value={category}
              onChange={event => setCategory(event.target.value)}
            >
              {categories.map(entry => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
        </div>
        {search.trim() && (
          <p className="library-search-context">
            Also filtered by workspace search:{" "}
            <strong>“{search.trim()}”</strong>
          </p>
        )}

        <div className="library-layout">
          <div className="document-list" aria-label="Evidence sources">
            {filteredDocuments.map(document => {
              const selected = document.id === selectedDocument?.id;
              const solicitation = isSolicitation(document);
              return (
                <button
                  key={document.id}
                  className={`library-document-card ${selected ? "selected" : ""}`}
                  type="button"
                  onClick={() => setSelectedId(document.id)}
                  aria-pressed={selected}
                >
                  <span className="document-icon">
                    <FileText size={19} />
                  </span>
                  <span className="document-card-content">
                    <span className="document-card-top">
                      <strong>{document.name}</strong>
                      <span
                        className={`document-status ${solicitation ? "reference-only" : document.approved ? "approved" : "unapproved"}`}
                      >
                        {solicitation
                          ? "Reference only"
                          : document.approved
                            ? "Approved"
                            : "Review needed"}
                      </span>
                    </span>
                    <small>
                      {document.category} <i />{" "}
                      {timestampLabel(document.uploadedAt)}
                    </small>
                  </span>
                </button>
              );
            })}
            {!filteredDocuments.length && (
              <div className="library-empty-state">
                <FileWarning size={23} />
                <h3>No sources match these filters</h3>
                <p>
                  Try another category or search term, or add a local knowledge
                  note.
                </p>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => {
                    setCategory("All");
                    setLibraryQuery("");
                  }}
                >
                  Clear library filters
                </button>
              </div>
            )}
          </div>

          <article className="document-detail" aria-live="polite">
            {selectedDocument ? (
              <>
                <header className="document-detail-header">
                  <div>
                    <span className="eyebrow">
                      {selectedDocument.category.toUpperCase()}
                    </span>
                    <h2>{selectedDocument.name}</h2>
                    <p>Added {timestampLabel(selectedDocument.uploadedAt)}</p>
                  </div>
                  <button
                    className="button secondary destructive"
                    type="button"
                    onClick={() => removeDocument(selectedDocument)}
                  >
                    <Trash2 size={15} />
                    Remove locally
                  </button>
                </header>

                <div className="document-citation">
                  <Link2 size={16} />
                  <div>
                    <span>Citation</span>
                    <strong>{selectedDocument.name}</strong>
                    <small>
                      Use this exact source title when citing extracted
                      evidence.
                    </small>
                  </div>
                </div>

                <div className="document-approval">
                  <div>
                    <span className="eyebrow">CLAIM APPROVAL</span>
                    <h3>
                      {isSolicitation(selectedDocument)
                        ? "Reference only"
                        : selectedDocument.approved
                          ? "Approved for claim use"
                          : "Not approved for claim use"}
                    </h3>
                    <p>
                      {isSolicitation(selectedDocument)
                        ? "Solicitation material defines the request; it is never eligible for claim approval."
                        : "Approval confirms the source may support a claim after human review."}
                    </p>
                  </div>
                  <label className="approval-toggle">
                    <input
                      type="checkbox"
                      checked={
                        !isSolicitation(selectedDocument) &&
                        selectedDocument.approved
                      }
                      disabled={isSolicitation(selectedDocument)}
                      onChange={event =>
                        updateDocument(
                          selectedDocument.id,
                          "approved",
                          event.target.checked
                        )
                      }
                    />
                    <span>
                      {isSolicitation(selectedDocument)
                        ? "Approval unavailable"
                        : selectedDocument.approved
                          ? "Approved"
                          : "Approve for claims"}
                    </span>
                  </label>
                </div>

                <section
                  className="document-text-section"
                  aria-labelledby="source-text-heading"
                >
                  <div className="document-text-heading">
                    <div>
                      <span className="eyebrow">EXTRACTED TEXT</span>
                      <h3 id="source-text-heading">
                        {isTextDocument(selectedDocument)
                          ? "Editable local text"
                          : "Read-only source text"}
                      </h3>
                    </div>
                    {isTextDocument(selectedDocument) && (
                      <span className="text-editable-badge">TXT editable</span>
                    )}
                  </div>
                  {selectedDocument.text ? (
                    isTextDocument(selectedDocument) ? (
                      <textarea
                        className="textarea document-text-editor"
                        rows={14}
                        value={selectedDocument.text}
                        onChange={event =>
                          updateDocument(
                            selectedDocument.id,
                            "text",
                            event.target.value
                          )
                        }
                        aria-label={`Extracted text for ${selectedDocument.name}`}
                      />
                    ) : (
                      <pre className="document-text">
                        {selectedDocument.text}
                      </pre>
                    )
                  ) : (
                    <div className="document-no-text">
                      <FileWarning size={20} />
                      <div>
                        <strong>
                          No extracted text is available for this source.
                        </strong>
                        <p>
                          The citation is still shown above; import or add text
                          before using it to ground a claim.
                        </p>
                      </div>
                    </div>
                  )}
                  {!isTextDocument(selectedDocument) &&
                    selectedDocument.text && (
                      <p className="document-text-note">
                        This source text is read-only here. TXT knowledge notes
                        can be edited locally.
                      </p>
                    )}
                </section>

                <footer className="document-detail-footer">
                  <BookOpenCheck size={16} />
                  <span>
                    Removing this card only changes this workspace library when
                    saved. It does not destroy remote source bytes; only
                    extracted text and metadata are managed here.
                  </span>
                </footer>
              </>
            ) : (
              <div className="document-detail-empty">
                <BookOpenCheck size={28} />
                <h2>Select evidence to review</h2>
                <p>
                  Choose a source from the library, import evidence, or add a
                  knowledge note.
                </p>
              </div>
            )}
          </article>
        </div>
      </section>

      <Modal
        title="Add knowledge note"
        description="This creates a local TXT source with a UUID and timestamp. Review and save it before relying on it for a claim."
        open={noteOpen}
        onClose={() => {
          setNoteOpen(false);
          setNote(emptyNote);
        }}
      >
        <form className="knowledge-note-form" onSubmit={addKnowledgeNote}>
          <div className="form-row">
            <label className="field">
              <span>Note title</span>
              <input
                className="input"
                value={note.name}
                onChange={event =>
                  setNote(current => ({ ...current, name: event.target.value }))
                }
                placeholder="e.g. Delivery readiness interview"
                autoFocus
              />
            </label>
            <label className="field">
              <span>Source category</span>
              <select
                className="input"
                value={note.category}
                onChange={event =>
                  setNote(current => ({
                    ...current,
                    category: event.target.value,
                  }))
                }
              >
                <option>Knowledge note</option>
                <option>Capabilities</option>
                <option>Past performance</option>
                <option>Solicitation</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span>Extracted text or notes</span>
            <textarea
              className="textarea"
              rows={9}
              value={note.text}
              onChange={event =>
                setNote(current => ({ ...current, text: event.target.value }))
              }
              placeholder="Record the source content, context, and any qualifications. Leave blank only when no text is available."
            />
          </label>
          <p className="knowledge-note-help">
            If you select <strong>Solicitation</strong>, the note will be
            reference-only and its approval control will remain disabled.
          </p>
          <div className="modal-actions">
            <button
              className="button secondary"
              type="button"
              onClick={() => {
                setNoteOpen(false);
                setNote(emptyNote);
              }}
            >
              Cancel
            </button>
            <button className="button primary" type="submit">
              <Plus size={16} />
              Add local note
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}

export default Library;
