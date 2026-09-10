// Thin client wrapper around POST /api/nfc-tags/claim — see
// docs/features/nfc.md's "Claiming". Shared by
// lib/client/use-task-definition-panel.ts's handleScanToLink and
// ManageInventoryDetailSheet.tsx's own equivalent, both of which call this
// when a bind attempt comes back 409 { reason: "unclaimed" } — claiming
// then retrying the same bind is how "Scan to Link" recovers from an
// unclaimed tag without a separate screen.
export async function claimNfcTag(uid: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/nfc-tags/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body.error || "Failed to claim tag" };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Failed to claim tag" };
  }
}
