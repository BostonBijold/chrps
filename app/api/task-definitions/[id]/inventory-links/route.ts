import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import TaskDefinition from "@/models/TaskDefinition";
import { getInventoryLinksForTaskDefinition, addOrUpdateInventoryLink } from "@/lib/inventory";
import { resolveSessionUser, isManagerOrAbove } from "@/lib/session";

export const dynamic = "force-dynamic";

// GET /api/task-definitions/[id]/inventory-links — every InventoryItemType
// linked to this saved task, addressed by its own definitionId rather than
// through one of its placements. Needed for a definition with zero active
// placements (or one being edited from the Company Task Catalog, which has
// no placement in context) — app/api/tasks/[id]/inventory-links is the
// placement-addressed equivalent used by TaskListEditView's per-row panel;
// both resolve to and share the exact same TaskInventoryLink rows (keyed by
// taskDefinitionId, see docs/features/inventory.md's "Task ↔ Inventory
// Linking"), just reached a different way. Open to any signed-in company
// user, same as the placement-keyed route — only creating/editing a link is
// manager-only, below.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });

  await connectDB();

  const definition = await TaskDefinition.findOne({ _id: params.id, companyId }).select("locationId").lean();
  if (!definition) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const links = await getInventoryLinksForTaskDefinition(companyId, definition.locationId, params.id);
  return NextResponse.json(links);
}

// POST /api/task-definitions/[id]/inventory-links — link an
// InventoryItemType to this saved task (or update an existing link's
// `required` flag — re-linking an already-linked item is an upsert, not a
// duplicate). Manager-only, body: { itemTypeId, required }.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const body = await req.json();
  const itemTypeId = typeof body.itemTypeId === "string" ? body.itemTypeId : null;
  if (!itemTypeId) return NextResponse.json({ error: "Missing itemTypeId" }, { status: 400 });
  const required = body.required === true;

  await connectDB();

  const definition = await TaskDefinition.findOne({ _id: params.id, companyId }).select("locationId").lean();
  if (!definition) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const link = await addOrUpdateInventoryLink(companyId, definition.locationId, params.id, itemTypeId, required);
  if (!link) return NextResponse.json({ error: "Item type not found" }, { status: 404 });
  const links = await getInventoryLinksForTaskDefinition(companyId, definition.locationId, params.id);
  return NextResponse.json(links);
}
