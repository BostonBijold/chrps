"use client";

import { useState, useEffect } from "react";

// Shared client-side state for a TaskDefinition's "Linked Inventory" panel
// (docs/features/inventory.md's "Task ↔ Inventory Linking"), used by both
// TaskListEditView.tsx's SortableRow (Task Lists tab) and
// ManageTasksView.tsx's CatalogRow (Task Catalog tab) — see
// docs/features/unified-task-edit-surface.md. Always definitionId-scoped
// (GET/POST /api/task-definitions/[id]/inventory-links,
// PATCH/DELETE .../inventory-links/[itemTypeId]) so the same links show and
// edit identically from either entry point; the picker sheet itself
// (LinkInventoryItemSheet.tsx) stays the caller's own concern since it also
// needs local "show/hide" state.

export interface InventoryLink {
  itemTypeId: string;
  name: string;
  unit: string | null;
  nfcTagUid: string | null;
  required: boolean;
}

export function useInventoryLinks(definitionId: string, active: boolean) {
  const [links, setLinks] = useState<InventoryLink[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetched lazily — only once the surrounding panel is actually open
  // (isEditing for a placement row, the sheet's `open` for a catalog row) —
  // same convention SortableRow already used before this hook existed.
  useEffect(() => {
    if (!active) return;
    fetch(`/api/task-definitions/${definitionId}/inventory-links`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setLinks)
      .catch(() => setLinks([]));
  }, [active, definitionId]);

  async function addLink(itemTypeId: string) {
    setBusyId(itemTypeId);
    setError(null);
    try {
      const res = await fetch(`/api/task-definitions/${definitionId}/inventory-links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemTypeId, required: false }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to link item");
      setLinks(await res.json());
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to link item");
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function toggleRequired(itemTypeId: string, required: boolean) {
    setBusyId(itemTypeId);
    setError(null);
    try {
      const res = await fetch(`/api/task-definitions/${definitionId}/inventory-links/${itemTypeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ required }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to update link");
      setLinks(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update link");
    } finally {
      setBusyId(null);
    }
  }

  async function removeLink(itemTypeId: string) {
    setBusyId(itemTypeId);
    setError(null);
    try {
      const res = await fetch(`/api/task-definitions/${definitionId}/inventory-links/${itemTypeId}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to unlink item");
      setLinks((prev) => (prev ? prev.filter((l) => l.itemTypeId !== itemTypeId) : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to unlink item");
    } finally {
      setBusyId(null);
    }
  }

  return { links, busyId, error, addLink, toggleRequired, removeLink };
}
