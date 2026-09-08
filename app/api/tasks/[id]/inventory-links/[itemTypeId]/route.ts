import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import Task from "@/models/Task";
import { addOrUpdateInventoryLink, removeInventoryLink, getInventoryLinksForTaskDefinition } from "@/lib/inventory";
import { resolveSessionUser, isManagerOrAbove } from "@/lib/session";

export const dynamic = "force-dynamic";

// PATCH /api/tasks/[id]/inventory-links/[itemTypeId] — toggle required/
// optional on an existing link. Manager-only, body: { required }.
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; itemTypeId: string } }
) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const body = await req.json();
  if (typeof body.required !== "boolean") {
    return NextResponse.json({ error: "Missing required" }, { status: 400 });
  }

  await connectDB();

  const task = await Task.findOne({ _id: params.id, companyId }).select("definitionId locationId").lean();
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const link = await addOrUpdateInventoryLink(companyId, task.locationId, task.definitionId.toString(), params.itemTypeId, body.required);
  if (!link) return NextResponse.json({ error: "Item type not found" }, { status: 404 });
  const links = await getInventoryLinksForTaskDefinition(companyId, task.locationId, task.definitionId.toString());
  return NextResponse.json(links);
}

// DELETE /api/tasks/[id]/inventory-links/[itemTypeId] — unlink. Manager-
// only. Removes only this one TaskInventoryLink row — the InventoryItemType
// and its InventoryLog history are completely untouched, see
// docs/features/inventory.md's "Task ↔ Inventory Linking".
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; itemTypeId: string } }
) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });

  await connectDB();

  const task = await Task.findOne({ _id: params.id, companyId }).select("definitionId").lean();
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await removeInventoryLink(companyId, task.definitionId.toString(), params.itemTypeId);
  return NextResponse.json({ ok: true });
}
