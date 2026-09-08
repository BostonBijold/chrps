"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Capacitor } from "@capacitor/core";
import { ChevronDown, ChevronLeft, ChevronRight, Nfc, Package, Search } from "lucide-react";
import Header from "@/components/Header";
import AddInventoryItemTypeSheet from "@/components/AddInventoryItemTypeSheet";
import ManageInventoryGroupsSheet from "@/components/ManageInventoryGroupsSheet";
import ManageInventoryDetailSheet, { type UpdatedItemType } from "@/components/ManageInventoryDetailSheet";
import { scanNfcTag } from "@/lib/native/nfc-scan";

// Sections default to collapsed once they pass this many items — same
// threshold/reasoning as ManageTasksView.tsx's COLLAPSE_THRESHOLD.
const COLLAPSE_THRESHOLD = 5;

interface ItemType {
  _id: string;
  name: string;
  unit: string | null;
  parLevel: number | null;
  nfcTagUid: string | null;
  nfcRequiredToLog: boolean;
  entryMode: "text" | "stepper";
  groupId: string | null;
  currentCount: number | null;
  belowPar: boolean;
}

interface Group {
  _id: string;
  name: string;
}

interface Props {
  userName: string;
  today: string;
  skipAuth: boolean;
}

// Manager-only "Manage Inventory" hub — item type name/unit/parLevel/group
// editing, NFC tag sync, and Groups CRUD, all in one place — see
// docs/features/inventory.md's "Grouping" and "NFC enforcement". Mirrors
// ManageTasksView.tsx's shape (search + "Scan to Find" + grouped
// tap-to-open rows) one layer down from the everyday Inventory tab
// (components/InventoryView.tsx), which stays focused on logging counts.
export default function ManageInventoryView({ userName, today, skipAuth }: Props) {
  const router = useRouter();
  const [itemTypes, setItemTypes] = useState<ItemType[] | null>(null);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [showAddSheet, setShowAddSheet] = useState(false);
  const [showManageGroups, setShowManageGroups] = useState(false);
  const [openItemId, setOpenItemId] = useState<string | null>(null);

  const fetchAll = () => {
    fetch("/api/inventory-item-types")
      .then((r) => r.json())
      .then(setItemTypes)
      .catch(() => setItemTypes([]));
    fetch("/api/inventory-groups")
      .then((r) => (r.ok ? r.json() : []))
      .then(setGroups)
      .catch(() => setGroups([]));
  };

  useEffect(fetchAll, []);

  // Search filters by name (and by bound tag UID, so a manager
  // troubleshooting a specific physical tag can find it — same convention
  // as ManageTasksView.tsx's own catalog search).
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const searching = q.length > 0;
  const matches = (it: ItemType) => q === "" || it.name.toLowerCase().includes(q) || (it.nfcTagUid ?? "").includes(q);

  const [expanded, setExpanded] = useState(true);
  const expandedDefaultSet = useRef(false);
  useEffect(() => {
    if (itemTypes && !expandedDefaultSet.current) {
      setExpanded(itemTypes.length <= COLLAPSE_THRESHOLD);
      expandedDefaultSet.current = true;
    }
  }, [itemTypes]);

  const filtered = (itemTypes ?? []).filter(matches);

  const sections = useMemo(() => {
    const byGroup = new Map<string | null, ItemType[]>();
    for (const it of filtered) {
      const key = it.groupId;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key)!.push(it);
    }
    const result: { id: string | null; name: string; items: ItemType[] }[] = [];
    for (const g of groups ?? []) {
      result.push({ id: g._id, name: g.name, items: byGroup.get(g._id) ?? [] });
    }
    const ungrouped = byGroup.get(null) ?? [];
    if (ungrouped.length > 0) result.push({ id: null, name: "Ungrouped", items: ungrouped });
    return result;
  }, [filtered, groups]);

  const openItem = openItemId ? (itemTypes ?? []).find((it) => it._id === openItemId) ?? null : null;

  // "Scan to Find" — mirrors ManageTasksView.tsx's own version, scoped to
  // this screen's item-type catalog instead of the task catalog.
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanMatches, setScanMatches] = useState<ItemType[] | null>(null);

  const handleScanToFind = async () => {
    setScanError(null);
    setScanMatches(null);
    if (!Capacitor.isNativePlatform()) {
      setScanError("Open the app on your phone to scan a tag.");
      return;
    }
    setScanBusy(true);
    const result = await scanNfcTag();
    setScanBusy(false);
    if (result.status !== "ok") {
      setScanError(result.status === "unsupported" ? "NFC isn't available on this device." : result.message);
      return;
    }
    const uid = result.uid.toLowerCase();
    const found = (itemTypes ?? []).filter((it) => it.nfcTagUid?.toLowerCase() === uid);
    if (found.length === 0) {
      setScanError("No item type in your catalog is bound to this tag.");
      return;
    }
    setExpanded(true);
    if (found.length === 1) {
      setOpenItemId(found[0]._id);
      return;
    }
    setScanMatches(found);
  };

  const handleItemSaved = (updated: UpdatedItemType) => {
    setItemTypes((prev) => (prev ? prev.map((it) => (it._id === updated._id ? { ...it, ...updated } : it)) : prev));
  };

  const handleItemArchived = () => {
    setItemTypes((prev) => (prev ? prev.filter((it) => it._id !== openItemId) : prev));
    setOpenItemId(null);
  };

  return (
    <div className="min-h-dvh bg-bg">
      <div className="mx-auto max-w-mobile px-4 pb-28">
        <Header userName={userName} today={today} skipAuth={skipAuth} />

        <div className="mt-4 mb-5 flex items-center gap-2">
          <button
            type="button"
            onClick={() => router.back()}
            className="flex items-center gap-1 text-muted font-body text-sm min-h-[44px]"
            aria-label="Back"
          >
            <ChevronLeft size={16} />
          </button>
          <h1 className="font-heading text-xl text-text">Manage Inventory</h1>
        </div>

        {/* ── Search + "Scan to Find" — locates an item by name or by
            scanning its physical tag, same convention as
            ManageTasksView.tsx. ──────────────────────────────────────── */}
        <div className="mb-1.5 flex items-center gap-2 sticky top-0 z-10">
          <div className="flex-1 min-w-0 flex items-center gap-2 bg-card border border-border rounded-card px-3 py-2">
            <Search size={14} className="text-dim flex-shrink-0" />
            <input
              type="text"
              placeholder="Search item types..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 bg-transparent font-body text-sm text-text placeholder:text-dim outline-none"
            />
          </div>
          <button
            type="button"
            onClick={handleScanToFind}
            disabled={scanBusy}
            aria-label="Scan a tag to find its item type"
            title="Scan to Find"
            className="flex-shrink-0 w-11 h-11 flex items-center justify-center bg-card border border-border rounded-card text-dim hover:text-olive hover:border-olive/40 transition-colors disabled:opacity-50"
          >
            <Nfc size={16} strokeWidth={1.75} />
          </button>
        </div>
        {scanBusy && <p className="font-mono text-[11px] text-olive mb-3.5">Hold near tag…</p>}
        {scanError && <p className="font-mono text-[11px] text-burgundy-light mb-3.5">{scanError}</p>}
        {scanMatches && (
          <div className="mb-3.5 bg-card border border-border rounded-card overflow-hidden">
            <p className="font-mono text-[10px] uppercase tracking-widest text-dim px-3 pt-2.5">
              This tag is bound to more than one item — which one?
            </p>
            <div className="divide-y divide-border mt-1.5">
              {scanMatches.map((it) => (
                <button
                  key={it._id}
                  type="button"
                  onClick={() => {
                    setOpenItemId(it._id);
                    setScanMatches(null);
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-card-hover transition-colors min-h-[44px]"
                >
                  <Package size={16} className="text-muted flex-shrink-0" strokeWidth={1.75} />
                  <span className="font-body text-sm text-text flex-1 truncate">{it.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {!scanBusy && !scanError && !scanMatches && <div className="mb-3.5" />}

        {/* ── Groups — list/rename/archive CRUD lives in the existing
            ManageInventoryGroupsSheet.tsx, opened from here. ────────────── */}
        <button
          type="button"
          onClick={() => setShowManageGroups(true)}
          className="w-full flex items-center justify-between bg-card rounded-card border border-border p-4 hover:bg-card-hover transition-colors min-h-[44px] mb-8"
        >
          <div>
            <p className="font-body text-sm text-text">Groups</p>
            <p className="font-mono text-[10px] text-dim mt-0.5">
              {groups !== null ? `${groups.length} group${groups.length === 1 ? "" : "s"}` : "Loading…"}
            </p>
          </div>
          <ChevronRight size={16} className="text-dim flex-shrink-0" />
        </button>

        {/* ── Item Types — every active InventoryItemType, grouped, tap to
            open the full editor (ManageInventoryDetailSheet.tsx). ──────── */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center justify-between mb-3 min-h-[32px]"
        >
          <p className="font-mono text-[10px] text-dim uppercase tracking-widest">
            Item Types {itemTypes !== null && `(${itemTypes.length})`}
          </p>
          {expanded || searching ? <ChevronDown size={14} className="text-dim" /> : <ChevronRight size={14} className="text-dim" />}
        </button>

        {(expanded || searching) && (
          <>
            {itemTypes === null && (
              <p className="text-dim font-mono text-xs text-center py-8">Loading…</p>
            )}
            {itemTypes !== null && itemTypes.length === 0 && (
              <p className="text-dim font-mono text-xs text-center py-8">
                No item types yet — add one below.
              </p>
            )}
            {itemTypes !== null && itemTypes.length > 0 && filtered.length === 0 && (
              <p className="text-dim font-mono text-xs text-center py-8">
                No item types match &ldquo;{search}&rdquo;
              </p>
            )}

            <div className="space-y-4">
              {sections.map((section) => {
                if (section.items.length === 0 && !searching) return null;
                return (
                  <div key={section.id ?? "__ungrouped__"}>
                    <p className="font-mono text-[10px] text-dim uppercase tracking-widest mb-2">
                      {section.name} ({section.items.length})
                    </p>
                    <div className="space-y-2">
                      {section.items.map((it) => (
                        <button
                          key={it._id}
                          type="button"
                          onClick={() => setOpenItemId(it._id)}
                          className="w-full flex items-center gap-3 bg-card rounded-card border border-border p-3 text-left hover:bg-card-hover transition-colors min-h-[44px]"
                        >
                          <div className="w-8 flex items-center justify-center flex-shrink-0">
                            <Package size={18} className="text-muted" strokeWidth={1.75} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-body text-sm text-text truncate">{it.name}</p>
                            <p className="font-mono text-[10px] text-dim truncate mt-0.5 flex items-center gap-1.5">
                              {it.parLevel !== null && `Par ${it.parLevel}`}
                              {it.nfcTagUid && (
                                <span className="flex items-center gap-0.5 text-olive">
                                  <Nfc size={10} strokeWidth={1.75} />
                                  {it.nfcRequiredToLog ? "Required" : "Synced"}
                                </span>
                              )}
                              {it.belowPar && <span className="text-burgundy-light">Below par</span>}
                            </p>
                          </div>
                          <ChevronRight size={16} className="text-dim flex-shrink-0" />
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <button
          onClick={() => setShowAddSheet(true)}
          className="mt-8 w-full flex items-center justify-center gap-2 border border-dashed border-border-light text-dim font-body text-sm py-3.5 rounded-card hover:border-olive/40 hover:text-olive transition-colors min-h-[44px]"
        >
          + Add Item Type
        </button>
      </div>

      {openItem && groups !== null && (
        <ManageInventoryDetailSheet
          itemType={openItem}
          groups={groups}
          onSaved={(updated) => {
            handleItemSaved(updated);
            setOpenItemId(null);
          }}
          onTagChanged={handleItemSaved}
          onArchived={handleItemArchived}
          onClose={() => setOpenItemId(null)}
        />
      )}

      {showAddSheet && (
        <AddInventoryItemTypeSheet
          onCreated={() => {
            setShowAddSheet(false);
            fetchAll();
          }}
          onClose={() => setShowAddSheet(false)}
        />
      )}

      {showManageGroups && (
        <ManageInventoryGroupsSheet
          onClose={() => setShowManageGroups(false)}
          onChanged={fetchAll}
        />
      )}
    </div>
  );
}
