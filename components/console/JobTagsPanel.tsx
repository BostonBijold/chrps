"use client";

import { useState } from "react";
import { Pencil, X, Check } from "lucide-react";

export interface JobTagOption {
  _id: string;
  name: string;
  // How many active company teammates currently hold this tag — see
  // docs/features/notification-job-tag-targeting.md. Optional since older
  // callers of GET /api/job-tags predate this field.
  userCount?: number;
}

interface Props {
  tags: JobTagOption[] | null;
  onCreate: (name: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onArchive: (id: string) => Promise<void>;
}

// Company-level job-tag catalog manager — the "candidate add-on" flagged in
// docs/features/admin-console.md's Resolved open question #3: job function
// labels (server/cook/busser/host/…) that TeamTable's per-row picker
// assigns to teammates. This IS the tag-catalog half of
// docs/features/locations.md's "Job tags"; the TaskList/Task.
// visibleToJobTags targeting half stays unbuilt and out of scope here.
export default function JobTagsPanel({ tags, onCreate, onRename, onArchive }: Props) {
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setError("");
    try {
      await onCreate(name);
      setNewName("");
    } catch {
      setError("Couldn't create that tag. It may already exist.");
    } finally {
      setCreating(false);
    }
  };

  const startEdit = (tag: JobTagOption) => {
    setEditingId(tag._id);
    setEditingName(tag.name);
  };

  const commitEdit = async (id: string) => {
    const name = editingName.trim();
    setEditingId(null);
    if (!name) return;
    setBusyId(id);
    await onRename(id, name);
    setBusyId(null);
  };

  return (
    <div className="mt-8">
      <h2 className="font-heading text-lg text-text mb-1">Job Tags</h2>
      <p className="font-body text-sm text-muted mb-4">
        Company-wide job function labels (server, cook, busser…) for tagging teammates in the table above.
      </p>

      <div className="border border-border rounded-card bg-card p-5 space-y-4">
        <div className="flex items-end gap-3">
          <div className="space-y-1 flex-1">
            <label className="font-mono text-[10px] text-dim uppercase tracking-widest">New Tag</label>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder="e.g. Server"
              className="block w-full bg-bg border border-border rounded px-3 py-2 font-body text-sm text-text outline-none focus:border-olive"
            />
          </div>
          <button
            onClick={handleCreate}
            disabled={creating || !newName.trim()}
            className="bg-olive text-text font-body text-sm font-medium px-4 py-2 rounded-card disabled:opacity-40 transition-opacity"
          >
            {creating ? "Adding…" : "Add Tag"}
          </button>
        </div>

        {error && <p className="font-mono text-xs text-burgundy-light">{error}</p>}

        {tags === null ? (
          <p className="text-dim font-mono text-xs">Loading…</p>
        ) : tags.length === 0 ? (
          <p className="text-dim font-mono text-xs">No job tags yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => (
              <div
                key={tag._id}
                className="flex items-center gap-1.5 bg-bg border border-border rounded-pill pl-3 pr-2 py-1"
              >
                {editingId === tag._id ? (
                  <input
                    autoFocus
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && commitEdit(tag._id)}
                    onBlur={() => commitEdit(tag._id)}
                    className="bg-transparent font-body text-xs text-text outline-none w-20"
                  />
                ) : (
                  <span className="font-body text-xs text-text">{tag.name}</span>
                )}
                {editingId === tag._id ? (
                  <button onClick={() => commitEdit(tag._id)} aria-label={`Save ${tag.name}`} className="text-dim hover:text-olive">
                    <Check size={12} />
                  </button>
                ) : (
                  <button
                    onClick={() => startEdit(tag)}
                    disabled={busyId === tag._id}
                    aria-label={`Rename ${tag.name}`}
                    className="text-dim hover:text-olive disabled:opacity-40"
                  >
                    <Pencil size={12} />
                  </button>
                )}
                <button
                  onClick={async () => {
                    setBusyId(tag._id);
                    await onArchive(tag._id);
                    setBusyId(null);
                  }}
                  disabled={busyId === tag._id}
                  aria-label={`Remove ${tag.name}`}
                  className="text-dim hover:text-burgundy-light disabled:opacity-40"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
