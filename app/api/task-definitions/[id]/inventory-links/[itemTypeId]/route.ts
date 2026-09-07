import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import TaskDefinition from "@/models/TaskDefinition";
import { addOrUpdateInventoryLink, removeInventoryLink, getInventoryLinksForTaskDefinition } from "@/lib/inventory";
import { resolveSessionUser, isManagerOrAbove } from "@/lib/session";

export const dynamic = "force-dynamic";

// PATCH /api/task-definitions/[id]/inventory-links/[itemTypeId] — toggle
// required/optional on an existing link, addressed by definitionId — see
// app/api/task-definitions/[id]/inventory-links/route.ts. Manager-only,
// body: { required }.
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

  const definition = await TaskDefinition.findOne({ _id: params.id, companyId }).select("_id").lean();
  if (!definition) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await addOrUpdateInventoryLink(companyId, params.id, params.itemTypeId, body.required);
  const links = await getInventoryLinksForTaskDefinition(companyId, params.id);
  return NextResponse.json(links);
}

// DELETE /api/task-definitions/[id]/inventory-links/[itemTypeId] — unlink.
// Manager-only. Removes only this one TaskInventoryLink row — the
// InventoryItemType and its InventoryLog history are untouched, see
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

  const definition = await TaskDefinition.findOne({ _id: params.id, companyId }).select("_id").lean();
  if (!definition) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await removeInventoryLink(companyId, params.id, params.itemTypeId);
  return NextResponse.json({ ok: true });
}
