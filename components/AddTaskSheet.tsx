"use client";

import { useState, useEffect, useRef } from "react";
import { X, Search, ChevronLeft } from "lucide-react";
import AppIcon, { IconPicker } from "@/components/AppIcon";
import TaskFieldsEditor from "@/components/TaskFieldsEditor";
import CreatedTaskPanels, { type CreatedTaskInfo } from "@/components/task-panels/CreatedTaskPanels";
import type { FormFieldDef } from "@/models/TaskDefinition";

export type { CreatedTaskInfo };

interface Template {
  _id: string;
  name: string;
  icon: string;
  defaultProjectedMinutes: number;
  category: string;
  timeOfDay: string;
  isSystem: boolean;
  formFields: FormFieldDef[];
}

// A task this location already has saved (TaskDefinition) — placing one of
// these into this list reuses it (shared name/icon/fields/NFC binding)
// rather than creating a new saved task, unlike picking a Template below.
interface ExistingTask {
  _id: string;
  name: string;
  icon: string;
  formFields: unknown[];
  placements: Array<{ taskListId: string }>;
}

// A task saved at a DIFFERENT location (or elsewhere in the company) — read
// via GET /api/task-definitions?scope=company, "example data" other stores
// can draw from (see CLAUDE.md's "Task Lists" section and
// docs/features/task-lists.md's "Company Task Catalog"). Never has
// nfcTagUid/instructionSteps (the server nulls both out for this scope —
// neither is portable), and picking one CLONES a brand-new, same-location
// definition rather than referencing this one directly.
interface OtherLocationTask {
  _id: string;
  locationId: string | null;
  locationName: string | null;
  name: string;
  icon: string;
  formFields: unknown[];
}

interface Props {
  taskListId: string;
  taskListName: string;
  // Returns the newly-created TaskDefinition's id (plus its starting NFC/
  // instructions/photo state) on success, or null on failure — NOT void.
  // The "Create custom task" path (handleSaveCustom below) uses this to
  // move into a "phase 2" view (CreatedTaskPanels) instead of closing the
  // sheet immediately, per docs/features/unified-task-create-edit.md.
  // Quick-adding a template (handleAddTemplate) still closes right away —
  // the extra panels are only worth the detour for a task built from
  // scratch. The caller (not this component) owns creating the
  // task/placement and must NOT close the sheet itself on this path.
  onAdd: (
    templateId: string | null,
    name: string,
    icon: string,
    projectedMinutes: number,
    taskType: "form",
    scheduledDays: number[],
    successThreshold: number,
    formFields: FormFieldDef[]
  ) => Promise<CreatedTaskInfo | null>;
  // Places an existing saved task (TaskDefinition) at THIS location into
  // this list instead of creating a new one — see ExistingTask above.
  onAddExisting: (definitionId: string) => Promise<void>;
  // Clones a definition saved at a DIFFERENT location into a brand-new,
  // same-location definition, then places that into this list — see
  // OtherLocationTask above.
  onAddClone: (definitionId: string) => Promise<void>;
  onClose: () => void;
  // False on console (no scanner available) — see CreatedTaskPanels'
  // `allowNfcScan` and docs/features/console-task-management.md's "NFC
  // status, not NFC action". Defaults true (mobile).
  allowNfcScan?: boolean;
}

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"]; // Sun..Sat, matches calendarWeekDates order
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

const CATEGORY_LABELS: Record<string, string> = {
  food_safety: "Food Safety",
  cleaning: "Cleaning",
  cash_handling: "Cash Handling",
  equipment: "Equipment",
  opening_closing: "Opening & Closing",
  custom: "Custom",
};

export default function AddTaskSheet({ taskListId, taskListName, onAdd, onAddExisting, onAddClone, onClose, allowNfcScan = true }: Props) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [existingTasks, setExistingTasks] = useState<ExistingTask[]>([]);
  const [otherLocationTasks, setOtherLocationTasks] = useState<OtherLocationTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"browse" | "create" | "created">("browse");
  const [adding, setAdding] = useState<string | null>(null);
  const [addingExisting, setAddingExisting] = useState<string | null>(null);
  const [addingClone, setAddingClone] = useState<string | null>(null);
  // Set once the "Create custom task" path's initial save succeeds — see
  // the onAdd prop's own comment. Drives the "created" view (phase 2).
  const [createdTask, setCreatedTask] = useState<{ name: string; icon: string } & CreatedTaskInfo | null>(null);

  // Custom form state
  const [customIcon, setCustomIcon] = useState("star");
  const [customName, setCustomName] = useState("");
  const [customMins, setCustomMins] = useState("5");
  const [customFields, setCustomFields] = useState<FormFieldDef[]>([]);
  const [customScheduledDays, setCustomScheduledDays] = useState<number[]>(ALL_DAYS);
  const [customThreshold, setCustomThreshold] = useState(7);
  const [saving, setSaving] = useState(false);

  function toggleCustomDay(day: number) {
    setCustomScheduledDays((prev) => {
      const next = prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort();
      // Auto-follow the day count until the user deliberately lowers the
      // threshold below it — never force it back up when a day is re-added.
      setCustomThreshold((t) => Math.min(t, Math.max(next.length, 1)));
      return next;
    });
  }

  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`/api/task-templates?taskListId=${taskListId}`)
      .then((r) => r.json())
      .then((data) => { setTemplates(data); setLoading(false); });
    fetch("/api/task-definitions")
      .then((r) => r.json())
      .then(setExistingTasks)
      .catch(() => setExistingTasks([]));
    // Manager-only route (this screen is itself reached only by a manager
    // or above — see docs/features/task-lists.md) — browse-to-clone
    // "example data" from every other location in the company, see
    // OtherLocationTask above. A 403/empty response (single-location
    // company, or nothing else saved yet) just means the section renders
    // nothing.
    fetch("/api/task-definitions?scope=company")
      .then((r) => (r.ok ? r.json() : []))
      .then(setOtherLocationTasks)
      .catch(() => setOtherLocationTasks([]));
  }, [taskListId]);

  useEffect(() => {
    if (view === "browse") searchRef.current?.focus();
  }, [view]);

  // Already placed in this exact list — placing it twice has no meaning.
  const availableExisting = existingTasks.filter(
    (d) => !d.placements.some((p) => p.taskListId === taskListId)
  );
  const filteredExisting = availableExisting.filter((d) =>
    search.trim() === "" || d.name.toLowerCase().includes(search.toLowerCase())
  );

  // scope=company includes this location's own definitions too — exclude
  // anything already shown under "Your Saved Tasks" above, so each entry
  // appears in exactly one section. Naturally renders nothing at a
  // single-location company, no separate visibility check needed.
  const ownIds = new Set(existingTasks.map((d) => d._id));
  const filteredOtherLocation = otherLocationTasks
    .filter((d) => !ownIds.has(d._id))
    .filter((d) => search.trim() === "" || d.name.toLowerCase().includes(search.toLowerCase()));

  const filtered = templates.filter((t) =>
    search.trim() === "" || t.name.toLowerCase().includes(search.toLowerCase())
  );

  // Group by category
  const byCategory = filtered.reduce<Record<string, Template[]>>((acc, t) => {
    const key = t.isSystem ? t.category : "custom";
    acc[key] = acc[key] ?? [];
    acc[key].push(t);
    return acc;
  }, {});

  const handleAddTemplate = async (t: Template) => {
    setAdding(t._id);
    // Browsing a template skips the schedule/threshold prompt — every day,
    // full threshold — same as today's behavior; editable afterward. The
    // template's own formFields come along unedited. Unlike "Create custom
    // task" below, a quick template add still closes immediately — the
    // point of browsing a template is speed, and every field the phase-2
    // panels cover stays reachable afterward from Manage Tasks.
    const created = await onAdd(t._id, t.name, t.icon, t.defaultProjectedMinutes, "form", ALL_DAYS, 7, t.formFields ?? []);
    setAdding(null);
    if (created) onClose();
  };

  const handleAddExistingTask = async (d: ExistingTask) => {
    setAddingExisting(d._id);
    await onAddExisting(d._id);
    setAddingExisting(null);
  };

  const handleAddClone = async (d: OtherLocationTask) => {
    setAddingClone(d._id);
    await onAddClone(d._id);
    setAddingClone(null);
  };

  const handleSaveCustom = async () => {
    if (!customName.trim() || !customIcon || customFields.length === 0) return;
    setSaving(true);
    // First create the template in the catalog
    const res = await fetch("/api/task-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: customName.trim(),
        icon: customIcon,
        defaultProjectedMinutes: parseInt(customMins) || 5,
        category: "custom",
        timeOfDay: "any",
        formFields: customFields,
      }),
    });
    const template = await res.json();
    const created = await onAdd(
      template._id,
      template.name,
      template.icon,
      template.defaultProjectedMinutes,
      "form",
      customScheduledDays,
      customThreshold,
      template.formFields ?? customFields
    );
    setSaving(false);
    // Move into phase 2 (CreatedTaskPanels) instead of closing — see the
    // onAdd prop's own comment and docs/features/unified-task-create-edit.md.
    if (created) {
      setCreatedTask({ name: template.name, icon: template.icon, ...created });
      setView("created");
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/60 z-40" onClick={onClose} />

      {/* Sheet */}
      <div className="fixed bottom-0 left-0 right-0 z-50 max-w-mobile mx-auto">
        <div className="bg-card rounded-t-modal max-h-[80vh] flex flex-col">
          {/* Handle */}
          <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
            <div className="w-10 h-1 rounded-full bg-border-light" />
          </div>

          {/* Header */}
          <div className="flex items-center justify-between px-4 pb-3 flex-shrink-0">
            {view === "create" ? (
              <button
                onClick={() => setView("browse")}
                className="flex items-center gap-1 text-muted font-body text-sm min-h-[44px]"
              >
                <ChevronLeft size={16} />
                Back
              </button>
            ) : view === "created" ? (
              <h2 className="font-heading text-lg text-text">Task Added</h2>
            ) : (
              <h2 className="font-heading text-lg text-text">
                Add to {taskListName}
              </h2>
            )}
            <button onClick={onClose} className="text-dim min-h-[44px] min-w-[44px] flex items-center justify-end">
              <X size={18} />
            </button>
          </div>

          {view === "created" && createdTask ? (
            <div className="px-4 pb-8 overflow-y-auto">
              <CreatedTaskPanels
                name={createdTask.name}
                icon={createdTask.icon}
                definitionId={createdTask.definitionId}
                nfcTagUid={createdTask.nfcTagUid}
                instructionSteps={createdTask.instructionSteps}
                requiresPhoto={createdTask.requiresPhoto}
                allowNfcScan={allowNfcScan}
                onDone={onClose}
              />
            </div>
          ) : view === "browse" ? (
            <>
              {/* Create custom CTA */}
              <div className="px-4 mb-3 flex-shrink-0">
                <button
                  onClick={() => setView("create")}
                  className="w-full flex items-center gap-3 bg-olive/10 border border-olive/30 text-olive py-3 px-4 rounded-card font-body text-sm"
                >
                  <span className="text-lg">+</span>
                  Create custom task
                </button>
              </div>

              {/* Search */}
              <div className="px-4 mb-3 flex-shrink-0">
                <div className="flex items-center gap-2 bg-bg border border-border rounded-card px-3 py-2">
                  <Search size={14} className="text-dim flex-shrink-0" />
                  <input
                    ref={searchRef}
                    type="text"
                    placeholder="Search tasks..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="flex-1 bg-transparent font-body text-sm text-text placeholder:text-dim outline-none"
                  />
                </div>
              </div>

              {/* Results */}
              <div className="overflow-y-auto px-4 pb-8">
                {loading && (
                  <p className="text-dim font-mono text-xs text-center py-8">Loading catalog…</p>
                )}

                {!loading && filtered.length === 0 && filteredExisting.length === 0 && filteredOtherLocation.length === 0 && (
                  <p className="text-dim font-mono text-xs text-center py-8">
                    No tasks match &ldquo;{search}&rdquo;
                  </p>
                )}

                {/* Tasks this location already has saved — placing one
                    reuses it (shared name/icon/fields/NFC binding) instead
                    of creating a new saved task. */}
                {filteredExisting.length > 0 && (
                  <div className="mb-5">
                    <p className="font-mono text-[10px] uppercase tracking-widest text-dim mb-2">
                      Your Saved Tasks
                    </p>
                    <div className="bg-bg rounded-card divide-y divide-border overflow-hidden">
                      {filteredExisting.map((d) => (
                        <div key={d._id} className="flex items-center gap-3 px-3 py-3">
                          <div className="w-7 flex items-center justify-center flex-shrink-0">
                            <AppIcon name={d.icon} size={17} className="text-muted" />
                          </div>
                          <span className="flex-1 font-body text-sm text-text">{d.name}</span>
                          <span className="font-mono text-dim text-xs flex-shrink-0">
                            {d.formFields.length} field{d.formFields.length === 1 ? "" : "s"}
                          </span>
                          <button
                            onClick={() => handleAddExistingTask(d)}
                            disabled={addingExisting === d._id}
                            className="ml-2 bg-olive/15 hover:bg-olive/30 border border-olive/30 text-olive font-mono text-xs px-3 py-1.5 rounded-pill transition-colors disabled:opacity-50 flex-shrink-0"
                          >
                            {addingExisting === d._id ? "…" : "Add"}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Example data from other stores/the company as a whole —
                    picking one clones a brand-new definition at THIS
                    location (no shared NFC binding/instructions/photos —
                    see OtherLocationTask above), unlike "Your Saved Tasks"
                    which references the same one directly. */}
                {filteredOtherLocation.length > 0 && (
                  <div className="mb-5">
                    <p className="font-mono text-[10px] uppercase tracking-widest text-dim mb-2">
                      From Other Locations
                    </p>
                    <div className="bg-bg rounded-card divide-y divide-border overflow-hidden">
                      {filteredOtherLocation.map((d) => (
                        <div key={d._id} className="flex items-center gap-3 px-3 py-3">
                          <div className="w-7 flex items-center justify-center flex-shrink-0">
                            <AppIcon name={d.icon} size={17} className="text-muted" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <span className="block font-body text-sm text-text truncate">{d.name}</span>
                            {d.locationName && (
                              <span className="block font-mono text-[10px] text-dim truncate">{d.locationName}</span>
                            )}
                          </div>
                          <button
                            onClick={() => handleAddClone(d)}
                            disabled={addingClone === d._id}
                            className="ml-2 bg-olive/15 hover:bg-olive/30 border border-olive/30 text-olive font-mono text-xs px-3 py-1.5 rounded-pill transition-colors disabled:opacity-50 flex-shrink-0"
                          >
                            {addingClone === d._id ? "…" : "Add"}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {Object.entries(byCategory).map(([category, tasks]) => (
                  <div key={category} className="mb-5">
                    <p className="font-mono text-[10px] uppercase tracking-widest text-dim mb-2">
                      {CATEGORY_LABELS[category] ?? category}
                    </p>
                    <div className="bg-bg rounded-card divide-y divide-border overflow-hidden">
                      {tasks.map((t) => (
                        <div key={t._id} className="flex items-center gap-3 px-3 py-3">
                          <div className="w-7 flex items-center justify-center flex-shrink-0">
                            <AppIcon name={t.icon} size={17} className="text-muted" />
                          </div>
                          <span className="flex-1 font-body text-sm text-text">{t.name}</span>
                          <span className="font-mono text-dim text-xs flex-shrink-0">
                            {t.formFields?.length ?? 0} field{(t.formFields?.length ?? 0) === 1 ? "" : "s"}
                          </span>
                          <button
                            onClick={() => handleAddTemplate(t)}
                            disabled={adding === t._id}
                            className="ml-2 bg-olive/15 hover:bg-olive/30 border border-olive/30 text-olive font-mono text-xs px-3 py-1.5 rounded-pill transition-colors disabled:opacity-50 flex-shrink-0"
                          >
                            {adding === t._id ? "…" : "Add"}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            /* Create custom form */
            <div className="px-4 pb-8 overflow-y-auto">
              <p className="font-mono text-dim text-xs mb-6">
                This task will be saved to your company&rsquo;s catalog.
              </p>

              <div className="space-y-4">
                {/* Icon */}
                <div>
                  <label className="font-mono text-[10px] uppercase tracking-widest text-dim block mb-2">
                    Icon
                  </label>
                  <IconPicker selected={customIcon} onSelect={setCustomIcon} />
                </div>

                {/* Name */}
                <div>
                  <label className="font-mono text-[10px] uppercase tracking-widest text-dim block mb-2">
                    Task name
                  </label>
                  <input
                    type="text"
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    placeholder="e.g. Walk-in Fridge Temp"
                    className="w-full bg-bg border border-border rounded-card px-3 py-2.5 font-body text-sm text-text placeholder:text-dim outline-none focus:border-olive"
                  />
                </div>

                {/* Fields */}
                <TaskFieldsEditor fields={customFields} onChange={setCustomFields} />

                {/* Estimated minutes */}
                <div>
                  <label className="font-mono text-[10px] uppercase tracking-widest text-dim block mb-2">
                    Est. minutes
                  </label>
                  <input
                    type="number"
                    value={customMins}
                    onChange={(e) => setCustomMins(e.target.value)}
                    min={1}
                    className="w-28 bg-bg border border-border rounded-card px-3 py-2.5 font-mono text-sm text-text outline-none focus:border-olive"
                  />
                </div>

                {/* Schedule */}
                <div>
                  <label className="font-mono text-[10px] uppercase tracking-widest text-dim block mb-2">
                    Days expected
                  </label>
                  <div className="flex gap-1.5">
                    {DAY_LABELS.map((label, day) => (
                      <button
                        key={day}
                        type="button"
                        onClick={() => toggleCustomDay(day)}
                        className={`w-9 h-9 rounded-full font-mono text-xs transition-colors ${
                          customScheduledDays.includes(day)
                            ? "bg-olive text-text"
                            : "bg-bg border border-border text-dim"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Threshold */}
                <div>
                  <label className="font-mono text-[10px] uppercase tracking-widest text-dim block mb-2">
                    Counts as a win when done
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={customThreshold}
                      onChange={(e) =>
                        setCustomThreshold(Math.max(1, Math.min(parseInt(e.target.value) || 1, customScheduledDays.length)))
                      }
                      min={1}
                      max={Math.max(customScheduledDays.length, 1)}
                      className="w-16 bg-bg border border-border rounded-card px-3 py-2.5 font-mono text-sm text-text outline-none focus:border-olive"
                    />
                    <span className="font-mono text-xs text-dim">
                      of {customScheduledDays.length} scheduled day{customScheduledDays.length === 1 ? "" : "s"} this week
                    </span>
                  </div>
                </div>

                <button
                  onClick={handleSaveCustom}
                  disabled={!customName.trim() || customFields.length === 0 || saving}
                  className="w-full py-4 rounded-card bg-olive text-text font-body font-medium disabled:opacity-40 mt-4"
                >
                  {saving ? "Saving…" : "Save & Add to Task List"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
