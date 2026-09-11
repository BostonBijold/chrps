import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongoose";
import TaskLog from "@/models/TaskLog";
import User from "@/models/User";
import type { LogState } from "@/models/TaskLog";
import type { FormFieldValue } from "@/models/TaskDefinition";
import {
  assertNfcVerified,
  assertPhotoProvided,
  completeInProgressLog,
  NfcTagRequiredError,
  PhotoRequiredError,
  serializeLog,
  startInProgressLog,
  switchActiveLog,
} from "@/lib/task-log-actions";
import { recordSessionCompletion, releaseSessionIfNowEmpty } from "@/lib/task-list-session-actions";
import { writeInventoryLogsForTaskCompletion } from "@/lib/inventory";
import { resolveSessionUser, isManagerOrAbove, pickActiveLocationId } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });

  const date = req.nextUrl.searchParams.get("date") ?? todayString();
  await connectDB();
  // An owner may pass ?locationId=<id> to view a specific store (validated
  // against their own company); an employee/manager always sees only their
  // own — see docs/features/locations.md.
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);
  const logs = await TaskLog.find({ companyId, locationId, date }).lean();
  const serialized = logs.map(serializeLog);

  // Resolve the claiming user's display name for any task currently
  // claimed (in_progress/paused) — TaskRow.tsx's claim pill needs this to
  // show "who has this" to every other viewer, see docs/features/task-lists.md's
  // "Per-task claiming". A terminal log's performedByUserId is attribution
  // only and doesn't need a name resolved here. Same "filter out non-
  // ObjectId sentinels" guard as lib/task-list-session-actions.ts's old
  // getOpenSessionLocks — SKIP_AUTH's local dev user id isn't a real
  // Mongo ObjectId and would otherwise throw a cast error on the $in query.
  const claimedIds = Array.from(
    new Set(
      serialized
        .filter((l) => l.state === "in_progress" || l.state === "paused")
        .map((l) => l.performedByUserId)
        .filter((id): id is string => !!id && mongoose.isValidObjectId(id))
    )
  );
  const users = claimedIds.length > 0 ? await User.find({ _id: { $in: claimedIds } }, "name").lean() : [];
  const nameById = new Map(users.map((u) => [u._id.toString(), u.name as string | undefined]));

  return NextResponse.json(
    serialized.map((l) => ({
      ...l,
      performedByName:
        l.state === "in_progress" || l.state === "paused"
          ? nameById.get(l.performedByUserId ?? "") ?? "someone else"
          : null,
    }))
  );
}

// POST — creates or replaces a log entry.
// For state 'in_progress': delegates to startInProgressLog (see lib/task-log-actions),
// which enforces the single-active-timer invariant server-side.
// For terminal states (done/missed): sets state + actualMinutes + isBackEntry.
// Uses $set only — DO NOT put filter fields in $setOnInsert, MongoDB rejects it as
// conflicting mods and the write silently fails on the client.
export async function POST(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, userId: performedByUserId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });

  const { taskId, date, actualMinutes, state, isBackEntry, sessionTaskListId, sessionNav, photoUrl, locationId: requestedLocationId } = (await req.json()) as {
    taskId: string;
    date: string;
    actualMinutes?: number;
    state: LogState;
    isBackEntry?: boolean;
    // The Blob URL of a completion photo captured via
    // components/TaskPhotoCaptureButton.tsx — see
    // docs/features/task-completion-photo.md. Only meaningful with
    // state: "done" (see assertPhotoProvided below); ignored for "missed".
    photoUrl?: string | null;
    sessionTaskListId?: string | null; // set by TaskListSessionView to anchor this timer inside a session
    // Set by TaskListSessionView when moving between tasks (advancing or
    // jumping). Still enforces a single running timer — whatever was active
    // gets paused, banking its elapsed time — but never marks the task
    // being left done or missed the way the default sweep
    // (startInProgressLog) does, since navigating within an already-open
    // session isn't "I've started doing something else." See
    // switchActiveLog in lib/task-log-actions.ts.
    sessionNav?: boolean;
    // Only meaningful for an owner acting on a location other than their
    // default (see docs/features/locations.md) — an employee/manager
    // always writes against their own locationId regardless of this.
    locationId?: string;
  };

  if (!taskId || !date || !state) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  // "rest" is a legacy state only (see CLAUDE.md's "Skip Types") — no
  // client can create a new one anymore. "paused" is never a valid POST
  // value either — it's an internal-only transition (lib/task-log-actions.ts).
  if (state !== "in_progress" && state !== "done" && state !== "missed") {
    return NextResponse.json({ error: "Unsupported state" }, { status: 400 });
  }

  await connectDB();
  const locationId = pickActiveLocationId(sessionUser, await validateLocationId(companyId, requestedLocationId));

  if (state === "in_progress") {
    // A shift-list task now claims exactly like an anytime task (TaskCard's
    // Start button) — any teammate can start any pending task independently,
    // sessionTaskListId (when present) only anchors it inside a
    // TaskListSessionView walkthrough, it's never an authorization gate.
    // See docs/features/task-lists.md's "Per-task claiming."
    const log = sessionNav
      ? await switchActiveLog(companyId, locationId, performedByUserId, taskId, date, sessionTaskListId ?? null)
      : await startInProgressLog(companyId, locationId, performedByUserId, taskId, date, sessionTaskListId ?? null);
    return NextResponse.json(serializeLog(log));
  }

  // A terminal state (done/missed) is never session-anchored, regardless
  // of which state this log was in before — same rule PATCH enforces.
  // Read the prior sessionTaskListId before the write below clears it —
  // that's the only record of which TaskListSession (if any) this
  // completion belongs to (see lib/task-list-session-actions.ts). Covers
  // TaskListSessionView's own advance()/handleMissed (via saveLog), which
  // write terminal states through this route rather than PATCH.
  const priorLog = await TaskLog.findOne({ companyId, locationId, taskId, date }).lean();
  const priorSessionTaskListId = priorLog?.sessionTaskListId ? priorLog.sessionTaskListId.toString() : null;

  // No timer/form flow runs through this branch (it's the quick-complete/
  // back-entry path — see components/TaskCard.tsx), so there's never a
  // scanned UID to verify against a bound tag.
  if (state === "done") {
    try {
      await assertNfcVerified(taskId, null);
      await assertPhotoProvided(taskId, photoUrl ?? null);
    } catch (err) {
      if (err instanceof NfcTagRequiredError) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      if (err instanceof PhotoRequiredError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
  }

  const log = await TaskLog.findOneAndUpdate(
    { companyId, locationId, taskId, date },
    {
      $set: {
        state,
        actualMinutes: actualMinutes ?? null,
        isBackEntry: isBackEntry ?? false,
        sessionTaskListId: null,
        pausedSeconds: 0,
        performedByUserId,
        // Only meaningful for a "done" write — a "missed" task was never
        // done, so its photoUrl (if any pre-existing value) is left alone.
        ...(state === "done" ? { photoUrl: photoUrl ?? null } : {}),
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  ).lean();

  if (priorSessionTaskListId && (state === "done" || state === "missed")) {
    await recordSessionCompletion(companyId, locationId, priorSessionTaskListId, date, taskId, state, actualMinutes ?? 0);
  }

  return NextResponse.json(serializeLog(log));
}

// PATCH — completes or misses an existing in_progress timer log.
// For state 'done': sets completedAt = now, derives actualMinutes from startedAt.
// For state 'missed': just updates state.
export async function PATCH(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, userId: performedByUserId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });

  const {
    taskId, date, state,
    actualMinutes: fallbackMins,
    startedAt: startOverride,
    completedAt: endOverride,
    formData,
    verifiedNfcUid,
    inventoryCounts,
    photoUrl,
    locationId: requestedLocationId,
  } = (await req.json()) as {
    taskId: string;
    date: string;
    state: "done" | "missed";
    actualMinutes?: number;
    startedAt?: string;   // ISO — manual time edit from client
    completedAt?: string; // ISO — manual time edit from client
    // Filled values from a form task's save action — see
    // components/TaskFormScreen.tsx. No validation against the task's
    // formFields shape yet — trusted as sent. Only meaningful with
    // state: "done"; ignored for "missed".
    formData?: Record<string, FormFieldValue>;
    // The UID TaskFormScreen.tsx's Scan NFC step just read, when the task
    // is bound to a tag — see docs/features/nfc.md. Omitted/null for any
    // task with no tag bound; completeInProgressLog rejects a "done" write
    // for a bound task unless this matches.
    verifiedNfcUid?: string | null;
    // Counts captured for this task's linked InventoryItemTypes (see
    // docs/features/inventory.md's "Task ↔ Inventory Linking") —
    // TaskFormScreen.tsx only includes an entry when the employee actually
    // typed a value (a blank optional link is simply omitted, never sent as
    // 0). Only meaningful with state: "done"; ignored for "missed", same as
    // formData. Written via writeInventoryLogsForTaskCompletion below,
    // AFTER the TaskLog write below succeeds — never validated against
    // whether a required link actually got a count (that gate is
    // client-side only, same as this route's existing formData trust).
    inventoryCounts?: Array<{ itemTypeId: string; count: number; verifiedNfcUid?: string | null }>;
    // The Blob URL of a completion photo captured via
    // components/TaskPhotoCaptureButton.tsx — see
    // docs/features/task-completion-photo.md. Only meaningful with
    // state: "done"; ignored for "missed", same as formData.
    photoUrl?: string | null;
    // Only meaningful for an owner acting on a location other than their
    // default — see docs/features/locations.md.
    locationId?: string;
  };

  await connectDB();
  const locationId = pickActiveLocationId(sessionUser, await validateLocationId(companyId, requestedLocationId));

  // Read the prior sessionTaskListId up front — that's the only record of
  // which TaskListSession (if any) this completion belongs to (see
  // lib/task-list-session-actions.ts's recordSessionCompletion below); it's
  // no longer an authorization gate (see docs/features/task-lists.md's
  // "Per-task claiming") — any teammate can complete any in_progress log.
  const priorLog = await TaskLog.findOne({ companyId, locationId, taskId, date }).lean();
  const priorSessionTaskListId = priorLog?.sessionTaskListId ? priorLog.sessionTaskListId.toString() : null;

  if (state === "done" && !(startOverride && endOverride)) {
    // Timer completion: derive duration from server-recorded startedAt, plus
    // any time banked from earlier paused segments of this same log — shared
    // with the external trigger-task endpoint's complete-the-active-task half.
    try {
      const log = await completeInProgressLog(
        companyId, locationId, performedByUserId, taskId, date, fallbackMins ?? 1, formData ?? null, verifiedNfcUid ?? null, photoUrl ?? null
      );
      if (inventoryCounts && inventoryCounts.length > 0) {
        await writeInventoryLogsForTaskCompletion(companyId, locationId, performedByUserId, taskId, inventoryCounts);
      }
      return NextResponse.json(serializeLog(log));
    } catch (err) {
      if (err instanceof NfcTagRequiredError) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      if (err instanceof PhotoRequiredError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
  }

  // Leaving a session anchor behind on the log's next state doesn't help anyone —
  // once it's no longer in_progress it should behave like any other completed log.
  // pausedSeconds only means anything while running/paused — always cleared here.
  // Reached here for "missed" (no NFC concern — it never claims the tag was
  // present) or a manual time-edit "done". The latter covers two different
  // things: TaskRow.tsx's "Edit time" on an ALREADY-done log (just
  // adjusting timestamps on a completion that was already verified when it
  // first happened — no re-scan needed) and a back-entry "done" establishing
  // completion for the first time (same as the POST path above — no scanned
  // UID to verify, so blocked for a bound task).
  if (state === "done" && priorLog?.state !== "done") {
    try {
      await assertNfcVerified(taskId, null);
      await assertPhotoProvided(taskId, photoUrl ?? null);
    } catch (err) {
      if (err instanceof NfcTagRequiredError) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      if (err instanceof PhotoRequiredError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
  }

  const setData: Record<string, unknown> = { state, sessionTaskListId: null, pausedSeconds: 0, performedByUserId };

  if (startOverride && endOverride) {
    // Manual time edit: client supplied explicit start + end in local time converted to ISO
    const start = new Date(startOverride);
    const end = new Date(endOverride);
    setData.startedAt = start;
    setData.completedAt = end;
    setData.actualMinutes = Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000));
  }

  // A retroactive ("log with specific times") completion of a form task
  // still carries its captured field values — same formData shape as the
  // timer-derived completion above, just not routed through
  // completeInProgressLog since there's no in_progress log to complete.
  if (state === "done" && formData) {
    setData.formData = formData;
  }

  if (state === "done" && photoUrl) {
    setData.photoUrl = photoUrl;
  }

  const log = await TaskLog.findOneAndUpdate(
    { companyId, locationId, taskId, date },
    { $set: setData },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  ).lean();

  if (priorSessionTaskListId) {
    await recordSessionCompletion(companyId, locationId, priorSessionTaskListId, date, taskId, state, (setData.actualMinutes as number | undefined) ?? 0);
  }

  return NextResponse.json(serializeLog(log));
}

// Undo — deletes a TaskLog entirely, returning a task to pending. Manager-
// only, everywhere, no exceptions (anytime tasks included): an employee who
// logs a wrong value asks a manager to undo it rather than fixing it
// themselves — simplicity and food-safety auditability over convenience.
// Same 403-for-employee gating pattern as task-list create/rename/delete
// and NFC tag linking. See docs/features/task-lists.md.
export async function DELETE(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const { taskId, date, locationId: requestedLocationId } = (await req.json()) as {
    taskId: string;
    date: string;
    locationId?: string;
  };

  await connectDB();
  const locationId = pickActiveLocationId(sessionUser, await validateLocationId(companyId, requestedLocationId));
  await TaskLog.deleteOne({ companyId, locationId, taskId, date });
  // See lib/task-list-session-actions.ts's releaseSessionIfNowEmpty — Undo
  // alone can leave a shift-list session locked to whoever last touched it
  // with nothing actually running; this releases it once nothing's left.
  await releaseSessionIfNowEmpty(companyId, locationId, taskId, date);
  return NextResponse.json({ ok: true });
}

function todayString() {
  return new Date().toISOString().split("T")[0];
}
