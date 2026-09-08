import TaskList from "@/models/TaskList";
import Task from "@/models/Task";
import TaskDefinition from "@/models/TaskDefinition";
import TaskTemplate from "@/models/TaskTemplate";
import {
  ensureSystemTemplates,
  DEFAULT_OPENING_NAMES,
  DEFAULT_MIDSHIFT_NAMES,
  DEFAULT_CLOSING_NAMES,
} from "@/lib/seed-templates";

export async function seedDefaultTaskLists(companyId: string, locationId: string | null) {
  // Ensure the catalog exists before referencing it
  await ensureSystemTemplates();

  const opening = await TaskList.create({
    companyId,
    locationId,
    name: "Opening Shift",
    timeOfDay: "morning",
    startTime: "08:00",
    order: 0,
    isDefault: true,
  });

  const midShift = await TaskList.create({
    companyId,
    locationId,
    name: "Mid-Shift",
    timeOfDay: "custom",
    startTime: "13:00",
    order: 1,
    isDefault: true,
  });

  const closing = await TaskList.create({
    companyId,
    locationId,
    name: "Closing Shift",
    timeOfDay: "evening",
    startTime: "21:00",
    order: 2,
    isDefault: true,
  });

  // Pull templates from DB by name so order + IDs are correct
  const [openingTemplates, midShiftTemplates, closingTemplates] = await Promise.all([
    TaskTemplate.find({ name: { $in: DEFAULT_OPENING_NAMES }, isSystem: true }).lean(),
    TaskTemplate.find({ name: { $in: DEFAULT_MIDSHIFT_NAMES }, isSystem: true }).lean(),
    TaskTemplate.find({ name: { $in: DEFAULT_CLOSING_NAMES }, isSystem: true }).lean(),
  ]);

  // Preserve the canonical order defined in DEFAULT_*_NAMES
  const sortByDefault = (templates: typeof openingTemplates, names: readonly string[]) =>
    [...templates].sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));

  // Each seeded task is created as a TaskDefinition (the reusable saved
  // check) plus a single Task placement referencing it — see the "Company
  // Task Catalog" design. Nothing seeded here is placed in more than one
  // list, so this is a 1:1 pairing today, but each seeded task still lands
  // in the shared company catalog (Available Tasks) like any other.
  const insertForList = async (
    taskListId: typeof opening._id,
    templates: typeof openingTemplates,
    names: readonly string[]
  ) => {
    const sorted = sortByDefault(templates, names);
    const definitions = await TaskDefinition.insertMany(
      sorted.map((t) => ({
        companyId,
        locationId,
        templateId: t._id,
        name: t.name,
        icon: t.icon,
        taskType: "form",
        projectedMinutes: t.defaultProjectedMinutes,
        formFields: t.formFields ?? [],
        nfcTagUid: null,
        isActive: true,
      }))
    );
    await Task.insertMany(
      definitions.map((d, i) => ({
        companyId,
        locationId,
        taskListId,
        definitionId: d._id,
        projectedMinutes: null,
        order: i,
        isActive: true,
      }))
    );
  };

  await Promise.all([
    insertForList(opening._id, openingTemplates, DEFAULT_OPENING_NAMES),
    insertForList(midShift._id, midShiftTemplates, DEFAULT_MIDSHIFT_NAMES),
    insertForList(closing._id, closingTemplates, DEFAULT_CLOSING_NAMES),
  ]);
}

// Idempotent — creates a standalone "Anytime Tasks" list (timeOfDay:
// 'anytime' — same standalone-list mechanics as any manager-created task
// list, just seeded with example form tasks) if none exists. These are
// anytime/recurring tasks (fridge/freezer temps, restroom checklists) that
// don't belong to a single shift window.
export async function ensureAnytimeTaskList(companyId: string, locationId: string | null) {
  const existing = await TaskList.findOne({ companyId, locationId, timeOfDay: "anytime" });
  if (existing) return;

  const topList = await TaskList.findOne({ companyId, locationId }).sort({ order: -1 }).lean();
  const nextOrder = topList ? topList.order + 1 : 10;

  const list = await TaskList.create({
    companyId,
    locationId,
    name: "Anytime Tasks",
    timeOfDay: "anytime",
    startTime: null,
    order: nextOrder,
    isDefault: false,
  });

  const definitions = await TaskDefinition.insertMany([
    {
      companyId,
      locationId,
      templateId: null,
      name: "Fridge",
      icon: "refrigerator",
      taskType: "form",
      projectedMinutes: 2,
      isActive: true,
      formFields: [
        { key: "temperature", label: "Fridge temperature", type: "number", unit: "°F", min: 33, max: 40 },
      ],
    },
    {
      companyId,
      locationId,
      templateId: null,
      name: "Freezer",
      icon: "snowflake",
      taskType: "form",
      projectedMinutes: 2,
      isActive: true,
      formFields: [
        { key: "temperature", label: "Freezer temperature", type: "number", unit: "°F", max: 0 },
      ],
    },
    {
      companyId,
      locationId,
      templateId: null,
      name: "Men's Room",
      icon: "toilet",
      taskType: "form",
      projectedMinutes: 3,
      isActive: true,
      formFields: [
        { key: "clean", label: "Clean", type: "boolean" },
        { key: "stocked", label: "Stocked (soap, paper towels, TP)", type: "boolean" },
      ],
    },
    {
      companyId,
      locationId,
      templateId: null,
      name: "Women's Room",
      icon: "toilet",
      taskType: "form",
      projectedMinutes: 3,
      isActive: true,
      formFields: [
        { key: "clean", label: "Clean", type: "boolean" },
        { key: "stocked", label: "Stocked (soap, paper towels, TP)", type: "boolean" },
      ],
    },
  ]);

  await Task.insertMany(
    definitions.map((d, i) => ({
      companyId,
      locationId,
      taskListId: list._id,
      definitionId: d._id,
      projectedMinutes: null,
      order: i,
      isActive: true,
    }))
  );
}
