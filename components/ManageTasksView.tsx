"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Capacitor } from "@capacitor/core";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, Nfc, Search } from "lucide-react";
import Header from "@/components/Header";
import AppIcon from "@/components/AppIcon";
import AddTaskListSheet from "@/components/AddTaskListSheet";
import AddTaskSheet from "@/components/AddTaskSheet";
import ManageTaskDetailSheet, { type InstructionStepView } from "@/components/ManageTaskDetailSheet";
import { scanNfcTag } from "@/lib/native/nfc-scan";
import type { FormFieldDef } from "@/models/TaskDefinition";

// Sections default to collapsed once they pass this many items — keeps the
// screen scannable as a company's catalog/standalone-task count grows,
// without hiding anything for the common small-company case. Collapse
// state itself is plain component state, not persisted across visits —
// CLAUDE.md rules out localStorage/sessionStorage for app state, and a
// MongoDB-backed per-user preference is more than this is worth for now.
const COLLAPSE_THRESHOLD = 5;

// Mirrors app/api/blob/upload/route.ts's onBeforeGenerateToken constraints
// exactly — checking client-side first turns an oversized/wrong-type photo
// into an immediate, specific error message instead of a round-trip to
// Vercel Blob that comes back as a generic 400.
const MAX_INSTRUCTION_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_INSTRUCTION_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

interface DefinitionPlacement {
  taskId: string;
  taskListId: string;
  taskListName: string;
}

interface DefinitionInstructionStep {
  _id: string;
  description: string | null;
  imageUrl: string | null;
}

interface Definition {
  _id: string;
  name: string;
  icon: string;
  taskType: string;
  formFields: unknown[];
  projectedMinutes: number;
  nfcTagUid: string | null;
  instructionSteps: DefinitionInstructionStep[];
  placements: DefinitionPlacement[];
}

interface ManageTaskList {
  _id: string;
  name: string;
  startTime: string | null;
}

interface StandaloneTask {
  _id: string;
  name: string;
  icon: string;
  projectedMinutes: number;
  taskListId: string;
  taskListName: string;
}

interface Props {
  userName: string;
  today: string;
  skipAuth: boolean;
  taskLists: ManageTaskList[];
  standaloneTasks: StandaloneTask[];
}

function fmtTime(t: string) {
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${period}`;
}

function fieldsAndPlacementsMeta(definition: Definition) {
  const fields = `${definition.formFields.length} field${definition.formFields.length === 1 ? "" : "s"}`;
  if (definition.placements.length === 0) return `${fields} · not placed in any list`;
  return `${fields} · used in ${definition.placements.map((p) => p.taskListName).join(", ")}`;
}

// ── Company task catalog row — a compact single-line row that opens a
// detail sheet on tap (see ManageTaskDetailSheet.tsx) rather than rendering
// field count / used-in / tag-binding / delete inline for every item at
// once. Scan-to-complete binding lives at the definition level, so it works
// for a saved task regardless of which list (if any) currently places it —
// see docs/features/nfc.md's "In-app scan-to-complete binding" and
// docs/features/task-lists.md's "Company Task Catalog" section. Mirrors
// TaskListEditView.tsx's SortableRow bind logic, minus drag-and-drop and
// the tap-to-trigger "NFC Tag" panel (that one stays placement-scoped,
// unaffected by this screen). ──
function CatalogRow({
  definition,
  open,
  onOpenChange,
  onDelete,
  deleting,
  blockedMessage,
}: {
  definition: Definition;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (id: string) => void;
  deleting: boolean;
  blockedMessage: string | null;
}) {
  const [nfcTagUid, setNfcTagUid] = useState<string | null>(definition.nfcTagUid);
  const [bindBusy, setBindBusy] = useState(false);
  const [bindError, setBindError] = useState<string | null>(null);
  // Other active targets already bound to the same UID — a tag can now back
  // more than one target (see docs/features/nfc.md's "Multi-target
  // binding"), so binding here never fails or clears another's binding, it
  // just informs the manager the tag is about to do double duty.
  const [alsoBoundTo, setAlsoBoundTo] = useState<string[]>([]);

  // Instruction steps (docs/features/task-completion-instructions.md) —
  // an image (uploaded straight to Vercel Blob from the browser via a
  // client-upload token, see app/api/blob/upload/route.ts) and/or a
  // caption, up to 3 per task. The whole array is re-saved through the
  // existing PATCH /api/task-definitions/[id] on every add/delete, same
  // as formFields — no separate per-step save endpoint.
  const [instructionSteps, setInstructionSteps] = useState<DefinitionInstructionStep[]>(definition.instructionSteps);
  const [stepsBusy, setStepsBusy] = useState(false);
  const [stepsError, setStepsError] = useState<string | null>(null);

  async function saveInstructionSteps(next: Array<{ description: string | null; imageUrl: string | null }>): Promise<boolean> {
    setStepsBusy(true);
    setStepsError(null);
    try {
      const res = await fetch(`/api/task-definitions/${definition._id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructionSteps: next }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to save");
      const body = await res.json();
      setInstructionSteps(body.instructionSteps ?? []);
      return true;
    } catch (err) {
      console.error("[instruction-steps] save failed:", err);
      setStepsError(err instanceof Error ? err.message : "Failed to save");
      return false;
    } finally {
      setStepsBusy(false);
    }
  }

  // 30s cap on the Blob upload — without this, a hung request (bad token,
  // network stall, a browser-bundling quirk in @vercel/blob/client) leaves
  // stepsBusy stuck true forever with no error ever surfacing, since a
  // promise that never settles never reaches either the try's success path
  // or the catch. Better to fail loud after a timeout than hang silently.
  function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  async function handleAddStep({ description, file }: { description: string | null; file: File | null }): Promise<boolean> {
    setStepsBusy(true);
    setStepsError(null);
    let imageUrl: string | null = null;
    if (file) {
      if (!ALLOWED_INSTRUCTION_IMAGE_TYPES.includes(file.type)) {
        setStepsError(`"${file.type || "unknown"}" isn't a supported image type — use JPEG, PNG, or WEBP.`);
        setStepsBusy(false);
        return false;
      }
      if (file.size > MAX_INSTRUCTION_IMAGE_BYTES) {
        setStepsError(`That photo is ${(file.size / 1024 / 1024).toFixed(1)}MB — must be 5MB or smaller.`);
        setStepsBusy(false);
        return false;
      }
      try {
        const { upload } = await import("@vercel/blob/client");
        // Sanitize the filename component — the raw name (spaces, macOS
        // screenshot's narrow-space-before-"PM", emoji, etc.) is passed
        // through unmodified otherwise; safer to keep the pathname plain
        // ASCII than find out which character some layer down the chain
        // objects to.
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-");
        const blob = await withTimeout(
          upload(`instruction-steps/${definition._id}-${Date.now()}-${safeName}`, file, {
            access: "public",
            handleUploadUrl: "/api/blob/upload",
          }),
          30000,
          "Upload timed out — check your connection and try again."
        );
        imageUrl = blob.url;
      } catch (err) {
        console.error("[instruction-steps] image upload failed:", err);
        setStepsError(err instanceof Error ? err.message : "Failed to upload image");
        setStepsBusy(false);
        return false;
      }
    }
    setStepsBusy(false);
    return saveInstructionSteps([
      ...instructionSteps.map((s) => ({ description: s.description, imageUrl: s.imageUrl })),
      { description, imageUrl },
    ]);
  }

  async function handleDeleteStep(index: number) {
    const next = instructionSteps
      .filter((_, i) => i !== index)
      .map((s) => ({ description: s.description, imageUrl: s.imageUrl }));
    await saveInstructionSteps(next);
  }

  async function handleScanToLink() {
    setBindError(null);
    if (!Capacitor.isNativePlatform()) {
      setBindError("Open the app on your phone to scan a tag.");
      return;
    }
    setBindBusy(true);
    const result = await scanNfcTag();
    if (result.status !== "ok") {
      setBindBusy(false);
      setBindError(result.status === "unsupported" ? "NFC isn't available on this device." : result.message);
      return;
    }
    try {
      const res = await fetch(`/api/task-definitions/${definition._id}/nfc-tag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: result.uid }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to bind tag");
      const body = await res.json();
      setNfcTagUid(result.uid);
      setAlsoBoundTo(body.alsoBoundTo ?? []);
    } catch (err) {
      setBindError(err instanceof Error ? err.message : "Failed to bind tag");
    } finally {
      setBindBusy(false);
    }
  }

  async function handleUnbindTag() {
    setBindBusy(true);
    setBindError(null);
    try {
      const res = await fetch(`/api/task-definitions/${definition._id}/nfc-tag`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to unbind tag");
      setNfcTagUid(null);
      setAlsoBoundTo([]);
    } catch (err) {
      setBindError(err instanceof Error ? err.message : "Failed to unbind tag");
    } finally {
      setBindBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className="w-full flex items-center gap-3 bg-card rounded-card border border-border p-3 text-left hover:bg-card-hover transition-colors min-h-[44px]"
      >
        <div className="w-8 flex items-center justify-center flex-shrink-0">
          <AppIcon name={definition.icon} size={18} className="text-muted" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-body text-sm text-text truncate">{definition.name}</p>
          <p className="font-mono text-[10px] text-dim truncate mt-0.5">
            {fieldsAndPlacementsMeta(definition)}
          </p>
        </div>
        <ChevronRight size={16} className="text-dim flex-shrink-0" />
      </button>

      {open && (
        <ManageTaskDetailSheet
          icon={definition.icon}
          name={definition.name}
          meta={`${definition.formFields.length} field${definition.formFields.length === 1 ? "" : "s"}`}
          usedIn={definition.placements.map((p) => ({ taskListId: p.taskListId, taskListName: p.taskListName }))}
          tagBinding={{
            nfcTagUid,
            busy: bindBusy,
            error: bindError,
            alsoBoundTo,
            onScanToLink: handleScanToLink,
            onUnbind: handleUnbindTag,
          }}
          instructions={{
            steps: instructionSteps.map((s): InstructionStepView => ({
              key: s._id,
              description: s.description,
              imageUrl: s.imageUrl,
            })),
            maxSteps: 3,
            busy: stepsBusy,
            error: stepsError,
            onAddStep: handleAddStep,
            onDeleteStep: handleDeleteStep,
          }}
          editHref={definition.placements.length > 0 ? `/tasks/${definition.placements[0].taskListId}/edit` : undefined}
          editLabel={definition.placements.length > 0 ? `Edit in ${definition.placements[0].taskListName}` : undefined}
          onDelete={() => onDelete(definition._id)}
          deleteLabel="Delete"
          deleting={deleting}
          blockedMessage={blockedMessage}
          onClose={() => onOpenChange(false)}
        />
      )}
    </>
  );
}

export default function ManageTasksView({ userName, today, skipAuth, taskLists, standaloneTasks }: Props) {
  const router = useRouter();
  const [definitions, setDefinitions] = useState<Definition[] | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [blockedMessage, setBlockedMessage] = useState<{ id: string; message: string } | null>(null);

  const [showAddTaskListSheet, setShowAddTaskListSheet] = useState(false);
  const [addTaskSheetFor, setAddTaskSheetFor] = useState<{ id: string; name: string } | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [removingStandaloneId, setRemovingStandaloneId] = useState<string | null>(null);
  const [openStandaloneId, setOpenStandaloneId] = useState<string | null>(null);
  const [openCatalogId, setOpenCatalogId] = useState<string | null>(null);

  // Top-level Task Lists / Task Catalog split — mirrors the console's
  // TaskManagementView.tsx segmented control (see
  // docs/features/manage-tasks-tabs.md). Task Lists tab holds the existing
  // Task Lists + Standalone Tasks sections (placement-management); Task
  // Catalog tab holds the existing Company Task Catalog section on its
  // own, full-width. No change to either section's own behavior — this is
  // purely a reorganization of the same JSX into two conditional branches.
  const [activeTab, setActiveTab] = useState<"lists" | "catalog">("lists");

  // "Scan to Find" — a manager rarely knows a physical tag's raw UID by
  // sight, so instead of making them type it into search, this scans the
  // tag and matches it against the already-loaded catalog's own
  // nfcTagUid (no separate lookup endpoint needed — same data CatalogRow
  // already renders). Mirrors BottomNav.tsx's FAB blind-scan, but scoped to
  // this screen's TaskDefinition catalog only and just opens the matching
  // row's detail sheet rather than resolving a placement to complete.
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanMatches, setScanMatches] = useState<Definition[] | null>(null);

  // Search filters Task Lists, Standalone Tasks, and the Company Task
  // Catalog at once (by name, and — for the catalog — by bound tag UID too,
  // so a manager troubleshooting a specific physical tag can find it).
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const searching = q.length > 0;
  const matches = (s: string) => q === "" || s.toLowerCase().includes(q);

  // Standalone Tasks defaults to collapsed once it passes COLLAPSE_THRESHOLD;
  // Task Lists stays always-expanded since it's a small, bounded set
  // (shift-based lists), and Company Task Catalog stays always-expanded too
  // now that it's its own dedicated tab (see docs/features/manage-tasks-
  // tabs.md) rather than one of several sections sharing the screen — a
  // further collapsed-by-default state there would just be a second click
  // to undo right after opening the tab. A search in progress forces
  // Standalone Tasks open regardless of its collapsed state so results are
  // visible, without changing the stored toggle state underneath it.
  const [standaloneExpanded, setStandaloneExpanded] = useState(() => standaloneTasks.length <= COLLAPSE_THRESHOLD);

  const handleDuplicateTaskList = async (id: string) => {
    setDuplicatingId(id);
    await fetch(`/api/task-lists/${id}/duplicate`, { method: "POST" });
    setDuplicatingId(null);
    router.refresh();
  };

  // Removes a single standalone (anytime-list) task placement — same
  // DELETE /api/tasks/[id] a scheduled list's SortableRow "Remove" button
  // uses (see TaskListEditView.tsx), just reachable from this screen too
  // now instead of only from the task's own anytime list's edit page.
  const handleRemoveStandaloneTask = async (id: string) => {
    setRemovingStandaloneId(id);
    await fetch(`/api/tasks/${id}`, { method: "DELETE" });
    setRemovingStandaloneId(null);
    router.refresh();
  };

  useEffect(() => {
    fetch("/api/task-definitions")
      .then((r) => r.json())
      .then((data: Definition[]) => {
        setDefinitions(data);
      })
      .catch(() => setDefinitions([]));
  }, []);

  const filteredTaskLists = taskLists.filter((tl) => matches(tl.name));
  const filteredStandalone = standaloneTasks.filter((t) => matches(t.name));
  const filteredDefinitions = definitions?.filter((d) => matches(d.name)) ?? null;
  const openStandaloneTask = openStandaloneId ? standaloneTasks.find((t) => t._id === openStandaloneId) ?? null : null;

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
    const matches = (definitions ?? []).filter((d) => d.nfcTagUid?.toLowerCase() === uid);
    if (matches.length === 0) {
      setScanError("No saved task in your catalog is bound to this tag.");
      return;
    }
    if (matches.length === 1) {
      setOpenCatalogId(matches[0]._id);
      return;
    }
    // Same tag bound to more than one saved task (see docs/features/nfc.md's
    // "Multi-target binding") — let the manager pick which one they meant.
    setScanMatches(matches);
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    setBlockedMessage(null);
    const res = await fetch(`/api/task-definitions/${id}`, { method: "DELETE" });
    if (res.ok) {
      setDefinitions((prev) => (prev ? prev.filter((d) => d._id !== id) : prev));
    } else {
      const body = await res.json().catch(() => ({}));
      setBlockedMessage({ id, message: body.error || "Couldn't delete this task." });
    }
    setDeletingId(null);
  };

  // Same "create list, then add its first tasks" chain as TasksView.tsx's
  // own (now-removed) "+ Add Task List" flow — router.refresh() re-fetches
  // this page's server data, which picks up the new list on the next render.
  const handleAddTask = async (
    templateId: string | null,
    name: string,
    icon: string,
    projectedMinutes: number,
    taskType: "standard" | "stopwatch" | "checkbox" | "form" = "form",
    scheduledDays: number[] = [0, 1, 2, 3, 4, 5, 6],
    successThreshold: number = 7,
    formFields: FormFieldDef[] = []
  ) => {
    if (!addTaskSheetFor) return;
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskListId: addTaskSheetFor.id,
        templateId,
        name,
        icon,
        projectedMinutes,
        taskType,
        scheduledDays,
        successThreshold,
        formFields,
      }),
    });
    setAddTaskSheetFor(null);
    router.refresh();
  };

  // Places an existing company saved task (TaskDefinition) into the list
  // just created — mirrors TaskListEditView.tsx's own handleAddExisting.
  const handleAddExisting = async (definitionId: string) => {
    if (!addTaskSheetFor) return;
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskListId: addTaskSheetFor.id, definitionId }),
    });
    setAddTaskSheetFor(null);
    router.refresh();
  };

  return (
    <div className="min-h-dvh bg-bg">
      <div className="mx-auto max-w-mobile px-4 pb-28">
        <Header userName={userName} today={today} skipAuth={skipAuth} />

        <div className="mt-4 mb-5 flex items-center gap-2">
          {/* Manage Tasks has two entry points (the Tasks page header icon
              and the Profile page) — router.back() actually returns to
              whichever one was used, unlike a hardcoded Link that could
              only ever be right for one of them. */}
          <button
            type="button"
            onClick={() => router.back()}
            className="flex items-center gap-1 text-muted font-body text-sm min-h-[44px]"
            aria-label="Back"
          >
            <ChevronLeft size={16} />
          </button>
          <h1 className="font-heading text-xl text-text">Manage Tasks</h1>
        </div>

        {/* ── Task Lists / Task Catalog toggle — mirrors the console's
            TaskManagementView.tsx segmented control. Splits placement
            management (Task Lists + Standalone Tasks) from the shared saved-
            task catalog into two independent views instead of one long
            scroll — see docs/features/manage-tasks-tabs.md. ────────────── */}
        <div className="mb-4 flex items-center gap-1 bg-card border border-border rounded-pill p-1">
          <button
            type="button"
            onClick={() => setActiveTab("lists")}
            className={`flex-1 font-mono text-[11px] uppercase tracking-widest py-2 rounded-pill transition-colors min-h-[36px] ${
              activeTab === "lists" ? "bg-olive text-text" : "text-dim hover:text-muted"
            }`}
          >
            Task Lists
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("catalog")}
            className={`flex-1 font-mono text-[11px] uppercase tracking-widest py-2 rounded-pill transition-colors min-h-[36px] ${
              activeTab === "catalog" ? "bg-olive text-text" : "text-dim hover:text-muted"
            }`}
          >
            Task Catalog
          </button>
        </div>

        {/* ── Search — scoped to whichever tab is active: Task Lists +
            Standalone Tasks on the Task Lists tab, the Company Task Catalog
            on the Task Catalog tab. "Scan to Find" is catalog-only (it
            matches a physical NFC tag against `nfcTagUid`, a catalog-level
            concept) — a manager standing in front of a tag rarely knows its
            raw UID to type into search, so this scans it and jumps straight
            to the bound task's detail sheet instead. ────────────────────── */}
        <div className="mb-1.5 flex items-center gap-2 sticky top-0 z-10">
          <div className="flex-1 min-w-0 flex items-center gap-2 bg-card border border-border rounded-card px-3 py-2">
            <Search size={14} className="text-dim flex-shrink-0" />
            <input
              type="text"
              placeholder={activeTab === "lists" ? "Search task lists..." : "Search saved tasks..."}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 bg-transparent font-body text-sm text-text placeholder:text-dim outline-none"
            />
          </div>
          {activeTab === "catalog" && (
            <button
              type="button"
              onClick={handleScanToFind}
              disabled={scanBusy}
              aria-label="Scan a tag to find its task"
              title="Scan to Find"
              className="flex-shrink-0 w-11 h-11 flex items-center justify-center bg-card border border-border rounded-card text-dim hover:text-olive hover:border-olive/40 transition-colors disabled:opacity-50"
            >
              <Nfc size={16} strokeWidth={1.75} />
            </button>
          )}
        </div>
        {activeTab === "catalog" && scanBusy && (
          <p className="font-mono text-[11px] text-olive mb-3.5">Hold near tag…</p>
        )}
        {activeTab === "catalog" && scanError && (
          <p className="font-mono text-[11px] text-burgundy-light mb-3.5">{scanError}</p>
        )}
        {activeTab === "catalog" && scanMatches && (
          <div className="mb-3.5 bg-card border border-border rounded-card overflow-hidden">
            <p className="font-mono text-[10px] uppercase tracking-widest text-dim px-3 pt-2.5">
              This tag is bound to more than one task — which one?
            </p>
            <div className="divide-y divide-border mt-1.5">
              {scanMatches.map((d) => (
                <button
                  key={d._id}
                  type="button"
                  onClick={() => {
                    setOpenCatalogId(d._id);
                    setScanMatches(null);
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-card-hover transition-colors min-h-[44px]"
                >
                  <AppIcon name={d.icon} size={16} className="text-muted flex-shrink-0" />
                  <span className="font-body text-sm text-text flex-1 truncate">{d.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {!(activeTab === "catalog" && (scanBusy || scanError || scanMatches)) && <div className="mb-3.5" />}

        {activeTab === "lists" && (
          <>
            {/* ── Task Lists — always expanded; a small, bounded set
                (shift-based lists), unlike Standalone Tasks below. ─────── */}
            <p className="font-mono text-[10px] text-dim uppercase tracking-widest mb-3">
              Task Lists {searching && `(${filteredTaskLists.length})`}
            </p>
            {searching && filteredTaskLists.length === 0 && (
              <p className="text-dim font-mono text-xs text-center py-6">
                No task lists match &ldquo;{search}&rdquo;
              </p>
            )}
            <div className="space-y-2">
              {filteredTaskLists.map((tl) => (
                <div key={tl._id} className="flex items-center gap-1 bg-card rounded-card border border-border">
                  <Link
                    href={`/tasks/${tl._id}/edit`}
                    className="flex-1 min-w-0 flex items-center justify-between p-4 hover:bg-card-hover transition-colors rounded-l-card"
                  >
                    <div className="min-w-0">
                      <p className="font-body text-sm text-text truncate">{tl.name}</p>
                      {tl.startTime && (
                        <p className="font-mono text-[10px] text-dim mt-0.5">Starts {fmtTime(tl.startTime)}</p>
                      )}
                    </div>
                    <ChevronRight size={16} className="text-dim flex-shrink-0 ml-2" />
                  </Link>
                  <button
                    type="button"
                    onClick={() => handleDuplicateTaskList(tl._id)}
                    disabled={duplicatingId === tl._id}
                    aria-label={`Duplicate ${tl.name}`}
                    title="Duplicate task list"
                    className="flex-shrink-0 w-11 h-11 mr-1 flex items-center justify-center text-dim hover:text-olive transition-colors disabled:opacity-40"
                  >
                    <Copy size={15} strokeWidth={1.75} />
                  </button>
                </div>
              ))}
            </div>
            <button
              onClick={() => setShowAddTaskListSheet(true)}
              className="mt-2 w-full flex items-center justify-center gap-2 border border-dashed border-border-light text-dim font-body text-sm py-3.5 rounded-card hover:border-olive/40 hover:text-olive transition-colors min-h-[44px]"
            >
              + Add Task List
            </button>

            {/* ── Standalone Tasks — the anytime lists' tasks, flattened.
                Each row still edits/deletes the same Task placement a
                scheduled list's SortableRow does
                (app/api/tasks/[id]/route.ts has no anytime-specific
                gating) — "Edit" opens the task's own anytime list, and
                "Remove" deletes the placement directly from here so an
                accidental add doesn't require a detour through the Task
                Catalog tab. NFC binding still happens in that catalog
                regardless of which list a task sits in. ──────────────── */}
            <button
              type="button"
              onClick={() => setStandaloneExpanded((v) => !v)}
              className="w-full flex items-center justify-between mb-3 mt-8 min-h-[32px]"
            >
              <p className="font-mono text-[10px] text-dim uppercase tracking-widest">
                Standalone Tasks ({standaloneTasks.length})
              </p>
              {standaloneExpanded || searching ? (
                <ChevronUp size={14} className="text-dim" />
              ) : (
                <ChevronDown size={14} className="text-dim" />
              )}
            </button>
            {(standaloneExpanded || searching) &&
              (standaloneTasks.length === 0 ? (
                <p className="text-dim font-mono text-xs text-center py-6">No standalone tasks yet.</p>
              ) : filteredStandalone.length === 0 ? (
                <p className="text-dim font-mono text-xs text-center py-6">
                  No standalone tasks match &ldquo;{search}&rdquo;
                </p>
              ) : (
                <div className="space-y-2">
                  {filteredStandalone.map((t) => (
                    <button
                      key={t._id}
                      type="button"
                      onClick={() => setOpenStandaloneId(t._id)}
                      className="w-full flex items-center gap-3 bg-card rounded-card border border-border p-3 text-left hover:bg-card-hover transition-colors min-h-[44px]"
                    >
                      <div className="w-8 flex items-center justify-center flex-shrink-0">
                        <AppIcon name={t.icon} size={18} className="text-muted" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-body text-sm text-text truncate">{t.name}</p>
                        <p className="font-mono text-[10px] text-dim truncate mt-0.5">
                          {t.projectedMinutes}m · {t.taskListName}
                        </p>
                      </div>
                      <ChevronRight size={16} className="text-dim flex-shrink-0" />
                    </button>
                  ))}
                </div>
              ))}
          </>
        )}

        {activeTab === "catalog" && (
          <>
            {/* ── Company task catalog — every saved task (TaskDefinition)
                the company has, regardless of which lists currently use
                it. This is where a physical NFC tag gets tied to a task,
                whether that task lives in a standalone list or a
                scheduled one. Always expanded, no collapse toggle — unlike
                the old stacked-sections layout, this tab is already a
                deliberate "I want the catalog" navigation, so a further
                collapsed-by-default state would just be a second click to
                undo. ──────────────────────────────────────────────────── */}
            <p className="font-mono text-[10px] text-dim uppercase tracking-widest mb-3">
              Company Task Catalog {definitions !== null && `(${definitions.length})`}
            </p>

            {definitions === null && (
              <p className="text-dim font-mono text-xs text-center py-8">Loading…</p>
            )}

            {definitions !== null && definitions.length === 0 && (
              <p className="text-dim font-mono text-xs text-center py-8">
                No saved tasks yet — add one from any task list&rsquo;s edit page.
              </p>
            )}

            {definitions !== null && definitions.length > 0 && filteredDefinitions?.length === 0 && (
              <p className="text-dim font-mono text-xs text-center py-8">
                No catalog tasks match &ldquo;{search}&rdquo;
              </p>
            )}

            <div className="space-y-2">
              {filteredDefinitions?.map((d) => (
                <CatalogRow
                  key={d._id}
                  definition={d}
                  open={openCatalogId === d._id}
                  onOpenChange={(v) => setOpenCatalogId(v ? d._id : null)}
                  onDelete={handleDelete}
                  deleting={deletingId === d._id}
                  blockedMessage={blockedMessage?.id === d._id ? blockedMessage.message : null}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {openStandaloneTask && (
        <ManageTaskDetailSheet
          icon={openStandaloneTask.icon}
          name={openStandaloneTask.name}
          meta={`${openStandaloneTask.projectedMinutes}m`}
          editHref={`/tasks/${openStandaloneTask.taskListId}/edit`}
          editLabel={`Edit in ${openStandaloneTask.taskListName}`}
          onDelete={() => handleRemoveStandaloneTask(openStandaloneTask._id)}
          deleteLabel="Remove"
          deleting={removingStandaloneId === openStandaloneTask._id}
          onClose={() => setOpenStandaloneId(null)}
        />
      )}

      {addTaskSheetFor && (
        <AddTaskSheet
          taskListId={addTaskSheetFor.id}
          taskListName={addTaskSheetFor.name}
          onAdd={handleAddTask}
          onAddExisting={handleAddExisting}
          onClose={() => setAddTaskSheetFor(null)}
        />
      )}

      {showAddTaskListSheet && (
        <AddTaskListSheet
          onCreated={(taskList) => {
            setShowAddTaskListSheet(false);
            setAddTaskSheetFor({ id: taskList._id, name: taskList.name });
          }}
          onClose={() => setShowAddTaskListSheet(false)}
        />
      )}
    </div>
  );
}
