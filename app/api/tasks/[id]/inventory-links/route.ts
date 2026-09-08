import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import Task from "@/models/Task";
import { getInventoryLinksForTaskDefinition, addOrUpdateInventoryLink } from "@/lib/inventory";
import { resolveSessionUser, isManagerOrAbove } from "@/lib/session";

export const dynamic = "force-dynamic";

// GET /api/tasks/[id]/inventory-links — every InventoryItemType linked to
// this task, joined with name/unit/nfcTagUid/required — see
// docs/features/inventory.md's "Task ↔ Inventory Linking". Addressed by
// [id] (a specific list placement, matching how it's called from a single
// row in TaskListEditView, and from TaskFormScreen when a task opens), but
// resolves to the definition server-side the same way
// app/api/tasks/[id]/nfc-tag does — links are shared by every list this
// saved task is placed in, not just the one the manager happened to link
// from. Open to any signed-in company user (TaskFormScreen needs this for
// employees too, not just managers) — only creating/editing a link is
// manager-only, below.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });

  await connectDB();

  const task = await Task.findOne({ _id: params.id, companyId }).select("definitionId locationId").lean();
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const links = await getInventoryLinksForTaskDefinition(companyId, task.locationId, task.definitionId.toString());
  return NextResponse.json(links);
}

// POST /api/tasks/[id]/inventory-links — link an InventoryItemType to this
// task (or update an existing link's `required` flag — re-linking an
// already-linked item is an upsert, not a duplicate). Manager-only, body:
// { itemTypeId, required }.
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

  const task = await Task.findOne({ _id: params.id, companyId }).select("definitionId locationId").lean();
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const link = await addOrUpdateInventoryLink(companyId, task.locationId, task.definitionId.toString(), itemTypeId, required);
  if (!link) return NextResponse.json({ error: "Item type not found" }, { status: 404 });
  const links = await getInventoryLinksForTaskDefinition(companyId, task.locationId, task.definitionId.toString());
  return NextResponse.json(links);
}
