"use client";

import { useState } from "react";

interface Member {
  _id: string;
  name: string;
  role: "manager" | "employee" | "owner" | "developer";
  joinedAt: string | null;
  locationId: string | null;
  jobTags: string[];
}

interface LocationOption {
  _id: string;
  name: string;
}

interface JobTagOption {
  _id: string;
  name: string;
}

interface Props {
  team: Member[] | null;
  locations: LocationOption[];
  jobTags: JobTagOption[];
  currentUserId: string;
  onChangeRole: (userId: string, role: "manager" | "employee") => Promise<void>;
  onReassignLocation: (userId: string, locationId: string) => Promise<void>;
  onUpdateJobTags: (userId: string, jobTags: string[]) => Promise<void>;
  onRemove: (userId: string) => Promise<void>;
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Full company roster, unfiltered by location — see
// docs/features/admin-console.md's Phase 1b: this table's entire point is
// seeing everyone across every store at once, unlike GET /api/team's
// activeLocationId-scoped mobile behavior for an owner with a switcher
// selection set (the console simply never sends that filter). Adds the one
// net-new piece of UI wiring the spec calls out — a per-row
// location-reassignment dropdown against PATCH /api/team/[userId]'s
// existing owner-only locationId field, which TeamMemberActionSheet.tsx
// (the mobile equivalent) has never had a button for.
export default function TeamTable({ team, locations, jobTags, currentUserId, onChangeRole, onReassignLocation, onUpdateJobTags, onRemove }: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const managerCount = team?.filter((m) => m.role === "manager").length ?? 0;
  // A company with at least one owner is never locked out even at zero
  // managers — same reasoning PATCH/DELETE /api/team/[userId] enforce
  // server-side.
  const hasOwner = team?.some((m) => m.role === "owner") ?? false;

  const guardBlocks = (m: Member) =>
    m.role === "owner" || m.role === "developer" || (m.role === "manager" && managerCount <= 1 && !hasOwner);

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusyId(id);
    await fn();
    setBusyId(null);
  };

  const toggleJobTag = (m: Member, tagName: string) => {
    const next = m.jobTags.includes(tagName)
      ? m.jobTags.filter((t) => t !== tagName)
      : [...m.jobTags, tagName];
    run(m._id, () => onUpdateJobTags(m._id, next));
  };

  return (
    <div className="border border-border rounded-card overflow-hidden bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-card-hover text-left">
            <th className="font-mono text-[10px] text-dim uppercase tracking-widest px-4 py-3">Name</th>
            <th className="font-mono text-[10px] text-dim uppercase tracking-widest px-4 py-3">Role</th>
            <th className="font-mono text-[10px] text-dim uppercase tracking-widest px-4 py-3">Location</th>
            <th className="font-mono text-[10px] text-dim uppercase tracking-widest px-4 py-3">Job Tags</th>
            <th className="font-mono text-[10px] text-dim uppercase tracking-widest px-4 py-3">Joined</th>
            <th className="font-mono text-[10px] text-dim uppercase tracking-widest px-4 py-3 w-44">Actions</th>
          </tr>
        </thead>
        <tbody>
          {team === null ? (
            <tr>
              <td colSpan={6} className="px-4 py-8 text-center text-dim font-mono text-xs">Loading…</td>
            </tr>
          ) : team.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-8 text-center text-dim font-mono text-xs">No teammates yet.</td>
            </tr>
          ) : (
            team.map((m) => {
              const blocked = guardBlocks(m);
              const nextRole = m.role === "manager" ? "employee" : "manager";
              return (
                <tr key={m._id} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-3 text-text font-body">
                    {m.name}
                    {m._id === currentUserId && <span className="text-dim"> (you)</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`font-mono text-[10px] uppercase tracking-widest px-2 py-1 rounded-pill ${
                        m.role === "owner" || m.role === "developer"
                          ? "bg-gold/10 text-gold"
                          : m.role === "manager"
                            ? "bg-olive/10 text-olive"
                            : "bg-card-hover text-muted"
                      }`}
                    >
                      {m.role}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {m.role === "owner" || m.role === "developer" ? (
                      <span className="font-body text-xs text-dim">All locations</span>
                    ) : (
                      <select
                        value={m.locationId ?? ""}
                        onChange={(e) => run(m._id, () => onReassignLocation(m._id, e.target.value))}
                        disabled={busyId === m._id}
                        className="bg-bg border border-border rounded px-2 py-1 font-body text-xs text-text outline-none focus:border-olive disabled:opacity-50"
                      >
                        <option value="" disabled>Unassigned</option>
                        {locations.map((l) => (
                          <option key={l._id} value={l._id}>{l.name}</option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {jobTags.length === 0 ? (
                      <span className="font-body text-xs text-dim">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1 max-w-[12rem]">
                        {jobTags.map((tag) => {
                          const assigned = m.jobTags.includes(tag.name);
                          return (
                            <button
                              key={tag._id}
                              onClick={() => toggleJobTag(m, tag.name)}
                              disabled={busyId === m._id}
                              className={`font-mono text-[10px] uppercase tracking-widest px-2 py-0.5 rounded-pill border transition-colors disabled:opacity-40 ${
                                assigned
                                  ? "bg-olive/10 border-olive text-olive"
                                  : "bg-transparent border-border text-dim hover:border-border-light"
                              }`}
                            >
                              {tag.name}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted font-mono text-xs">{fmtDate(m.joinedAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => run(m._id, () => onChangeRole(m._id, nextRole))}
                        disabled={busyId === m._id || blocked}
                        className="font-mono text-[10px] uppercase tracking-widest text-olive disabled:opacity-30"
                      >
                        Make {nextRole}
                      </button>
                      <button
                        onClick={() => {
                          if (window.confirm(`Remove ${m.name} from the team? They'll lose access until invited again.`)) {
                            run(m._id, () => onRemove(m._id));
                          }
                        }}
                        disabled={busyId === m._id || blocked}
                        className="font-mono text-[10px] uppercase tracking-widest text-burgundy-light disabled:opacity-30"
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
