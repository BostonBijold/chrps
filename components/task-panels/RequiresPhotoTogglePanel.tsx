"use client";

// "Require Photo at Completion" toggle — shared between TaskListEditView
// .tsx's SortableRow (Task Lists tab) and ManageTaskDetailSheet.tsx (Task
// Catalog tab), backed by lib/client/use-task-definition-panel.ts's
// useTaskDefinitionPanel hook — see
// docs/features/unified-task-edit-surface.md and
// docs/features/task-completion-photo.md.
export interface RequiresPhotoToggle {
  value: boolean;
  busy: boolean;
  onChange: () => void;
}

export default function RequiresPhotoTogglePanel({ toggle }: { toggle: RequiresPhotoToggle }) {
  return (
    <div className="pt-3 border-t border-border flex items-center justify-between gap-2">
      <p className="font-mono text-[11px] text-text">Require Photo at Completion</p>
      <button
        type="button"
        role="switch"
        aria-checked={toggle.value}
        onClick={toggle.onChange}
        disabled={toggle.busy}
        className={`relative w-10 h-6 rounded-pill transition-colors disabled:opacity-50 flex-shrink-0 ${
          toggle.value ? "bg-olive" : "bg-border-light"
        }`}
      >
        <span
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-bg shadow transition-transform ${
            toggle.value ? "translate-x-[18px]" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}
