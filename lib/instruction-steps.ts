// Validates/sanitizes a client-supplied instructionSteps payload — same
// "shape-first, drop malformed entries" pattern as sanitizeFormFields
// (lib/form-fields.ts). An entry needs at least one of
// description/imageUrl non-empty; both-empty entries are dropped rather
// than stored. Clamped (not rejected) at 3 entries — see
// docs/features/task-completion-instructions.md. Returns bare
// description/imageUrl pairs, not a full InstructionStep — the `_id` is
// Mongoose's own automatic per-subdocument id, assigned on write, never
// supplied by the client.
export const MAX_INSTRUCTION_STEPS = 3;

export interface SanitizedInstructionStep {
  description: string | null;
  imageUrl: string | null;
}

export function sanitizeInstructionSteps(input: unknown): SanitizedInstructionStep[] {
  if (!Array.isArray(input)) return [];

  const valid: SanitizedInstructionStep[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== "object") continue;
    const { description, imageUrl } = entry as Record<string, unknown>;
    const cleanDescription = typeof description === "string" && description.trim() ? description.trim() : null;
    const cleanImageUrl = typeof imageUrl === "string" && imageUrl.trim() ? imageUrl.trim() : null;
    if (!cleanDescription && !cleanImageUrl) continue;

    valid.push({ description: cleanDescription, imageUrl: cleanImageUrl });
    if (valid.length >= MAX_INSTRUCTION_STEPS) break;
  }
  return valid;
}
