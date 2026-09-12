import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { connectDB } from "@/lib/mongoose";
import TaskList from "@/models/TaskList";
import Task from "@/models/Task";
import type { TaskType, InstructionStep } from "@/models/TaskDefinition";
import TaskListEditView from "@/components/TaskListEditView";
import { resolveTasks } from "@/lib/task-definitions";
import { resolveSessionUser, isManagerOrAbove } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function EditTaskListPage({
  params,
}: {
  params: { taskListId: string };
}) {
  const skipAuth = process.env.SKIP_AUTH === "true";
  const session = await auth();
  if (!skipAuth && !session?.user?.id) redirect("/login");

  const sessionUser = await resolveSessionUser();
  if (!sessionUser) redirect("/login");
  const { companyId, role } = sessionUser;
  if (!companyId) redirect("/tasks");

  await connectDB();

  const taskList = await TaskList.findOne({ _id: params.taskListId, companyId }).lean();
  if (!taskList) redirect("/tasks");

  const rawTasks = await Task.find({
    taskListId: params.taskListId,
    companyId,
    isActive: true,
  })
    .sort({ order: 1 })
    .lean();
  const tasks = await resolveTasks(rawTasks);

  const userName = session?.user?.name ?? "Developer";

  return (
    <TaskListEditView
      userName={userName}
      skipAuth={skipAuth}
      isManager={isManagerOrAbove(role)}
      taskList={{
        _id: taskList._id.toString(),
        name: taskList.name,
        startTime: taskList.startTime ?? null,
        scheduledDays: taskList.scheduledDays ?? [0, 1, 2, 3, 4, 5, 6],
      }}
      tasks={tasks.map((t) => ({
        _id: t._id.toString(),
        name: t.name,
        icon: t.icon,
        projectedMinutes: t.projectedMinutes,
        order: t.order,
        taskType: (t.taskType ?? "form") as TaskType,
        formFields: t.formFields ?? [],
        // Existing documents predate these fields — Mongoose defaults only
        // apply on create, so a .lean() read can come back undefined.
        scheduledDays: t.scheduledDays ?? [0, 1, 2, 3, 4, 5, 6],
        successThreshold: t.successThreshold ?? (t.scheduledDays?.length ?? 7),
        nfcTagUid: t.nfcTagUid ?? null,
        // Definition-level fields — see docs/features/unified-task-edit-surface.md.
        // definitionId lets SortableRow's Instructions/Require Photo/Linked
        // Inventory panels call the definitionId-scoped routes directly,
        // same as the Task Catalog's CatalogRow does.
        definitionId: t.definitionId.toString(),
        instructionSteps: (t.instructionSteps ?? []).map((s: InstructionStep) => ({
          _id: s._id.toString(),
          description: s.description ?? null,
          imageUrl: s.imageUrl ?? null,
        })),
        requiresPhoto: t.requiresPhoto ?? false,
      }))}
    />
  );
}
