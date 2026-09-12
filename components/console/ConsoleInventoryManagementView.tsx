"use client";

import { useCallback, useEffect, useState } from "react";
import LocationSwitcher from "@/components/LocationSwitcher";
import InventoryItemTypesTable, { type ItemTypeRow, type GroupRow, type HistoryEntry } from "@/components/console/InventoryItemTypesTable";
import InventoryGroupsPanel from "@/components/console/InventoryGroupsPanel";

interface Props {
  isOwner: boolean;
  activeLocationId: string | null;
}

// Top-level coordinator for /console/inventory — see
// docs/features/console-inventory.md. Follows the console's flat
// inline-edit-row table convention rather than Task Management's
// two-pane layout. No NFC anywhere: create/edit never send
// nfcRequiredToLog, and logging a count never sends verifiedNfcUid — see
// the doc's "NFC — explicitly out of scope for this pass". An item type
// with nfcRequiredToLog already set from mobile will 409 on log attempts
// here; that failure is surfaced with console-appropriate text rather
// than the server's mobile-phrased ("use Save via NFC") message.
export default function ConsoleInventoryManagementView({ isOwner, activeLocationId }: Props) {
  const [itemTypes, setItemTypes] = useState<ItemTypeRow[] | null>(null);
  const [groups, setGroups] = useState<GroupRow[] | null>(null);
  // Same remount-on-location-change convention as ConsoleReportsView.tsx —
  // each fetch below runs once on mount, so a switcher change needs a key
  // bump rather than a threaded refetch callback.
  const [refreshTick, setRefreshTick] = useState(0);

  const fetchItemTypes = useCallback(() => {
    fetch("/api/inventory-item-types").then((r) => r.json()).then(setItemTypes).catch(() => setItemTypes([]));
  }, []);

  const fetchGroups = useCallback(() => {
    fetch("/api/inventory-groups").then((r) => (r.ok ? r.json() : [])).then(setGroups).catch(() => setGroups([]));
  }, []);

  useEffect(() => {
    fetchItemTypes();
    fetchGroups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  const handleCreateItem = async (draft: { name: string; unit: string | null; parLevel: number | null; groupId: string | null }) => {
    await fetch("/api/inventory-item-types", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    fetchItemTypes();
  };

  const handleUpdateItem = async (id: string, patch: { name?: string; unit?: string | null; parLevel?: number | null; groupId?: string | null }) => {
    await fetch(`/api/inventory-item-types/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    fetchItemTypes();
  };

  const handleArchiveItem = async (id: string) => {
    await fetch(`/api/inventory-item-types/${id}`, { method: "DELETE" });
    fetchItemTypes();
  };

  const handleCreateGroup = async (name: string): Promise<GroupRow> => {
    const res = await fetch("/api/inventory-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error();
    const group = await res.json();
    fetchGroups();
    return group;
  };

  const handleRenameGroup = async (id: string, name: string) => {
    await fetch(`/api/inventory-groups/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    fetchGroups();
  };

  const handleArchiveGroup = async (id: string) => {
    await fetch(`/api/inventory-groups/${id}`, { method: "DELETE" });
    fetchGroups();
    fetchItemTypes(); // archiving a group ungroups its member items server-side
  };

  const handleLogCount = async (itemTypeId: string, count: number): Promise<{ ok: boolean; error?: string }> => {
    const res = await fetch("/api/inventory-logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemTypeId, count }),
    });
    if (res.ok) {
      fetchItemTypes();
      return { ok: true };
    }
    if (res.status === 409) {
      // Overrides the server's mobile-phrased message ("...use Save via
      // NFC") — this page has no NFC action to point to, per the doc's
      // Open Question #4.
      return { ok: false, error: "This item requires an NFC scan — log this count from the mobile app." };
    }
    return { ok: false, error: "Couldn't save that count. Try again." };
  };

  const handleFetchHistory = async (itemTypeId: string): Promise<HistoryEntry[]> => {
    const res = await fetch(`/api/inventory-logs?itemTypeId=${itemTypeId}&limit=10`);
    if (!res.ok) return [];
    return res.json();
  };

  return (
    <div>
      <h1 className="font-heading text-2xl text-text mb-1">Par Sheet</h1>
      <p className="font-body text-sm text-muted mb-4">Item types, groups, and counts — the same catalog the phone uses.</p>

      <LocationSwitcher
        isOwner={isOwner}
        activeLocationId={activeLocationId}
        onChanged={() => setRefreshTick((t) => t + 1)}
      />

      <div key={`${activeLocationId}-${refreshTick}`}>
        <InventoryItemTypesTable
          itemTypes={itemTypes}
          groups={groups}
          onCreate={handleCreateItem}
          onCreateGroup={handleCreateGroup}
          onUpdate={handleUpdateItem}
          onArchive={handleArchiveItem}
          onLogCount={handleLogCount}
          onFetchHistory={handleFetchHistory}
        />
        <InventoryGroupsPanel
          groups={groups}
          onCreate={async (name) => { await handleCreateGroup(name); }}
          onRename={handleRenameGroup}
          onArchive={handleArchiveGroup}
        />
      </div>
    </div>
  );
}
