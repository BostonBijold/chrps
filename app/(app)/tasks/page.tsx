import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { connectDB } from "@/lib/mongoose";
import TaskList from "@/models/TaskList";
import Task from "@/models/Task";
import TaskLog from "@/models/TaskLog";
import Company from "@/models/Company";
import Todo, { serializeTodo, todosForDateQuery } from "@/models/Todo";
import { seedDefaultTaskLists, ensureAnytimeTaskList } from "@/lib/seed";
import { resolveTasks } from "@/lib/task-definitions";
import { calendarWeekDates } from "@/lib/week-dates";
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
    openSessionTaskId?: string; openSessionListId?: string;
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

  // Always trust the client-supplied date (local timezone).
  // Never fall back to server UTC — the server doesn't know the user's timezone.
  // The client-side useEffect in TasksView will redirect with ?date= on first load.
  const today = searchParams?.date ?? new Date().toISOString().split("T")[0];
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

  // Which chirp to play on this device for an NFC scan-to-complete save —
  // see lib/notification-sound.ts and models/Company.ts.
  const company = await Company.findById(companyId, "notificationSound").lean<{ notificationSound?: string }>();
  const notificationSound = (company?.notificationSound === "male" ? "male" : "standard") as "standard" | "male";

  return (
    <TasksView
      taskLists={taskListsWithTasks}
      initialLogs={initialLogs}
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
      autoOpenSessionTaskId={searchParams?.openSessionTaskId ?? null}
      autoOpenSessionListId={searchParams?.openSessionListId ?? null}
      notificationSound={notificationSound}
    />
  );
}
