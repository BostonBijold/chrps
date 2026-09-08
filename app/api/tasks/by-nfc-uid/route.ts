import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import TaskDefinition from "@/models/TaskDefinition";
import InventoryItemType from "@/models/InventoryItemType";
import { resolveMostRelevantPlacement } from "@/lib/task-definitions";
import { resolveFabScanTarget } from "@/lib/task-list-session-actions";
import { resolveSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

// GET /api/tasks/by-nfc-uid?uid=<uid>&date=<local date>&nowMinutes=<local
// minutes since midnight>[&targetType=task|inventory&targetId=<id>] —
// resolves a scanned physical tag's raw UID (see docs/features/nfc.md's
// "In-app scan-to-complete binding" and "Multi-target binding") to
// whichever target(s) it's bound to, for the FAB's "scan to open" shortcut
// (components/BottomNav.tsx). Open to any signed-in company user — same
// "any employee on shift" philosophy as triggering an already-linked
// tap-to-trigger tag; only binding a tag in the first place is manager-only.
// Kept at this URL (not renamed/moved) even though it now also resolves
// InventoryItemType — Part 1's spec explicitly anticipated this route being
// Inventory's "replacement/sibling," and there was no reason to churn every
// caller for a rename alone.
//
// A tag can back more than one target across BOTH TaskDefinition and
// InventoryItemType — see docs/features/nfc.md's "Multi-target binding" —
// so this branches on how many active targets the UID currently resolves
// to, combined across both collections:
//   - zero  → 404, same "not recognized" response as before
//   - one   → resolved directly: a TaskDefinition match goes through
//             resolveMostRelevantPlacement → resolveFabScanTarget exactly
//             as before; an InventoryItemType match just opens it, pre-
//             verified — there's no session/lock/already-logged concept for
//             an append-only inventory count.
//   - many  → { mode: "disambiguate", options: [...] } — the caller (the
//             FAB) shows a picker; tapping an option re-calls this same
//             route with targetType/targetId set, which skips straight to
//             the single-target resolution for that one target using the
//             SAME uid already scanned — no second scan needed, since the
//             uid itself is what verifies the eventual completion.
export async function GET(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, userId, locationId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });

  const uid = req.nextUrl.searchParams.get("uid");
  if (!uid) return NextResponse.json({ error: "Missing uid" }, { status: 400 });
  const normalizedUid = uid.toLowerCase();
  const date = req.nextUrl.searchParams.get("date") ?? new Date().toISOString().split("T")[0];
  const nowMinutesParam = req.nextUrl.searchParams.get("nowMinutes");
  const nowMinutes = nowMinutesParam !== null ? Number(nowMinutesParam) : null;
  const targetType = req.nextUrl.searchParams.get("targetType");
  const targetId = req.nextUrl.searchParams.get("targetId");

  const NOT_LINKED = NextResponse.json({ error: "No task is linked to this tag" }, { status: 404 });

  await connectDB();

  const resolveTaskDefinitionTarget = async (definitionId: string) => {
    const taskId = await resolveMostRelevantPlacement(companyId, locationId, definitionId, date, nowMinutes);
    if (!taskId) return null;
    const resolution = await resolveFabScanTarget(companyId, locationId, userId, taskId.toString(), date);
    if (!resolution) return null;
    const { kind, ...rest } = resolution;
    return NextResponse.json({ mode: kind, ...rest });
  };

  const resolveInventoryItemTarget = (itemTypeId: string) =>
    NextResponse.json({ mode: "inventory" as const, itemTypeId });

  // Post-disambiguation second call — the user already picked one option
  // from the picker built below, using the same scanned uid. Re-verify the
  // uid still matches this exact target (defensive, not load-bearing) and
  // resolve it directly, skipping the multi-match branch entirely.
  if (targetId) {
    if (targetType === "inventory") {
      const itemType = await InventoryItemType.findOne({
        _id: targetId,
        companyId,
        locationId,
        nfcTagUid: normalizedUid,
        isActive: true,
      })
        .select("_id")
        .lean();
      if (!itemType) return NOT_LINKED;
      return resolveInventoryItemTarget(itemType._id.toString());
    }
    if (targetType && targetType !== "task") return NOT_LINKED;
    const definition = await TaskDefinition.findOne({
      _id: targetId,
      companyId,
      locationId,
      nfcTagUid: normalizedUid,
      isActive: true,
    })
      .select("_id")
      .lean();
    if (!definition) return NOT_LINKED;
    const response = await resolveTaskDefinitionTarget(definition._id.toString());
    return response ?? NOT_LINKED;
  }

  const [definitions, itemTypes] = await Promise.all([
    // Both locationId-filtered — the actual fix for the cross-location NFC
    // leak: a scan can never resolve to a TaskDefinition OR an
    // InventoryItemType that only exists at a different location. See
    // docs/features/locations.md's "Location scoping" — InventoryItemType
    // became location-owned alongside TaskDefinition, closing this gap.
    TaskDefinition.find({ companyId, locationId, nfcTagUid: normalizedUid, isActive: true }).select("_id name").lean(),
    InventoryItemType.find({ companyId, locationId, nfcTagUid: normalizedUid, isActive: true }).select("_id name").lean(),
  ]);

  const totalMatches = definitions.length + itemTypes.length;
  if (totalMatches === 0) return NOT_LINKED;

  if (totalMatches > 1) {
    const options = [
      ...definitions.map((d) => ({ targetType: "task" as const, targetId: d._id.toString(), name: d.name })),
      ...itemTypes.map((it) => ({ targetType: "inventory" as const, targetId: it._id.toString(), name: it.name })),
    ].sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ mode: "disambiguate", options });
  }

  if (itemTypes.length === 1) return resolveInventoryItemTarget(itemTypes[0]._id.toString());
  const response = await resolveTaskDefinitionTarget(definitions[0]._id.toString());
  return response ?? NOT_LINKED;
}
