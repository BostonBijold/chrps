import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { connectDB } from "@/lib/mongoose";
import TaskList from "@/models/TaskList";
import Task from "@/models/Task";
import { resolveTasks } from "@/lib/task-definitions";
import { resolveSessionUser, isManagerOrAbove, pickActiveLocationId } from "@/lib/session";
import ManageTasksView from "@/components/ManageTasksView";

export const dynamic = "force-dynamic";

// Manager-only "Manage Tasks" screen — task lists (tap to rename/schedule/
// delete), the standalone (anytime-list) tasks, and the company's full
// saved-task catalog (see docs/features/task-lists.md's "Company Task
// Catalog" section) where NFC tags get tied to a task, regardless of which
// list(s) use it. Not part of the bottom nav — see CLAUDE.md's Bottom Nav
// section for the current tab shape — reached from a manager-only icon in
// the Tasks page header and from the Profile page.
export default async function ManageTasksPage() {
  const skipAuth = process.env.SKIP_AUTH === "true";
  const session = await auth();
  if (!skipAuth && !session?.user?.id) redirect("/login");

  const sessionUser = await resolveSessionUser();
  if (!sessionUser) redirect("/login");
  const { companyId } = sessionUser;
  if (!companyId) redirect("/tasks");
  if (!isManagerOrAbove(sessionUser.role)) redirect("/tasks");

  // Same as app/(app)/tasks/page.tsx — an owner's switcher selection (or
  // their own default if unset), a manager/employee's own fixed location.
  // Without this, a manager managing lists would see (and be able to edit/
  // delete) every location's task lists, not just the one they're on.
  const locationId = pickActiveLocationId(sessionUser, null);

  await connectDB();

  // Sorted by startTime, not insertion order — see the matching note in
  // app/(app)/tasks/page.tsx. `order` is only a same-time tie-breaker, which
  // is what makes a freshly duplicated list (same startTime as its source,
  // strictly later `order`) land right next to the list it was copied from.
  const taskLists = await TaskList.find({ companyId, locationId, isActive: true }).sort({ startTime: 1, order: 1 }).lean();
  const scheduledTaskLists = taskLists.filter((tl) => tl.timeOfDay !== "anytime");
  const anytimeTaskLists = taskLists.filter((tl) => tl.timeOfDay === "anytime");
  const anytimeTaskListIds = anytimeTaskLists.map((tl) => tl._id);
  const anytimeListNameById = new Map(anytimeTaskLists.map((tl) => [tl._id.toString(), tl.name]));

  const rawStandaloneTasks = await Task.find({
    taskListId: { $in: anytimeTaskListIds },
    companyId,
    locationId,
    isActive: true,
  })
    .sort({ order: 1 })
    .lean();
  const standaloneTasks = await resolveTasks(rawStandaloneTasks);

  const today = new Date().toISOString().split("T")[0];
  const userName = session?.user?.name ?? "Developer";

  return (
    <ManageTasksView
      userName={userName}
      today={today}
      skipAuth={skipAuth}
      taskLists={scheduledTaskLists.map((tl) => ({
        _id: tl._id.toString(),
        name: tl.name,
        startTime: tl.startTime ?? null,
      }))}
      standaloneTasks={standaloneTasks.map((t) => ({
        _id: t._id.toString(),
        name: t.name,
        icon: t.icon,
        projectedMinutes: t.projectedMinutes,
        taskListId: t.taskListId.toString(),
        taskListName: anytimeListNameById.get(t.taskListId.toString()) ?? "Anytime Tasks",
      }))}
    />
  );
}
