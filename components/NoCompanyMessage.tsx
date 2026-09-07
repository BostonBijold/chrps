"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";

// Shown when a signed-in user has no Company attached yet — either they
// signed up cold with no invite link (see docs/features/team-invites.md;
// existing team members should send one instead) or they're the very first
// person at a brand-new company, which still has no self-serve creation
// flow — a developer manually creates the Company doc and attaches it to
// this user's record in MongoDB.
//
// Two paths now redeem the same invite: opening /invite/[token] directly
// (works signed-out too, via /login?callbackUrl=/invite/<token>), or —
// for someone already signed in and stuck right here — pasting the link
// (or bare token) into the field below via POST /api/invites/redeem, no
// need to leave the app. Both hit the same lib/invites.ts redeemInvite().
//
// This screen also has no Header/BottomNav-driven way back to /profile
// (the app shell only renders those once a Company is attached), so it
// needs its own sign-out affordance too — otherwise a user stuck here
// (e.g. having signed in with the wrong Google account) has no way out.
export default function NoCompanyMessage({ userName }: { userName: string }) {
  const router = useRouter();
  const [link, setLink] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleJoin = async () => {
    if (!link.trim() || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/invites/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ link }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Couldn't join with that link.");
        return;
      }
      // companyId is resolved fresh from the User document on every
      // request (see lib/session.ts), so re-running this page's server
      // component picks the new company up immediately — no re-sign-in
      // needed.
      router.refresh();
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-dvh bg-bg flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-mobile text-center">
        <h1 className="font-heading text-3xl text-text leading-tight mb-3">
          Almost there, {userName}
        </h1>
        <p className="text-muted font-body text-base mb-6">
          Your account isn&apos;t attached to a company yet. Ask your
          administrator to finish setting up your access, then come back.
        </p>

        <div className="text-left space-y-2 mb-8">
          <label className="font-mono text-[10px] text-dim uppercase tracking-widest">
            Have an invite link?
          </label>
          <div className="flex gap-2">
            <input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleJoin()}
              placeholder="Paste your invite link"
              autoCapitalize="none"
              autoCorrect="off"
              className="flex-1 min-w-0 bg-card border border-border rounded px-3 py-2.5 font-body text-sm text-text outline-none focus:border-olive"
            />
            <button
              onClick={handleJoin}
              disabled={submitting || !link.trim()}
              className="flex-shrink-0 bg-olive text-text font-body text-sm font-medium px-4 py-2.5 rounded-card disabled:opacity-40 transition-opacity min-h-[44px]"
            >
              {submitting ? "Joining…" : "Join"}
            </button>
          </div>
          {error && <p className="font-mono text-xs text-burgundy-light">{error}</p>}
        </div>

        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="w-full py-4 rounded-card border border-burgundy/30 text-burgundy-light font-mono text-sm hover:bg-burgundy/10 transition-colors min-h-[48px]"
        >
          Sign out
        </button>
      </div>
    </main>
  );
}
