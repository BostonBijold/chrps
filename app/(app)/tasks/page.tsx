import { redirect } from "next/navigation";
import mongoose from "mongoose";
import { auth } from "@/lib/auth";
import { connectDB } from "@/lib/mongoose";
import TaskList from "@/models/TaskList";
import Task from "@/models/Task";
import TaskLog from "@/models/TaskLog";
import User from "@/models/User";
import Company from "@/models/Company";
import Todo, { serializeTodo, todosForDateQuery } from "@/models/Todo";
import { seedDefaultTaskLists, ensureAnytimeTaskList } from "@/lib/seed";
import { getSessionSummariesForDate } from "@/lib/task-list-session-actions";
import { resolveTasks } from "@/lib/task-definitions";
import { calendarWeekDates } from "@/lib/week-dates";
import { todayInZone } from "@/lib/task-list-window";
import TasksView from "@/components/TasksView";
import type { LogState } from "@/models/TaskLog";
import type { InstructionStep } from "@/models/TaskDefinition";
import { resolveSessionUser, pickActiveLocationId } from "@/lib/session";
import NoCompanyMessage from "@/components/NoCompanyMessage";

export const dynamic = "force-dynamic";

export default async function TasksPage({
  searchParams,
}: {
  searchParams?: {
    startNext?: string; addTask?: string; date?: string; resumeTimer?: string;
    openTaskId?: string; verifiedNfcUid?: string;
  };
}) {
  const skipAuth = process.env.SKIP_AUTH === "true";
  const session = await auth();

  if (!skipAuth && !session?.user?.id) redirect("/login");

  const sessionUser = await resolveSessionUser();
  if (!sessionUser) redirect("/login");
  const { companyId, userId, role } = sessionUser;
  // The location this page's data is actually scoped to — for an owner,
  // this is their switcher selection (or their own default if unset); for
  // an employee/manager it's always just their own. See
  // docs/features/locations.md's "Location switcher".
  const locationId = pickActiveLocationId(sessionUser, null);

  const userName = session?.user?.name ?? "Developer";

  if (!companyId) {
    return <NoCompanyMessage userName={userName} />;
  }

  await connectDB();

  // First-time seeds — per LOCATION, not per company/user: the first
  // employee or manager to load this page at a location with no lists yet
  // (a newly-attached company's very first location, or any location added
  // later under an existing company) seeds its own default task lists,
  // independent of whatever lists any other location under the same
  // company already has.
  const taskListCount = await TaskList.countDocuments({ companyId, locationId });
  if (taskListCount === 0) await seedDefaultTaskLists(companyId, locationId);
  await ensureAnytimeTaskList(companyId, locationId);

  // Which chirp to play on this device for an NFC scan-to-complete save —
  // see lib/notification-sound.ts and models/Company.ts. Fetched here
  // (rather than lower down) so its timezone is also available below, for
  // computing "today" without the client-supplied ?date= param.
  const company = await Company.findById(companyId, "notificationSound timezone").lean<{
    notificationSound?: string;
    timezone?: string | null;
  }>();
  const notificationSound = (company?.notificationSound === "male" ? "male" : "standard") as "standard" | "male";

  // Prefer the client-supplied date (it knows the user's actual local
  // timezone). Absent that — e.g. a cold app launch before TasksView's own
  // self-correcting useEffect has round-tripped — fall back to the
  // company's configured timezone rather than raw server UTC: from ~5pm to
  // midnight in any timezone behind UTC, `new Date().toISOString()` has
  // already rolled to tomorrow, which silently attributed evening task
  // completions to the wrong date before this fix. Only a company with no
  // timezone set (Company.timezone is optional — see the Company model)
  // still falls back to server UTC here.
  const today = searchParams?.date ?? (company?.timezone ? todayInZone(company.timezone) : new Date().toISOString().split("T")[0]);
  const weekDates = calendarWeekDates(today);

  // Sorted by startTime, not insertion order — a manager-created "1:00 PM"
  // list should sit between the 10:00 AM and 6:00 PM ones regardless of
  // when it was added, and a list's position should move automatically the
  // moment its startTime changes rather than needing a separate manual
  // reorder step. `order` is now only a same-time tie-breaker (e.g. a
  // duplicated list — see POST .../duplicate — always sorts immediately
  // after its source, since it inherits the same startTime but a strictly
  // later `order`). Anytime lists (startTime: null) sort before every timed
  // one under this key, but that's harmless — TasksView splits them into
  // their own section immediately below and never treats this array's raw
  // order as final for them.
  const taskLists = await TaskList.find({ companyId, locationId, isActive: true }).sort({ startTime: 1, order: 1 }).lean();

  // Single query for every list's tasks instead of one query per list — the
  // result is already sorted by order, so grouping it in memory below
  // preserves each list's task order exactly as the old per-list query did.
  const rawTasks = await Task.find({
    taskListId: { $in: taskLists.map((tl) => tl._id) },
    companyId,
    locationId,
    isActive: true,
  })
    .sort({ order: 1 })
    .lean();
  const allTasks = await resolveTasks(rawTasks);

  const tasksByTaskListId = new Map<string, typeof allTasks>();
  for (const task of allTasks) {
    const key = task.taskListId.toString();
    const list = tasksByTaskListId.get(key);
    if (list) list.push(task);
    else tasksByTaskListId.set(key, [task]);
  }

  const taskListsWithTasks = taskLists.map((taskList) => {
    const tasks = tasksByTaskListId.get(taskList._id.toString()) ?? [];
    return {
      _id: taskList._id.toString(),
      name: taskList.name,
      timeOfDay: taskList.timeOfDay as "morning" | "evening" | "custom" | "anytime",
      startTime: taskList.startTime ?? null,
      order: taskList.order,
      tasks: tasks.map((task) => ({
        _id: task._id.toString(),
        name: task.name,
        icon: task.icon,
        projectedMinutes: task.projectedMinutes,
        order: task.order,
        taskType: task.taskType,
        // scheduledDays/successThreshold are placement fields — existing
        // documents predate them, and Mongoose defaults only apply on
        // create, so a .lean() read can come back undefined. name/icon/
        // formFields/nfcTagUid come resolved from resolveTasks above and
        // are always present.
        scheduledDays: task.scheduledDays ?? [0, 1, 2, 3, 4, 5, 6],
        successThreshold: task.successThreshold ?? (task.scheduledDays?.length ?? 7),
        formFields: task.formFields,
        nfcTagUid: task.nfcTagUid,
        // Gates whether an employee must attach a completion photo before
        // this task can be marked done — see
        // docs/features/task-completion-photo.md. Also resolved from
        // resolveTasks above, same as formFields/nfcTagUid.
        requiresPhoto: task.requiresPhoto,
        // Manager-authored "what this should look like when done" steps —
        // see docs/features/task-instructions-employee-view.md. Also
        // resolved from resolveTasks above, same as formFields/nfcTagUid.
        instructionSteps: task.instructionSteps.map((s: InstructionStep) => ({
          _id: s._id.toString(),
          description: s.description,
          imageUrl: s.imageUrl,
        })),
      })),
    };
  });

  // Today's logs for initial state — shared across everyone AT THIS
  // LOCATION (any employee's completion of a shared task should show up for
  // every teammate at their own store), not the whole company — see
  // docs/features/locations.md.
  const todayLogs = await TaskLog.find({ companyId, locationId, date: today }).lean();

  // Today's most recent TaskListSession per list — start/end time + who
  // opened it first ("session owner"), for TaskListCard's "✓ Done" pill; or,
  // when nothing's been started yet, a pre-assigned shift lead instead, for
  // the shift-lead pre-assignment row — see
  // docs/features/shift-lead-preassignment.md. See
  // lib/task-list-session-actions.ts's getSessionSummariesForDate.
  const sessionSummaries = await getSessionSummariesForDate(companyId, locationId, today);

  // Every log's performedByUserId, resolved into a display name — the
  // initial paint of TaskRow's/TaskCard's in_progress/paused claim pill AND
  // a done/missed row's "by <name>" attribution (visible to every teammate,
  // not just managers) both need this. Same resolution GET /api/task-logs
  // itself does for the client's later polling refetches — see
  // docs/features/task-lists.md's "Per-task claiming". Folded together with
  // each session's own performedByUserId (its "session owner") so both
  // resolve off a single User query.
  const performedByIds = Array.from(
    new Set(
      [
        ...todayLogs.map((l) => l.performedByUserId),
        ...sessionSummaries.map((s) => s.performedByUserId),
        ...sessionSummaries.map((s) => s.assignedUserId),
      ].filter((id): id is string => !!id && mongoose.isValidObjectId(id))
    )
  );
  const performers = performedByIds.length > 0 ? await User.find({ _id: { $in: performedByIds } }, "name").lean() : [];
  const nameByPerformerId = new Map(performers.map((u) => [u._id.toString(), u.name as string | undefined]));

  const initialSessions = sessionSummaries.map((s) => ({
    taskListId: s.taskListId,
    status: s.status,
    startedAt: s.startedAt ? s.startedAt.toISOString() : null,
    completedAt: s.completedAt ? s.completedAt.toISOString() : null,
    ownerName: s.performedByUserId ? nameByPerformerId.get(s.performedByUserId) ?? "someone else" : null,
    assignedUserId: s.assignedUserId,
    assignedUserName: s.assignedUserId ? nameByPerformerId.get(s.assignedUserId) ?? "someone else" : null,
  }));

  const initialLogs = todayLogs.map((l) => ({
    _id: l._id.toString(),
    taskId: l.taskId.toString(),
    date: l.date,
    actualMinutes: l.actualMinutes ?? undefined,
    startedAt: l.startedAt ? (l.startedAt as Date).toISOString() : undefined,
    completedAt: l.completedAt ? (l.completedAt as Date).toISOString() : undefined,
    pausedSeconds: l.pausedSeconds ?? 0,
    state: l.state as LogState,
    formData: l.formData ?? null,
    photoUrl: l.photoUrl ?? null,
    // Was missing from this mapping entirely — every fresh server render
    // (e.g. the FAB's "Resume" pill navigating to ?resumeTimer=1, which is
    // a full force-dynamic round-trip, not a client-only state change)
    // reconstructed openInProgressTimer's decision from an always-null
    // sessionTaskListId, so a session-anchored in-progress task always fell
    // through to the standalone TimerScreen/TaskFormScreen branch instead
    // of reopening the guided TaskListSessionView — "the task can be
    // completed but the task list can't be continued." See TasksView.tsx's
    // openInProgressTimer.
    sessionTaskListId: l.sessionTaskListId ? l.sessionTaskListId.toString() : null,
    performedByUserId: l.performedByUserId ?? null,
    performedByName: l.performedByUserId ? nameByPerformerId.get(l.performedByUserId) ?? "someone else" : null,
  }));

  // 7-day streak logs
  const rawWeekLogs = await TaskLog.find({
    companyId,
    locationId,
    date: { $in: weekDates },
  }).lean();

  const weekLogs = rawWeekLogs.map((l) => ({
    taskId: l.taskId.toString(),
    date: l.date,
    state: l.state as "done" | "missed" | "rest",
    actualMinutes: l.actualMinutes ?? null,
  }));

  // Today's standalone to-dos, plus any earlier undone ones carried forward as overdue
  const todayTodos = await Todo.find(todosForDateQuery(companyId, userId, today))
    .sort({ scheduledDate: 1, order: 1, createdAt: 1 })
    .lean();
  const initialTodos = todayTodos.map(serializeTodo);

  return (
    <TasksView
      taskLists={taskListsWithTasks}
      initialLogs={initialLogs}
      initialSessions={initialSessions}
      initialTodos={initialTodos}
      weekLogs={weekLogs}
      weekDates={weekDates}
      today={today}
      userName={userName}
      userId={userId}
      userRole={role}
      companyId={companyId}
      activeLocationId={locationId}
      locationId={sessionUser.locationId}
      skipAuth={skipAuth}
      autoStartNext={!!searchParams?.startNext}
      autoAddTask={!!searchParams?.addTask}
      autoResumeTimer={!!searchParams?.resumeTimer}
      autoOpenTaskId={searchParams?.openTaskId ?? null}
      autoOpenVerifiedNfcUid={searchParams?.verifiedNfcUid ?? null}
      notificationSound={notificationSound}
    />
  );
}
