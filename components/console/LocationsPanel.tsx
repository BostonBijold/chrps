"use client";

import { useState } from "react";
import { Pencil, X, Check } from "lucide-react";

export interface LocationRow {
  _id: string;
  name: string;
  address: string | null;
}

interface Props {
  locations: LocationRow[] | null;
  onCreate: (name: string, address: string) => Promise<void>;
  onRename: (id: string, name: string, address: string) => Promise<void>;
  onArchive: (id: string) => Promise<void>;
}

// Owner-only Locations CRUD for the Admin Console — fills the gap left when
// the console's original Phase 1a Locations page was removed (see
// docs/features/admin-console.md): the API (app/api/locations/route.ts,
// app/api/locations/[id]/route.ts) was never deleted, only its UI, so every
// call here hits routes that already existed. Lives on /console/team
// (rather than its own nav item) since a location has to exist before
// TeamTable's reassignment dropdown or InvitePanel's location picker below
// have anything to offer.
export default function LocationsPanel({ locations, onCreate, onRename, onArchive }: Props) {
  const [newName, setNewName] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingAddress, setEditingAddress] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setError("");
    try {
      await onCreate(name, newAddress.trim());
      setNewName("");
      setNewAddress("");
    } catch {
      setError("Couldn't create that location. Try again.");
    } finally {
      setCreating(false);
    }
  };

  const startEdit = (loc: LocationRow) => {
    setEditingId(loc._id);
    setEditingName(loc.name);
    setEditingAddress(loc.address ?? "");
  };

  const commitEdit = async (id: string) => {
    const name = editingName.trim();
    setEditingId(null);
    if (!name) return;
    setBusyId(id);
    await onRename(id, name, editingAddress.trim());
    setBusyId(null);
  };

  const handleArchive = async (loc: LocationRow) => {
    if (!window.confirm(`Deactivate "${loc.name}"? Teammates assigned there keep their history, but the location drops off every picker.`)) {
      return;
    }
    setBusyId(loc._id);
    await onArchive(loc._id);
    setBusyId(null);
  };

  return (
    <div className="mt-2 mb-8">
      <h2 className="font-heading text-lg text-text mb-1">Locations</h2>
      <p className="font-body text-sm text-muted mb-4">Every store under this company — add one before inviting or reassigning teammates to it.</p>

      <div className="border border-border rounded-card bg-card p-5 space-y-4">
        <div className="flex items-end gap-3 flex-wrap">
          <div className="space-y-1">
            <label className="font-mono text-[10px] text-dim uppercase tracking-widest">Name</label>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder="e.g. Downtown"
              className="block bg-bg border border-border rounded px-3 py-2 font-body text-sm text-text outline-none focus:border-olive min-w-[10rem]"
            />
          </div>
          <div className="space-y-1 flex-1">
            <label className="font-mono text-[10px] text-dim uppercase tracking-widest">Address (optional)</label>
            <input
              value={newAddress}
              onChange={(e) => setNewAddress(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder="123 Main St"
              className="block w-full bg-bg border border-border rounded px-3 py-2 font-body text-sm text-text outline-none focus:border-olive"
            />
          </div>
          <button
            onClick={handleCreate}
            disabled={creating || !newName.trim()}
            className="bg-olive text-text font-body text-sm font-medium px-4 py-2 rounded-card disabled:opacity-40 transition-opacity"
          >
            {creating ? "Adding…" : "Add Location"}
          </button>
        </div>

        {error && <p className="font-mono text-xs text-burgundy-light">{error}</p>}

        {locations === null ? (
          <p className="text-dim font-mono text-xs">Loading…</p>
        ) : locations.length === 0 ? (
          <p className="text-dim font-mono text-xs">No locations yet — add this company&apos;s first store above.</p>
        ) : (
          <div className="divide-y divide-border">
            {locations.map((loc) => (
              <div key={loc._id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                {editingId === loc._id ? (
                  <div className="flex-1 flex items-center gap-2">
                    <input
                      autoFocus
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && commitEdit(loc._id)}
                      className="bg-bg border border-border rounded px-2 py-1.5 font-body text-sm text-text outline-none focus:border-olive w-40"
                    />
                    <input
                      value={editingAddress}
                      onChange={(e) => setEditingAddress(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && commitEdit(loc._id)}
                      placeholder="Address"
                      className="flex-1 bg-bg border border-border rounded px-2 py-1.5 font-body text-sm text-text outline-none focus:border-olive"
                    />
                  </div>
                ) : (
                  <div className="flex-1 min-w-0">
                    <p className="font-body text-sm text-text truncate">{loc.name}</p>
                    {loc.address && <p className="font-mono text-xs text-dim truncate">{loc.address}</p>}
                  </div>
                )}

                {editingId === loc._id ? (
                  <button onClick={() => commitEdit(loc._id)} aria-label={`Save ${loc.name}`} className="text-dim hover:text-olive flex-shrink-0">
                    <Check size={14} />
                  </button>
                ) : (
                  <button
                    onClick={() => startEdit(loc)}
                    disabled={busyId === loc._id}
                    aria-label={`Edit ${loc.name}`}
                    className="text-dim hover:text-olive disabled:opacity-40 flex-shrink-0"
                  >
                    <Pencil size={14} />
                  </button>
                )}
                <button
                  onClick={() => handleArchive(loc)}
                  disabled={busyId === loc._id}
                  aria-label={`Deactivate ${loc.name}`}
                  className="text-dim hover:text-burgundy-light disabled:opacity-40 flex-shrink-0"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
