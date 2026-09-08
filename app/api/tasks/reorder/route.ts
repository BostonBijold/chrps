import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import Task from "@/models/Task";
import { resolveSessionUser, pickActiveLocationId } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";

export const dynamic = "force-dynamic";

// PATCH /api/tasks/reorder
// Body: { tasks: Array<{ _id: string; order: number }> }
export async function PATCH(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  const { tasks } = (await req.json()) as { tasks: Array<{ _id: string; order: number }> };

  if (!Array.isArray(tasks) || tasks.length === 0) {
    return NextResponse.json({ error: "tasks array required" }, { status: 400 });
  }

  await connectDB();

  await Promise.all(
    tasks.map(({ _id, order }) =>
      Task.updateOne({ _id, companyId, locationId }, { $set: { order } })
    )
  );

  return NextResponse.json({ ok: true });
}
