import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import { resolveSessionUser, isDeveloper } from "@/lib/session";
import { provisionNfcTag, NfcTagAlreadyProvisionedError } from "@/lib/nfc-tags";

export const dynamic = "force-dynamic";

// POST /api/admin/nfc-tags/provision — internal/admin only, not
// customer-facing. Records that a UID exists and is a real Ch'rps tag
// before it ships to a customer — see docs/features/nfc.md's
// "Provisioning". Deliberately not company-scoped at all: a provisioned
// tag has no companyId yet, it's just a registry row a customer will later
// claim (POST /api/nfc-tags/claim). Gated on the "developer" role tier
// (lib/roles.ts's isDeveloper), a strict superset of "owner" that's never
// assignable through any in-app flow — hand-set in MongoDB, same
// precedent as "owner" itself.
export async function POST(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isDeveloper(sessionUser.role)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { uid } = await req.json();
  if (!uid || typeof uid !== "string") {
    return NextResponse.json({ error: "Missing uid" }, { status: 400 });
  }

  await connectDB();

  try {
    const tag = await provisionNfcTag(uid);
    return NextResponse.json({ uid: tag.uid, status: tag.status }, { status: 201 });
  } catch (err) {
    if (err instanceof NfcTagAlreadyProvisionedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
