"use client";

import { useCallback, useEffect, useState } from "react";
import Header from "@/components/Header";
import InviteSheet from "@/components/InviteSheet";
import TeamMemberActionSheet from "@/components/TeamMemberActionSheet";

interface Member {
  _id: string;
  name: string;
  image: string | null;
  role: "manager" | "employee" | "owner";
  joinedAt: string | null;
}

interface Invite {
  _id: string;
  role: "manager" | "employee";
  maxUses: number;
  useCount: number;
  expiresAt: string;
  createdAt: string;
  createdByName: string;
}

interface Location {
  _id: string;
  name: string;
}

interface Props {
  userName: string;
  skipAuth: boolean;
  isManager: boolean;
  isOwner: boolean;
  currentUserId: string;
  // Raw switcher selection (null = "All Locations," today's unfiltered
  // default) — unlike Tasks/Reports/Inventory, Team does NOT fall back to
  // this owner's own locationId when null. See
  // docs/features/locations.md's "Location switcher".
  activeLocationId: string | null;
  // This signed-in user's own primary location (User.locationId) — see
  // Header.tsx's LocationContext.locationId. Always null for an owner
  // filtering by activeLocationId=null ("All Locations"); the header falls
  // back to this for a non-owner, since activeLocationId is always null
  // for them on this page.
  locationId: string | null;
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Same visual language as ManageTasksView.tsx's rows/section headers —
// avatar is initials-only, matching Header.tsx/ProfileView.tsx's existing
// convention rather than rendering a photo, even though the API returns
// `image` for future use. See docs/features/team-invites.md.
function Avatar({ name }: { name: string }) {
  return (
    <div className="w-9 h-9 rounded-full bg-olive/20 flex items-center justify-center flex-shrink-0">
      <span className="font-mono text-olive text-xs font-bold">{name[0]?.toUpperCase() ?? "?"}</span>
    </div>
  );
}

function RoleBadge({ role }: { role: "manager" | "employee" | "owner" }) {
  return (
    <span
      className={`font-mono text-[10px] uppercase tracking-widest px-2 py-1 rounded-pill flex-shrink-0 ${
        role === "owner" ? "bg-gold/10 text-gold" : role === "manager" ? "bg-olive/10 text-olive" : "bg-card-hover text-muted"
      }`}
    >
      {role === "owner" ? "Owner" : role === "manager" ? "Manager" : "Employee"}
    </span>
  );
}

export default function TeamView({ userName, skipAuth, isManager, isOwner, currentUserId, activeLocationId, locationId }: Props) {
  const [team, setTeam] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [showInviteSheet, setShowInviteSheet] = useState(false);
  const [actionSheetFor, setActionSheetFor] = useState<Member | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const fetchTeam = useCallback(() => {
    fetch("/api/team")
      .then((r) => r.json())
      .then(setTeam)
      .catch(() => setTeam([]));
  }, []);

  const fetchInvites = useCallback(() => {
    if (!isManager) return;
    fetch("/api/invites")
      .then((r) => r.json())
      .then(setInvites)
      .catch(() => setInvites([]));
  }, [isManager]);

  useEffect(() => {
    fetchTeam();
    fetchInvites();
  }, [fetchTeam, fetchInvites]);

  // Only an owner needs the location picker in the invite sheet — a
  // location-bound manager's invite always stamps their own locationId
  // server-side, no picker needed. See docs/features/locations.md.
  useEffect(() => {
    if (!isOwner) return;
    fetch("/api/locations")
      .then((r) => r.json())
      .then(setLocations)
      .catch(() => setLocations([]));
  }, [isOwner]);

  const managerCount = team?.filter((m) => m.role === "manager").length ?? 0;
  // A company with at least one owner is never locked out even at zero
  // managers — matches the same reasoning PATCH/DELETE /api/team/[userId]
  // enforce server-side.
  const hasOwner = team?.some((m) => m.role === "owner") ?? false;

  const handleChangeRole = async (userId: string, role: "manager" | "employee") => {
    await fetch(`/api/team/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    fetchTeam();
  };

  const handleRemove = async (userId: string) => {
    await fetch(`/api/team/${userId}`, { method: "DELETE" });
    fetchTeam();
  };

  const handleRevoke = async (id: string) => {
    setRevokingId(id);
    await fetch(`/api/invites/${id}`, { method: "DELETE" });
    setInvites((prev) => (prev ? prev.filter((i) => i._id !== id) : prev));
    setRevokingId(null);
  };

  return (
    <div className="min-h-dvh bg-bg">
      <div className="mx-auto max-w-mobile px-4 pb-28">
        <Header
          userName={userName}
          skipAuth={skipAuth}
          location={{ isOwner, activeLocationId, locationId, allowAll: true, onLocationChanged: fetchTeam }}
        />

        <div className="mt-4 mb-5">
          <h1 className="font-heading text-xl text-text">Team</h1>
        </div>

        {/* ── Roster — everyone; read-only for an employee. Tapping a row
            (managers only) opens Change Role / Remove from Team. ────────── */}
        <p className="font-mono text-[10px] text-dim uppercase tracking-widest mb-3">Roster</p>
        {team === null ? (
          <p className="text-dim font-mono text-xs text-center py-8">Loading…</p>
        ) : (
          <div className="space-y-2">
            {team.map((m) => {
              const Row = (
                <div className="flex items-center gap-3 bg-card rounded-card border border-border p-4">
                  <Avatar name={m.name} />
                  <div className="min-w-0 flex-1">
                    <p className="font-body text-sm text-text truncate">
                      {m.name}
                      {m._id === currentUserId && <span className="text-dim"> (you)</span>}
                    </p>
                    <p className="font-mono text-[10px] text-dim mt-0.5">Joined {fmtDate(m.joinedAt)}</p>
                  </div>
                  <RoleBadge role={m.role} />
                </div>
              );
              return isManager ? (
                <button key={m._id} type="button" onClick={() => setActionSheetFor(m)} className="w-full text-left">
                  {Row}
                </button>
              ) : (
                <div key={m._id}>{Row}</div>
              );
            })}
          </div>
        )}

        {isManager && (
          <>
            <button
              onClick={() => setShowInviteSheet(true)}
              className="mt-2 w-full flex items-center justify-center gap-2 border border-dashed border-border-light text-dim font-body text-sm py-3.5 rounded-card hover:border-olive/40 hover:text-olive transition-colors min-h-[44px]"
            >
              + Invite
            </button>

            {/* ── Pending Invites — manager-only, links generated but not
                yet redeemed (or reusable and still under maxUses). ──────── */}
            <p className="font-mono text-[10px] text-dim uppercase tracking-widest mb-3 mt-8">
              Pending Invites
            </p>
            {invites === null ? (
              <p className="text-dim font-mono text-xs text-center py-6">Loading…</p>
            ) : invites.length === 0 ? (
              <p className="text-dim font-mono text-xs text-center py-6">No pending invites.</p>
            ) : (
              <div className="space-y-2">
                {invites.map((i) => (
                  <div key={i._id} className="bg-card rounded-card border border-border p-4">
                    <div className="flex items-center justify-between gap-2">
                      <RoleBadge role={i.role} />
                      <span className="font-mono text-[10px] text-dim">
                        {i.maxUses - i.useCount} use{i.maxUses - i.useCount === 1 ? "" : "s"} left · expires {fmtDate(i.expiresAt)}
                      </span>
                    </div>
                    <div className="mt-3 pt-3 border-t border-border flex items-center justify-between gap-2">
                      <span className="font-mono text-[10px] text-dim">by {i.createdByName}</span>
                      <button
                        onClick={() => handleRevoke(i._id)}
                        disabled={revokingId === i._id}
                        className="font-mono text-[10px] text-burgundy-light uppercase tracking-widest disabled:opacity-50"
                      >
                        {revokingId === i._id ? "Revoking…" : "Revoke"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {showInviteSheet && (
        <InviteSheet
          isOwner={isOwner}
          locations={locations}
          onGenerated={fetchInvites}
          onClose={() => setShowInviteSheet(false)}
        />
      )}

      {actionSheetFor && (
        <TeamMemberActionSheet
          member={actionSheetFor}
          isLastManager={managerCount <= 1 && !hasOwner}
          onChangeRole={handleChangeRole}
          onRemove={handleRemove}
          onClose={() => setActionSheetFor(null)}
        />
      )}
    </div>
  );
}
