"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { ChevronRight, Monitor, Nfc } from "lucide-react";
import Header from "@/components/Header";

const SUPPORT_EMAIL = "contact@usechrps.com";

interface Props {
  name: string;
  email: string;
  skipAuth: boolean;
  isManager?: boolean;
  isOwner?: boolean;
  isDeveloper?: boolean;
  hasPassword?: boolean;
}

export default function ProfileView({
  name,
  email,
  skipAuth,
  isManager = false,
  isOwner = false,
  isDeveloper = false,
  hasPassword = false,
}: Props) {
  const [passwordSet, setPasswordSet] = useState(hasPassword);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordStatus, setPasswordStatus] = useState<{ type: "error" | "success"; text: string } | null>(null);
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handlePasswordSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setPasswordStatus(null);

    if (newPassword.length < 8) {
      setPasswordStatus({ type: "error", text: "Password must be at least 8 characters." });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordStatus({ type: "error", text: "Passwords don't match." });
      return;
    }

    setPasswordSubmitting(true);
    try {
      const res = await fetch("/api/user/password", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPasswordStatus({ type: "error", text: data.error ?? "Something went wrong." });
        return;
      }
      setPasswordSet(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordStatus({ type: "success", text: "Password updated." });
    } catch {
      setPasswordStatus({ type: "error", text: "Something went wrong. Please try again." });
    } finally {
      setPasswordSubmitting(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (
      !window.confirm(
        "Delete your account? Your name and login are removed and can't be recovered. Task logs, inventory counts, and other records you created stay with the company."
      )
    ) {
      return;
    }
    setDeleteError(null);
    setDeleting(true);
    try {
      const res = await fetch("/api/account", { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setDeleteError(data.error ?? "Something went wrong.");
        setDeleting(false);
        return;
      }
      // No session survives this — a hard navigation, not router.push, so
      // no client-side session cache outlives it.
      window.location.href = "/login";
    } catch {
      setDeleteError("Something went wrong. Please try again.");
      setDeleting(false);
    }
  };

  return (
    <div className="min-h-dvh bg-bg">
      <div className="mx-auto max-w-mobile px-4 pb-28">
        <Header userName={name} skipAuth={skipAuth} />

        <div className="mt-4 space-y-4">
          {/* Identity card */}
          <div className="bg-card rounded-card border border-border p-5">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-full bg-olive/20 flex items-center justify-center flex-shrink-0">
                <span className="font-mono text-olive text-xl font-bold">
                  {name[0]?.toUpperCase()}
                </span>
              </div>
              <div className="min-w-0">
                <p className="font-heading text-lg text-text truncate">{name}</p>
                <p className="font-mono text-dim text-xs mt-0.5 truncate">{email}</p>
              </div>
            </div>
          </div>

          {/* Credentials sign-in password — see app/api/user/password/route.ts.
              Blank "Current password" for a Google-only account (nothing to
              check yet); required once one has been set. */}
          {!skipAuth && (
            <div className="bg-card rounded-card border border-border p-5">
              <p className="font-mono text-[10px] uppercase tracking-widest text-dim mb-3">
                {passwordSet ? "Change Password" : "Set a Password"}
              </p>
              <form onSubmit={handlePasswordSubmit} className="space-y-2.5">
                {passwordSet && (
                  <input
                    type="password"
                    placeholder="Current password"
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className="w-full bg-bg border border-border rounded-card px-3.5 py-2.5 font-body text-sm text-text placeholder:text-dim focus:outline-none focus:border-olive"
                  />
                )}
                <input
                  type="password"
                  placeholder="New password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full bg-bg border border-border rounded-card px-3.5 py-2.5 font-body text-sm text-text placeholder:text-dim focus:outline-none focus:border-olive"
                />
                <input
                  type="password"
                  placeholder="Confirm new password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full bg-bg border border-border rounded-card px-3.5 py-2.5 font-body text-sm text-text placeholder:text-dim focus:outline-none focus:border-olive"
                />
                {passwordStatus && (
                  <p className={`font-mono text-xs ${passwordStatus.type === "error" ? "text-burgundy-light" : "text-done"}`}>
                    {passwordStatus.text}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={passwordSubmitting}
                  className="w-full py-3 rounded-card bg-olive text-white font-body font-medium text-sm hover:bg-olive-light transition-colors disabled:opacity-50"
                >
                  {passwordSubmitting ? "Saving…" : passwordSet ? "Update Password" : "Set Password"}
                </button>
              </form>
            </div>
          )}

          {/* Manager-or-above entry point into the desktop Admin Console —
              see docs/features/admin-console.md and
              docs/features/console-task-management.md's "Required change:
              the console is no longer owner-only" (a manager now reaches
              Task Management there; the other three pages stay owner-only
              and self-gate). Only a link, no device check here: opening it
              from the native iOS shell still navigates, but
              app/(console)/console/layout.tsx's ConsoleShell blocks native
              access itself with an "open this on a computer" message
              rather than this card needing to duplicate that logic. */}
          {isManager && (
            <Link
              href="/console"
              className="flex items-center justify-between bg-card rounded-card border border-border p-5 hover:bg-card-hover transition-colors"
            >
              <div className="flex items-center gap-3">
                <Monitor size={18} className="text-olive flex-shrink-0" />
                <div>
                  <p className="font-body text-sm text-text">Admin Console</p>
                  <p className="font-mono text-[10px] text-dim mt-0.5">
                    {isOwner
                      ? "Locations, team & access, task lists, and the cross-location rollup — best on a computer"
                      : "Manage task lists and tasks — best on a computer"}
                  </p>
                </div>
              </div>
              <ChevronRight size={16} className="text-dim flex-shrink-0" />
            </Link>
          )}

          {/* Developer-only: provisioning fresh NFC tags into the registry
              before they ship to a customer — see docs/features/nfc.md's
              "Provisioning". "developer" is never assignable through any
              in-app flow (hand-set in MongoDB, same as "owner"), so this
              card is invisible to every customer manager/owner. */}
          {isDeveloper && (
            <Link
              href="/nfc/provision"
              className="flex items-center justify-between bg-card rounded-card border border-border p-5 hover:bg-card-hover transition-colors"
            >
              <div className="flex items-center gap-3">
                <Nfc size={18} className="text-olive flex-shrink-0" />
                <div>
                  <p className="font-body text-sm text-text">Provision Tag</p>
                  <p className="font-mono text-[10px] text-dim mt-0.5">Scan a fresh tag into the registry</p>
                </div>
              </div>
              <ChevronRight size={16} className="text-dim flex-shrink-0" />
            </Link>
          )}

          {/* Manager-only: task lists, standalone tasks, and the company's
              saved-task catalog — see components/ManageTasksView.tsx and
              docs/features/task-lists.md's "Company Task Catalog" section. */}
          {isManager && (
            <Link
              href="/tasks/manage"
              className="flex items-center justify-between bg-card rounded-card border border-border p-5 hover:bg-card-hover transition-colors"
            >
              <div>
                <p className="font-body text-sm text-text">Manage Tasks</p>
                <p className="font-mono text-[10px] text-dim mt-0.5">Task lists, standalone tasks, and NFC tag bindings</p>
              </div>
              <ChevronRight size={16} className="text-dim flex-shrink-0" />
            </Link>
          )}

          {/* Manager-only: item type catalog (name/unit/parLevel/group/NFC
              tag binding/nfcRequiredToLog), plus groups — see
              components/ManageInventoryView.tsx and
              docs/features/inventory.md's "Grouping"/"NFC enforcement". */}
          {isManager && (
            <Link
              href="/inventory/manage"
              className="flex items-center justify-between bg-card rounded-card border border-border p-5 hover:bg-card-hover transition-colors"
            >
              <div>
                <p className="font-body text-sm text-text">Manage Inventory</p>
                <p className="font-mono text-[10px] text-dim mt-0.5">Item types, groups, par levels, and NFC tag bindings</p>
              </div>
              <ChevronRight size={16} className="text-dim flex-shrink-0" />
            </Link>
          )}

          {/* Manager-only: which chirp plays on this company's devices for
              an NFC scan-to-complete save — see components/CompanySettingsView.tsx. */}
          {isManager && (
            <Link
              href="/company-settings"
              className="flex items-center justify-between bg-card rounded-card border border-border p-5 hover:bg-card-hover transition-colors"
            >
              <div>
                <p className="font-body text-sm text-text">Company Settings</p>
                <p className="font-mono text-[10px] text-dim mt-0.5">NFC save sound</p>
              </div>
              <ChevronRight size={16} className="text-dim flex-shrink-0" />
            </Link>
          )}

          <Link
            href="/privacy"
            className="flex items-center justify-between bg-card rounded-card border border-border p-5 hover:bg-card-hover transition-colors"
          >
            <p className="font-body text-sm text-text">Privacy Policy</p>
            <ChevronRight size={16} className="text-dim flex-shrink-0" />
          </Link>

          {/* Sign out */}
          {!skipAuth && (
            <button
              onClick={() => signOut({ callbackUrl: "/login" })}
              className="w-full py-4 rounded-card border border-burgundy/30 text-burgundy-light font-mono text-sm hover:bg-burgundy/10 transition-colors min-h-[48px]"
            >
              Sign out
            </button>
          )}

          {skipAuth && (
            <div className="px-4 py-3 rounded-card bg-tobacco/10 border border-tobacco/20">
              <p className="font-mono text-tobacco text-xs">
                Dev mode — auth is bypassed (SKIP_AUTH=true)
              </p>
            </div>
          )}

          {/* Account deletion — App Store Review Guideline 5.1.1(v). Owner
              is blocked from self-service (billing contact, sole company
              administrator in a single-owner company) and routed to a human
              instead — see docs/features/account-deletion.md. */}
          {!skipAuth && isOwner && (
            <div className="px-4 py-3 rounded-card border border-border">
              <p className="font-mono text-dim text-xs">
                To delete your account and your company&apos;s data, contact{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`} className="text-olive underline">
                  {SUPPORT_EMAIL}
                </a>
                .
              </p>
            </div>
          )}
          {!skipAuth && !isOwner && (
            <div className="space-y-2">
              <button
                onClick={handleDeleteAccount}
                disabled={deleting}
                className="w-full py-4 rounded-card border border-burgundy/30 text-burgundy-light font-mono text-sm hover:bg-burgundy/10 transition-colors min-h-[48px] disabled:opacity-50"
              >
                {deleting ? "Deleting…" : "Delete Account"}
              </button>
              {deleteError && (
                <p className="font-mono text-burgundy-light text-xs px-1">{deleteError}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
