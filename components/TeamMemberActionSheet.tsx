"use client";

import { useState } from "react";
import { X } from "lucide-react";

interface Props {
  member: { _id: string; name: string; role: "manager" | "employee" | "owner" | "developer" };
  isLastManager: boolean;
  onChangeRole: (userId: string, role: "manager" | "employee") => Promise<void>;
  onRemove: (userId: string) => Promise<void>;
  onClose: () => void;
}

// Manager-only action sheet on a roster row — change role or remove from
// team. Both actions disable rather than round-trip and fail when this
// person is the company's last remaining manager, per the same guard
// PATCH/DELETE /api/team/[userId] enforce server-side — see
// docs/features/team-invites.md.
export default function TeamMemberActionSheet({ member, isLastManager, onChangeRole, onRemove, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  // Owner assignment is manual-only (see docs/features/locations.md), same
  // for `developer` (a strict superset of owner again, see
  // docs/features/nfc.md's "Provisioning") — this sheet only ever toggles
  // between manager/employee, so neither role is touchable here at all,
  // same treatment as the last-manager guard.
  const isOwnerRow = member.role === "owner" || member.role === "developer";
  const guardBlocks = isOwnerRow || (member.role === "manager" && isLastManager);
  const nextRole = member.role === "manager" ? "employee" : "manager";

  const handleChangeRole = async () => {
    setBusy(true);
    await onChangeRole(member._id, nextRole);
    setBusy(false);
    onClose();
  };

  const handleRemove = async () => {
    if (!window.confirm(`Remove ${member.name} from the team? They'll lose access until invited again.`)) return;
    setBusy(true);
    await onRemove(member._id);
    setBusy(false);
    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
        <div className="w-full sm:max-w-mobile sm:mx-5 bg-card rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col">
          <div className="flex items-center gap-3 px-5 pt-5 pb-4 border-b border-border flex-shrink-0">
            <div className="flex-1 min-w-0">
              <h2 className="font-heading text-base text-text truncate">{member.name}</h2>
            </div>
            <button onClick={onClose} className="w-8 h-8 flex items-center justify-center text-dim flex-shrink-0" aria-label="Close">
              <X size={18} />
            </button>
          </div>

          <div className="p-3 space-y-1">
            <button
              onClick={handleChangeRole}
              disabled={busy || guardBlocks}
              className="w-full text-left px-3 py-3.5 rounded-card font-body text-sm text-text hover:bg-card-hover transition-colors min-h-[44px] disabled:opacity-40"
            >
              Make {nextRole === "manager" ? "Manager" : "Employee"}
            </button>
            <button
              onClick={handleRemove}
              disabled={busy || guardBlocks}
              className="w-full text-left px-3 py-3.5 rounded-card font-body text-sm text-burgundy-light hover:bg-burgundy/10 transition-colors min-h-[44px] disabled:opacity-40"
            >
              Remove from team
            </button>
            {guardBlocks && (
              <p className="px-3 pt-1 font-mono text-[10px] text-dim">
                {isOwnerRow
                  ? `${member.name} is an ${member.role} — role changes for that tier aren't made from this screen.`
                  : `${member.name} is the last manager — promote someone else first.`}
              </p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
