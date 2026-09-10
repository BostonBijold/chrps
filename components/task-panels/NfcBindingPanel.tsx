"use client";

import { Nfc } from "lucide-react";

// "Scan-to-Complete Tag" panel — shared between TaskListEditView.tsx's
// SortableRow (Task Lists tab) and ManageTaskDetailSheet.tsx (Task Catalog
// tab), backed by lib/client/use-task-definition-panel.ts's
// useTaskDefinitionPanel hook so binding behaves identically from either
// entry point — see docs/features/unified-task-edit-surface.md and
// docs/features/nfc.md's "In-app scan-to-complete binding".
export interface TagBinding {
  nfcTagUid: string | null;
  busy: boolean;
  error: string | null;
  alsoBoundTo: Array<{ name: string; locationName: string | null }>;
  // Set when a bind attempt was rejected because the scanned tag hasn't
  // been claimed for this location yet — see docs/features/nfc.md's
  // "Claiming". Non-null shows a "Claim & Retry" action instead of a
  // dead-end error.
  unclaimedUid: string | null;
  claiming: boolean;
  onScanToLink: () => void;
  onUnbind: () => void;
  onClaimAndLink: () => void;
}

export default function NfcBindingPanel({ tagBinding }: { tagBinding: TagBinding }) {
  return (
    <div className="pt-3 border-t border-border">
      <p className="font-mono text-[10px] uppercase tracking-widest text-dim mb-1.5 flex items-center gap-1.5">
        <Nfc size={11} strokeWidth={1.75} />
        Scan-to-Complete Tag
      </p>
      {tagBinding.nfcTagUid ? (
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-olive flex-1 truncate">
            Bound · {tagBinding.nfcTagUid}
          </span>
          <button
            type="button"
            onClick={tagBinding.onUnbind}
            disabled={tagBinding.busy}
            className="font-mono text-[11px] text-burgundy-light px-2 py-1 disabled:opacity-40"
          >
            Unbind
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={tagBinding.onScanToLink}
          disabled={tagBinding.busy}
          className="font-mono text-[11px] text-olive border border-olive/30 bg-olive/10 px-3 py-1.5 rounded-pill disabled:opacity-40"
        >
          {tagBinding.busy ? "Hold near tag…" : "Scan to Link"}
        </button>
      )}
      <p className="font-body text-[11px] text-dim mt-1.5">
        {tagBinding.nfcTagUid
          ? "Completing this task requires scanning this exact tag instead of just tapping Save."
          : "Optional — bind a physical tag so this task can only be completed by scanning it."}
      </p>
      {tagBinding.error && (
        <p className="font-mono text-[11px] text-burgundy-light mt-1.5">{tagBinding.error}</p>
      )}
      {tagBinding.unclaimedUid && (
        <button
          type="button"
          onClick={tagBinding.onClaimAndLink}
          disabled={tagBinding.claiming}
          className="font-mono text-[11px] text-olive border border-olive/30 bg-olive/10 px-3 py-1.5 rounded-pill disabled:opacity-40 mt-1.5"
        >
          {tagBinding.claiming ? "Claiming…" : "Claim this tag for your location"}
        </button>
      )}
      {tagBinding.alsoBoundTo.length > 0 && (
        <p className="font-mono text-[11px] text-dim mt-1.5">
          Also bound to:{" "}
          {tagBinding.alsoBoundTo
            .map((b) => (b.locationName ? `${b.name} (${b.locationName})` : b.name))
            .join(", ")}
        </p>
      )}
    </div>
  );
}
