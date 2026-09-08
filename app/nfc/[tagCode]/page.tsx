import { redirect } from "next/navigation";
import { resolveSessionUser, isManagerOrAbove } from "@/lib/session";
import { connectDB } from "@/lib/mongoose";
import { triggerTask } from "@/lib/task-trigger";
import { resolveTask, resolveTasks } from "@/lib/task-definitions";
import { NfcTagRequiredError, PhotoRequiredError } from "@/lib/task-log-actions";
import NfcTag from "@/models/NfcTag";
import PendingNfcLink from "@/models/PendingNfcLink";
import Task from "@/models/Task";
import NfcClaimTagPicker from "@/components/NfcClaimTagPicker";
import NfcDoneScreen from "@/components/NfcDoneScreen";
import NfcTagLinkedSetup from "@/components/NfcTagLinkedSetup";

const PENDING_LINK_MAX_AGE_MS = 5 * 60 * 1000;

function todayString() {
  return new Date().toISOString().split("T")[0];
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh bg-bg flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-mobile text-center">{children}</div>
    </main>
  );
}

// Reached either via Universal Links (a tap opens this directly in the
// native app, see docs/features/nfc.md's "Native setup") or a plain browser
// visit while setting a tag up. Not in middleware.ts's PUBLIC_PAGE_PATHS, so
// a logged-out tap redirects through /login?callbackUrl=/nfc/<tagCode> and
// lands back here afterward — same as any other protected page.
export default async function NfcTagPage({
  params,
}: {
  params: { tagCode: string };
}) {
  const { tagCode } = params;
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) {
    redirect(`/login?callbackUrl=/nfc/${tagCode}`);
  }
  const { userId, companyId, role, locationId } = sessionUser;

  if (!companyId) {
    return (
      <Shell>
        <h1 className="font-heading text-2xl text-text mb-2">No company assigned</h1>
        <p className="text-muted font-body text-sm">
          Your account isn&apos;t attached to a company yet.
        </p>
      </Shell>
    );
  }

  await connectDB();

  const tag = await NfcTag.findOne({ tagCode });

  if (!tag) {
    return (
      <Shell>
        <h1 className="font-heading text-2xl text-text mb-2">Invalid tag</h1>
        <p className="text-muted font-body text-sm">This NFC tag isn&apos;t recognized.</p>
      </Shell>
    );
  }

  // Already claimed by a different company — don't reveal which task/company.
  if (tag.companyId && tag.companyId !== companyId) {
    return (
      <Shell>
        <h1 className="font-heading text-2xl text-text mb-2">Already linked</h1>
        <p className="text-muted font-body text-sm">
          This tag is already linked to another company.
        </p>
      </Shell>
    );
  }

  // Unclaimed — either auto-claim against an armed pending link, or show a
  // picker if the tag was tapped cold with nothing armed. Linking is
  // manager-only, same gate as the /api/nfc-tags routes.
  if (!tag.companyId) {
    if (!isManagerOrAbove(role)) {
      return (
        <Shell>
          <h1 className="font-heading text-2xl text-text mb-2">Not linked yet</h1>
          <p className="text-muted font-body text-sm">
            This tag isn&apos;t linked to a task yet — ask a manager to link it first.
          </p>
        </Shell>
      );
    }

    const pending = await PendingNfcLink.findOne({ userId });
    const isFresh = pending && Date.now() - pending.armedAt.getTime() < PENDING_LINK_MAX_AGE_MS;

    if (pending && isFresh) {
      const rawTask = await Task.findOne({ _id: pending.taskId, companyId, locationId, isActive: true }).lean();
      if (rawTask) {
        const task = await resolveTask(rawTask);
        tag.companyId = companyId;
        // Stamped from the resolved Task's own locationId, matching
        // POST /api/nfc-tags/[tagCode]'s claim path — a physical tag is an
        // address at one store.
        tag.locationId = task.locationId;
        tag.taskId = task._id;
        tag.taskListId = task.taskListId;
        tag.claimedByUserId = userId;
        tag.claimedAt = new Date();
        await tag.save();
        await PendingNfcLink.deleteOne({ userId });

        return (
          <Shell>
            <NfcTagLinkedSetup taskName={task.name} taskIcon={task.icon} />
          </Shell>
        );
      }
    }

    // locationId-filtered — a manager tapping an unclaimed tag cold should
    // only ever be offered THEIR OWN location's tasks to claim it against,
    // never every location's in the company.
    const rawTasks = await Task.find({ companyId, locationId, isActive: true }).sort({ order: 1 }).lean();
    const tasks = await resolveTasks(rawTasks);
    return (
      <Shell>
        <NfcClaimTagPicker
          tagCode={tagCode}
          tasks={tasks.map((t) => ({ _id: t._id.toString(), name: t.name, icon: t.icon }))}
        />
      </Shell>
    );
  }

  // Claimed by this company — the everyday trigger case, open to any
  // signed-in company user (any employee on shift can trigger a task).
  const rawTask = await Task.findOne({ _id: tag.taskId, companyId, locationId, isActive: true }).lean();
  if (!rawTask) {
    return (
      <Shell>
        <h1 className="font-heading text-2xl text-text mb-2">Task not found</h1>
        <p className="text-muted font-body text-sm">
          The task this tag was linked to no longer exists.
        </p>
      </Shell>
    );
  }
  const task = await resolveTask(rawTask);

  const taskListId = tag.taskListId ? tag.taskListId.toString() : null;
  let completed, started;
  try {
    ({ completed, started } = await triggerTask(
      companyId,
      locationId,
      userId,
      task._id.toString(),
      task.taskType,
      taskListId,
      todayString()
    ));
  } catch (err) {
    // This tap-to-trigger tag (identified by tagCode) is unrelated to the
    // task's own bound scan-to-complete tag (TaskDefinition.nfcTagUid) — see
    // docs/features/nfc.md's "In-app scan-to-complete binding". A task with
    // one of those set can't be completed this way at all.
    if (err instanceof NfcTagRequiredError) {
      return (
        <Shell>
          <h1 className="font-heading text-2xl text-text mb-2">Scan required</h1>
          <p className="text-muted font-body text-sm">
            {task.name} is bound to a specific tag — open it in the app and use Scan NFC to complete it.
          </p>
        </Shell>
      );
    }
    // A requiresPhoto task (see docs/features/task-completion-photo.md) can
    // never be completed via a tap-to-trigger Universal Link — there's no
    // capture UI on this path — same "this completion path can't satisfy
    // that requirement" reasoning as the NFC case above.
    if (err instanceof PhotoRequiredError) {
      return (
        <Shell>
          <h1 className="font-heading text-2xl text-text mb-2">Photo required</h1>
          <p className="text-muted font-body text-sm">
            {task.name} requires a completion photo — open it in the app to complete it.
          </p>
        </Shell>
      );
    }
    throw err;
  }

  // The tapped task itself just landed in a terminal `done` state — either
  // it's a mark-and-done type (checkbox, which goes straight to done via
  // startImmediateLog, never in_progress at all) or it was the
  // already-running timer this exact tap just completed. Either way, show a
  // static confirmation — no timer here, just "yes, that's logged."
  //
  // A timer that just *started* (or a different task that got completed as
  // this tap's Case 3 side effect) isn't this tapped task being done, so
  // that falls through to the plain redirect instead.
  const tappedTaskId = task._id.toString();
  const tappedJustCompleted =
    (started?.taskId === tappedTaskId && started?.state === "done") ||
    (completed?.taskId === tappedTaskId && completed?.state === "done");

  if (tappedJustCompleted) {
    return <NfcDoneScreen name={task.name} icon={task.icon} inTaskList={!!taskListId} />;
  }

  redirect("/tasks");
}
