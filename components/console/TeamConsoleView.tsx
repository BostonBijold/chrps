"use client";

import { useCallback, useEffect, useState } from "react";
import TeamTable from "@/components/console/TeamTable";
import InvitePanel from "@/components/console/InvitePanel";
import JobTagsPanel, { JobTagOption } from "@/components/console/JobTagsPanel";
import LocationsPanel, { LocationRow } from "@/components/console/LocationsPanel";

interface Member {
  _id: string;
  name: string;
  role: "manager" | "employee" | "owner" | "developer";
  joinedAt: string | null;
  locationId: string | null;
  jobTags: string[];
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

// Page-level coordinator for /console/team — holds the roster/invites/
// locations state both TeamTable and InvitePanel need, and wires their
// callbacks to the same existing API routes the mobile Team tab uses (see
// docs/features/admin-console.md's Phase 1b: "Reuses existing APIs... zero
// net-new API work" beyond the location-reassignment wiring itself).
// LocationsPanel below is the one net-new addition: app/api/locations'
// POST/PATCH/DELETE routes already existed (owner-gated) but had no UI
// since the console's original Locations page was removed — see
// components/console/LocationsPanel.tsx.
export default function TeamConsoleView({ currentUserId }: { currentUserId: string }) {
  const [team, setTeam] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [locations, setLocations] = useState<LocationRow[] | null>(null);
  const [jobTags, setJobTags] = useState<JobTagOption[] | null>(null);

  const fetchTeam = useCallback(() => {
    fetch("/api/team").then((r) => r.json()).then(setTeam).catch(() => setTeam([]));
  }, []);

  const fetchInvites = useCallback(() => {
    fetch("/api/invites").then((r) => r.json()).then(setInvites).catch(() => setInvites([]));
  }, []);

  const fetchJobTags = useCallback(() => {
    fetch("/api/job-tags").then((r) => r.json()).then(setJobTags).catch(() => setJobTags([]));
  }, []);

  const fetchLocations = useCallback(() => {
    // Always fetched here (unlike TeamView.tsx's mobile owner-only guard) —
    // every console user is an owner, and TeamTable's reassignment
    // dropdown, InvitePanel's location picker, and LocationsPanel itself
    // all need the full list.
    fetch("/api/locations").then((r) => r.json()).then(setLocations).catch(() => setLocations([]));
  }, []);

  useEffect(() => {
    fetchTeam();
    fetchInvites();
    fetchJobTags();
    fetchLocations();
  }, [fetchTeam, fetchInvites, fetchJobTags, fetchLocations]);

  const handleChangeRole = async (userId: string, role: "manager" | "employee") => {
    await fetch(`/api/team/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    fetchTeam();
  };

  const handleReassignLocation = async (userId: string, locationId: string) => {
    await fetch(`/api/team/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locationId }),
    });
    fetchTeam();
  };

  const handleUpdateJobTags = async (userId: string, jobTags: string[]) => {
    await fetch(`/api/team/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobTags }),
    });
    fetchTeam();
  };

  const handleRemove = async (userId: string) => {
    await fetch(`/api/team/${userId}`, { method: "DELETE" });
    fetchTeam();
  };

  const handleRevoke = async (id: string) => {
    await fetch(`/api/invites/${id}`, { method: "DELETE" });
    setInvites((prev) => (prev ? prev.filter((i) => i._id !== id) : prev));
  };

  const handleCreateJobTag = async (name: string) => {
    const res = await fetch("/api/job-tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error();
    fetchJobTags();
  };

  const handleRenameJobTag = async (id: string, name: string) => {
    await fetch(`/api/job-tags/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    fetchJobTags();
    fetchTeam();
  };

  const handleArchiveJobTag = async (id: string) => {
    await fetch(`/api/job-tags/${id}`, { method: "DELETE" });
    fetchJobTags();
    fetchTeam();
  };

  const handleCreateLocation = async (name: string, address: string) => {
    const res = await fetch("/api/locations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, address: address || null }),
    });
    if (!res.ok) throw new Error();
    fetchLocations();
  };

  const handleRenameLocation = async (id: string, name: string, address: string) => {
    await fetch(`/api/locations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, address: address || null }),
    });
    fetchLocations();
  };

  const handleArchiveLocation = async (id: string) => {
    await fetch(`/api/locations/${id}`, { method: "DELETE" });
    fetchLocations();
    // A deactivated location can no longer be reassigned to or invited
    // into, but a teammate/invite already pointing at it isn't touched
    // server-side — refresh the roster so a stale dropdown selection
    // doesn't linger silently.
    fetchTeam();
  };

  return (
    <div>
      <h1 className="font-heading text-2xl text-text mb-1">Team &amp; Access</h1>
      <p className="font-body text-sm text-muted mb-6">Every teammate across every location, in one table.</p>
      <LocationsPanel
        locations={locations}
        onCreate={handleCreateLocation}
        onRename={handleRenameLocation}
        onArchive={handleArchiveLocation}
      />
      <TeamTable
        team={team}
        locations={locations ?? []}
        jobTags={jobTags ?? []}
        currentUserId={currentUserId}
        onChangeRole={handleChangeRole}
        onReassignLocation={handleReassignLocation}
        onUpdateJobTags={handleUpdateJobTags}
        onRemove={handleRemove}
      />
      <InvitePanel locations={locations ?? []} invites={invites} onGenerated={fetchInvites} onRevoke={handleRevoke} />
      <JobTagsPanel
        tags={jobTags}
        onCreate={handleCreateJobTag}
        onRename={handleRenameJobTag}
        onArchive={handleArchiveJobTag}
      />
    </div>
  );
}
