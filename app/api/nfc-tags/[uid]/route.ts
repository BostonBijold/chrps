import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import NfcTag from "@/models/NfcTag";
import { resolveSessionUser, isManagerOrAbove, pickActiveLocationId } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";

export const dynamic = "force-dynamic";

const MAX_LABEL_LENGTH = 60;

// PATCH /api/nfc-tags/[uid] — "Manage Ch'rps" edit actions: label and
// status (`claimed` <-> `retired`). Manager-or-above, and scoped to a tag
// actually claimed by THIS company+location — the query filter below is
// the whole guard, so this can never touch a tag belonging to a different
// company/location or one that's still unclaimed. See
// docs/features/nfc.md's "Manage Ch'rps" and "Retiring a tag".
export async function PATCH(req: NextRequest, { params }: { params: { uid: string } }) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  const body = await req.json();
  const updates: { label?: string | null; status?: "claimed" | "retired" } = {};
  if (typeof body.label === "string") {
    updates.label = body.label.trim().slice(0, MAX_LABEL_LENGTH) || null;
  } else if (body.label === null) {
    updates.label = null;
  }
  if (body.status === "claimed" || body.status === "retired") {
    updates.status = body.status;
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  await connectDB();

  const tag = await NfcTag.findOneAndUpdate(
    { uid: params.uid.toLowerCase(), companyId, locationId, status: { $in: ["claimed", "retired"] } },
    { $set: updates },
    { returnDocument: "after" }
  ).lean();
  if (!tag) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ uid: tag.uid, status: tag.status, label: tag.label ?? null });
}
