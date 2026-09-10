import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import Task from "@/models/Task";
import { bindNfcTag, unbindNfcTag } from "@/lib/task-definitions";
import { resolveSessionUser, isManagerOrAbove, pickActiveLocationId } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";
import { NfcTagNotRecognizedError, NfcTagClaimedElsewhereError } from "@/lib/nfc-tags";

export const dynamic = "force-dynamic";

// POST /api/tasks/[id]/nfc-tag — binds a physical tag's raw UID (scanned
// in-app, see lib/native/nfc-scan.ts) to this task's saved TaskDefinition —
// see docs/features/nfc.md's "In-app scan-to-complete binding" and
// docs/features/task-lists.md's "Company Task Catalog" section. Still
// addressed by [id] (a specific list placement, matching how it's called
// from a single row in TaskListEditView), but resolves to the definition
// server-side — binding cascades to every list this task is placed in, not
// just the one the manager happened to click from. Manager-only, same gate
// as the other NFC-linking routes (app/api/nfc-tags). Binding a definition
// directly, by its own id, without going through a placement — e.g. one not
// yet placed in any list — is app/api/task-definitions/[id]/nfc-tag
// instead; both share lib/task-definitions.ts's bindNfcTag/unbindNfcTag.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
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

  const task = await Task.findOne({ _id: params.id, companyId, locationId }).select("definitionId").lean();
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let bound;
  try {
    bound = await bindNfcTag(companyId, locationId, userId, task.definitionId.toString(), uid);
  } catch (err) {
    if (err instanceof NfcTagNotRecognizedError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof NfcTagClaimedElsewhereError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
  if (!bound) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ nfcTagUid: bound.definition.nfcTagUid, alsoBoundTo: bound.alsoBoundTo });
}

// DELETE /api/tasks/[id]/nfc-tag — unbind. Manager-only.
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

  const task = await Task.findOne({ _id: params.id, companyId, locationId }).select("definitionId").lean();
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const definition = await unbindNfcTag(companyId, locationId, task.definitionId.toString());
  if (!definition) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ ok: true });
}
