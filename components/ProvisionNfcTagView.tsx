"use client";

import { useState } from "react";
import Link from "next/link";
import { Capacitor } from "@capacitor/core";
import { ChevronLeft, Nfc, Check } from "lucide-react";
import Header from "@/components/Header";
import { scanNfcTag } from "@/lib/native/nfc-scan";

interface Props {
  userName: string;
  skipAuth: boolean;
}

// Developer-only "Provision Tag" screen — see docs/features/nfc.md's
// "Provisioning". Records that a scanned UID is a real Ch'rps tag before it
// ships to a customer; deliberately minimal (manual, one tag at a time, no
// batch tooling) — provisioning volume doesn't need more than this yet.
export default function ProvisionNfcTagView({ userName, skipAuth }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Session-only running list of what's been provisioned in this screen —
  // not persisted/fetched, just a visible confirmation trail while tapping
  // through a batch of physical tags by hand.
  const [provisioned, setProvisioned] = useState<string[]>([]);

  async function handleScanToProvision() {
    setError(null);
    if (!Capacitor.isNativePlatform()) {
      setError("Open the app on your phone to scan a tag.");
      return;
    }
    setBusy(true);
    const result = await scanNfcTag();
    if (result.status !== "ok") {
      setBusy(false);
      setError(result.status === "unsupported" ? "NFC isn't available on this device." : result.message);
      return;
    }
    try {
      const res = await fetch("/api/admin/nfc-tags/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: result.uid }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to provision tag");
      setProvisioned((prev) => [result.uid, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to provision tag");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh bg-bg">
      <div className="mx-auto max-w-mobile px-4 pb-28">
        <Header userName={userName} skipAuth={skipAuth} />

        <div className="mt-4 mb-5 flex items-center gap-2">
          <Link href="/profile" className="flex items-center gap-1 text-muted font-body text-sm min-h-[44px]" aria-label="Back">
            <ChevronLeft size={16} />
          </Link>
          <h1 className="font-heading text-xl text-text">Provision Tag</h1>
        </div>

        <p className="font-body text-xs text-muted mb-5">
          Scan a fresh, unclaimed physical tag before it ships to a customer. This just records the
          UID as a real Ch&apos;rps tag — a manager still claims it for their own location later.
        </p>

        <button
          type="button"
          onClick={handleScanToProvision}
          disabled={busy}
          className="w-full flex items-center justify-center gap-2 bg-olive/15 border border-olive/30 text-olive font-mono text-sm px-4 py-3 rounded-pill disabled:opacity-50"
        >
          <Nfc size={16} strokeWidth={1.75} />
          {busy ? "Hold near tag…" : "Scan to Provision"}
        </button>

        {error && <p className="font-mono text-xs text-burgundy-light mt-3">{error}</p>}

        {provisioned.length > 0 && (
          <div className="mt-6">
            <p className="font-mono text-[10px] uppercase tracking-widest text-dim mb-2">
              Provisioned this session
            </p>
            <div className="space-y-1.5">
              {provisioned.map((uid) => (
                <div key={uid} className="flex items-center gap-2 bg-card rounded-card border border-border px-3 py-2">
                  <Check size={13} className="text-done flex-shrink-0" />
                  <span className="font-mono text-xs text-text truncate">{uid}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
