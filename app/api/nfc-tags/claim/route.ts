import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import { resolveSessionUser, isManagerOrAbove, pickActiveLocationId } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";
import { claimNfcTag, NfcTagNotRecognizedError, NfcTagClaimedElsewhereError } from "@/lib/nfc-tags";

export const dynamic = "force-dynamic";

// POST /api/nfc-tags/claim — manager-only, company+location-scoped, same
// gate as the other NFC-linking routes. A manager scans a physical tag
// once it's in hand and it becomes theirs: locked to one companyId + one
// locationId — see docs/features/nfc.md's "Claiming". Defaults to the
// claiming manager's own active location (same pickActiveLocationId
// resolution every other manager-write route in this app already uses —
// an owner can still narrow it with ?locationId= via the header
// switcher); claiming never takes an explicit locationId in the body.
export async function POST(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role, userId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  const { uid } = await req.json();
  if (!uid || typeof uid !== "string") {
    return NextResponse.json({ error: "Missing uid" }, { status: 400 });
  }

  await connectDB();

  try {
    const tag = await claimNfcTag(companyId, locationId, userId, uid);
    return NextResponse.json({ uid: tag.uid, status: tag.status, locationId: tag.locationId });
  } catch (err) {
    if (err instanceof NfcTagNotRecognizedError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof NfcTagClaimedElsewhereError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
