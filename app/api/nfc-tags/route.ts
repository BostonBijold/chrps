import mongoose from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import NfcTag from "@/models/NfcTag";
import TaskDefinition from "@/models/TaskDefinition";
import InventoryItemType from "@/models/InventoryItemType";
import User from "@/models/User";
import { resolveSessionUser, isManagerOrAbove, pickActiveLocationId } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";

export const dynamic = "force-dynamic";

// GET /api/nfc-tags — "Manage Ch'rps" (components/ManageNfcTagsView.tsx):
// every tag claimed for this location (status `claimed` OR `retired` —
// retired stays visible so a manager can reactivate one), each joined with
// what it's currently bound to (any TaskDefinition/InventoryItemType
// sharing its UID — see docs/features/nfc.md's "Multi-target binding") and
// who claimed/last used it. Manager-or-above only, same gate as every
// other NFC-linking route. See docs/features/nfc.md's "Manage Ch'rps".
export async function GET(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  await connectDB();

  const tags = await NfcTag.find({ companyId, locationId, status: { $in: ["claimed", "retired"] } })
    .sort({ label: 1, uid: 1 })
    .lean();
  if (tags.length === 0) return NextResponse.json([]);

  const uids = tags.map((t) => t.uid);
  const [definitions, itemTypes] = await Promise.all([
    TaskDefinition.find(
      { companyId, locationId, nfcTagUid: { $in: uids }, isActive: true },
      { name: 1, nfcTagUid: 1 }
    ).lean(),
    InventoryItemType.find(
      { companyId, locationId, nfcTagUid: { $in: uids }, isActive: true },
      { name: 1, nfcTagUid: 1 }
    ).lean(),
  ]);
  const boundByUid = new Map<string, Array<{ type: "task" | "inventory"; name: string }>>();
  for (const d of definitions) {
    const list = boundByUid.get(d.nfcTagUid!) ?? [];
    list.push({ type: "task", name: d.name });
    boundByUid.set(d.nfcTagUid!, list);
  }
  for (const it of itemTypes) {
    const list = boundByUid.get(it.nfcTagUid!) ?? [];
    list.push({ type: "inventory", name: it.name });
    boundByUid.set(it.nfcTagUid!, list);
  }

  // Same "exclude SKIP_AUTH's non-ObjectId dev sentinel" filter as every
  // other User._id batch-join in this app (e.g. GET /api/inventory-item-types).
  const userIds = Array.from(
    new Set(tags.flatMap((t) => [t.claimedByUserId, t.lastUsedByUserId]).filter((id): id is string => !!id))
  ).filter((id) => mongoose.isValidObjectId(id));
  const users = userIds.length > 0 ? await User.find({ _id: { $in: userIds } }, "name").lean() : [];
  const nameById = new Map(users.map((u) => [u._id.toString(), u.name ?? "Unknown"]));

  return NextResponse.json(
    tags.map((t) => ({
      uid: t.uid,
      status: t.status,
      label: t.label ?? null,
      claimedAt: t.claimedAt ? t.claimedAt.toISOString() : null,
      claimedByName: t.claimedByUserId ? nameById.get(t.claimedByUserId) ?? "Unknown" : null,
      lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
      lastUsedByName: t.lastUsedByUserId ? nameById.get(t.lastUsedByUserId) ?? "Unknown" : null,
      boundTo: boundByUid.get(t.uid) ?? [],
    }))
  );
}
