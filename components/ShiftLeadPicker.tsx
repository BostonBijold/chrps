"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";

// Anchored bottom sheet for assigning today's shift lead on a task list —
// see docs/features/shift-lead-preassignment.md. Same sheet primitive as
// AddTaskSheet.tsx (rounded card, backdrop-to-dismiss), but anchored right
// under the tapped row instead of sliding up from the bottom of the
// screen, since this is a small, single-purpose picker rather than a
// full-screen flow.

interface RosterUser {
  _id: string;
  name: string;
  jobTags: string[];
}

interface JobTag {
  _id: string;
  name: string;
}

interface Group {
  label: string | null; // null = the flat/ungrouped list
  users: RosterUser[];
}

interface Props {
  taskListId: string;
  date: string; // YYYY-MM-DD
  currentAssignedUserId: string | null;
  onClose: () => void;
  onChanged: () => void; // a successful assign/clear — caller should re-fetch sessions
}

export default function ShiftLeadPicker({ taskListId, date, currentAssignedUserId, onClose, onChanged }: Props) {
  const [loading, setLoading] = useState(true);
  const [roster, setRoster] = useState<RosterUser[]>([]);
  const [jobTags, setJobTags] = useState<JobTag[]>([]);
  const [saving, setSaving] = useState<string | null>(null); // userId being assigned, or "clear"

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [teamRes, tagsRes] = await Promise.all([fetch("/api/team"), fetch("/api/job-tags")]);
        const team = teamRes.ok ? await teamRes.json() : [];
        const tags = tagsRes.ok ? await tagsRes.json() : [];
        if (!cancelled) {
          setRoster(team);
          setJobTags(tags);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const assign = async (assignedUserId: string) => {
    setSaving(assignedUserId);
    try {
      const res = await fetch("/api/task-list-sessions/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskListId, date, assignedUserId }),
      });
      if (res.ok) onChanged();
    } finally {
      setSaving(null);
    }
  };

  const clear = async () => {
    setSaving("clear");
    try {
      const res = await fetch(
        `/api/task-list-sessions/assign?taskListId=${taskListId}&date=${date}`,
        { method: "DELETE" }
      );
      if (res.ok) onChanged();
    } finally {
      setSaving(null);
    }
  };

  // Grouped by Job Tag when the location has any configured, flat/
  // alphabetical otherwise — see the spec's "Untagged employees in the
  // grouped picker" open question: untagged members land in their own
  // "Other" section at the bottom rather than mixed into the tag groups.
  const groups: Group[] = (() => {
    const byName = [...roster].sort((a, b) => a.name.localeCompare(b.name));
    if (jobTags.length === 0) return [{ label: null, users: byName }];

    const tagged = jobTags.map((tag) => ({
      label: tag.name,
      users: byName.filter((u) => u.jobTags.includes(tag.name)),
    }));
    const other = byName.filter((u) => !u.jobTags.some((t) => jobTags.some((jt) => jt.name === t)));
    return other.length > 0 ? [...tagged, { label: "Other", users: other }] : tagged;
  })();

  return (
    <>
      {/* Backdrop — dismiss on outside tap, same convention as every other sheet */}
      <div className="fixed inset-0 z-40" onClick={onClose} />

      {/* Sheet — anchored under (and right-aligned to) the small trigger it
          was opened from, not stretched to the card's full width like the
          old below-title row was, and not a screen-bottom slide-up either. */}
      <div className="absolute right-0 top-full mt-1 z-50 w-64 max-w-[80vw] bg-card border border-border rounded-card shadow-lg max-h-64 overflow-y-auto">
        {loading ? (
          <p className="text-dim font-mono text-xs text-center py-6">Loading team…</p>
        ) : roster.length === 0 ? (
          <p className="text-dim font-mono text-xs text-center py-6">No teammates found</p>
        ) : (
          <div className="py-1">
            {groups.map((group) => (
              group.users.length > 0 && (
                <div key={group.label ?? "all"}>
                  {group.label && (
                    <div className="px-3 pt-2 pb-1 font-mono text-[10px] uppercase tracking-widest text-dim">
                      {group.label}
                    </div>
                  )}
                  {group.users.map((u) => (
                    <button
                      key={u._id}
                      onClick={() => assign(u._id)}
                      disabled={saving !== null}
                      className="w-full flex items-center justify-between gap-2 px-3 py-2.5 min-h-[44px] text-left font-body text-sm text-text hover:bg-card-hover transition-colors disabled:opacity-50"
                    >
                      {u.name}
                      {u._id === currentAssignedUserId && <Check size={14} className="text-olive flex-shrink-0" />}
                    </button>
                  ))}
                </div>
              )
            ))}
          </div>
        )}

        <div className="border-t border-border">
          <button
            onClick={clear}
            disabled={saving !== null}
            className="w-full px-3 py-2.5 min-h-[44px] text-left font-mono text-xs text-burgundy hover:bg-card-hover transition-colors disabled:opacity-50"
          >
            Clear assignment
          </button>
        </div>
      </div>
    </>
  );
}
