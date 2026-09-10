"use client";

import { useState } from "react";
import AppIcon from "@/components/AppIcon";
import LinkInventoryItemSheet from "@/components/LinkInventoryItemSheet";
import NfcBindingPanel from "@/components/task-panels/NfcBindingPanel";
import InstructionsEditorPanel, { type InstructionStepView } from "@/components/task-panels/InstructionsEditorPanel";
import RequiresPhotoTogglePanel from "@/components/task-panels/RequiresPhotoTogglePanel";
import LinkedInventoryPanel from "@/components/task-panels/LinkedInventoryPanel";
import { useTaskDefinitionPanel, type DefinitionInstructionStep } from "@/lib/client/use-task-definition-panel";
import { useInventoryLinks } from "@/lib/client/use-inventory-links";

// Phase 2 of a task's two-phase create flow — see
// docs/features/unified-task-create-edit.md. Once a brand-new
// TaskDefinition has been saved (name/icon/form fields at minimum, done by
// the caller BEFORE this mounts), this renders the same four
// definitionId-scoped panels the edit surface already has
// (docs/features/unified-task-edit-surface.md) against that new id, so a
// manager can finish NFC/Instructions/Require Photo/Linked Inventory
// without leaving the create flow and reopening the task afterward.
//
// Mount this ONLY once a real definitionId exists — e.g.
// `{created && <CreatedTaskPanels definitionId={created.definitionId} .../>}`
// — it calls the shared hooks unconditionally on mount, so there is no
// "not yet created" placeholder state to render.
export interface CreatedTaskInfo {
  definitionId: string;
  nfcTagUid: string | null;
  instructionSteps: DefinitionInstructionStep[];
  requiresPhoto: boolean;
}

interface Props extends CreatedTaskInfo {
  name: string;
  icon: string;
  // Mobile can bind a tag right here (native NFC scan via
  // lib/native/nfc-scan.ts); console can only show status text — the same
  // "NFC status, not NFC action" rule from
  // docs/features/console-task-management.md, carried forward unchanged
  // into creation since a browser still has no scanner.
  allowNfcScan: boolean;
  onDone: () => void;
  doneLabel?: string;
}

export default function CreatedTaskPanels({
  name,
  icon,
  definitionId,
  nfcTagUid,
  instructionSteps,
  requiresPhoto,
  allowNfcScan,
  onDone,
  doneLabel = "Done",
}: Props) {
  const panel = useTaskDefinitionPanel(definitionId, { nfcTagUid, instructionSteps, requiresPhoto });
  const inventory = useInventoryLinks(definitionId, true);
  const [showLinkPicker, setShowLinkPicker] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2.5">
        <AppIcon name={icon} size={18} className="text-muted flex-shrink-0" />
        <h3 className="font-heading text-base text-text truncate">{name}</h3>
      </div>
      <p className="font-mono text-dim text-xs -mt-2">
        Saved. Finish setting it up now, or come back to it later from Manage Tasks.
      </p>

      {allowNfcScan ? (
        <NfcBindingPanel
          tagBinding={{
            nfcTagUid: panel.nfcTagUid,
            busy: panel.bindBusy,
            error: panel.bindError,
            alsoBoundTo: panel.alsoBoundTo,
            unclaimedUid: panel.unclaimedUid,
            claiming: panel.claiming,
            onScanToLink: panel.handleScanToLink,
            onUnbind: panel.handleUnbindTag,
            onClaimAndLink: panel.handleClaimAndLink,
          }}
        />
      ) : (
        <div className="pt-3 border-t border-border">
          <p className="font-mono text-[10px] uppercase tracking-widest text-dim mb-1.5">Scan-to-Complete Tag</p>
          <p className="font-mono text-[11px] text-dim">Not linked — link NFC on mobile device.</p>
        </div>
      )}

      <InstructionsEditorPanel
        instructions={{
          steps: panel.instructionSteps.map((s): InstructionStepView => ({
            key: s._id,
            description: s.description,
            imageUrl: s.imageUrl,
          })),
          maxSteps: 3,
          busy: panel.stepsBusy,
          error: panel.stepsError,
          capturing: panel.capturing,
          captureError: panel.captureError,
          onTakePhoto: panel.handleTakePhoto,
          onAddStep: panel.handleAddStep,
          onDeleteStep: panel.handleDeleteStep,
        }}
      />

      <RequiresPhotoTogglePanel
        toggle={{ value: panel.requiresPhoto, busy: panel.requiresPhotoBusy, onChange: panel.handleToggleRequiresPhoto }}
      />

      <LinkedInventoryPanel
        links={inventory.links}
        busyId={inventory.busyId}
        error={inventory.error}
        onAdd={() => setShowLinkPicker(true)}
        onToggleRequired={inventory.toggleRequired}
        onRemove={inventory.removeLink}
      />

      <button
        type="button"
        onClick={onDone}
        className="w-full py-3.5 rounded-card bg-olive text-text font-body font-medium"
      >
        {doneLabel}
      </button>

      {showLinkPicker && (
        <LinkInventoryItemSheet
          excludeItemTypeIds={(inventory.links ?? []).map((l) => l.itemTypeId)}
          busy={inventory.busyId !== null}
          onPick={async (itemTypeId) => {
            const ok = await inventory.addLink(itemTypeId);
            if (ok) setShowLinkPicker(false);
          }}
          onClose={() => setShowLinkPicker(false)}
        />
      )}
    </div>
  );
}
