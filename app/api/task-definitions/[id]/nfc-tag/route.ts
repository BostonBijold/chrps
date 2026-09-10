import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import { bindNfcTag, unbindNfcTag } from "@/lib/task-definitions";
import { resolveSessionUser, isManagerOrAbove, pickActiveLocationId } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";
import { NfcTagNotClaimedError } from "@/lib/nfc-tags";

export const dynamic = "force-dynamic";

// POST /api/task-definitions/[id]/nfc-tag — binds a physical tag's raw UID
// directly to a TaskDefinition, by its own id — used by the Manage Tasks
// screen's company task catalog (components/ManageTasksView.tsx), which
// lists every saved task regardless of whether it's placed in any list yet.
// app/api/tasks/[id]/nfc-tag is the placement-addressed equivalent used by
// TaskListEditView's per-row "Scan-to-Complete Tag" panel; both share
// lib/task-definitions.ts's bindNfcTag/unbindNfcTag. A tag can back more
// than one target (see docs/features/nfc.md's "Multi-target binding"), so
// binding here never rejects or clears another definition's binding —
// Manager-only, same gate as the other NFC-linking routes.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  const { uid } = await req.json();
  if (!uid || typeof uid !== "string") {
    return NextResponse.json({ error: "Missing uid" }, { status: 400 });
  }

  await connectDB();

  let bound;
  try {
    bound = await bindNfcTag(companyId, locationId, params.id, uid);
  } catch (err) {
    if (err instanceof NfcTagNotClaimedError) {
      return NextResponse.json({ error: err.message, reason: "unclaimed" }, { status: 409 });
    }
    throw err;
  }
  if (!bound) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ nfcTagUid: bound.definition.nfcTagUid, alsoBoundTo: bound.alsoBoundTo });
}

// DELETE /api/task-definitions/[id]/nfc-tag — unbind. Manager-only.
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  await connectDB();

  const definition = await unbindNfcTag(companyId, locationId, params.id);
  if (!definition) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ ok: true });
}
