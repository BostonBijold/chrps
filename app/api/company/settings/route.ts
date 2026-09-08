import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import Company from "@/models/Company";
import TaskList from "@/models/TaskList";
import { resolveSessionUser, isManagerOrAbove } from "@/lib/session";
import { upsertStartTimeSchedule } from "@/lib/qstash-schedules";

export const dynamic = "force-dynamic";

// GET is open to any signed-in company user (not just managers) — every
// device needs to read notificationSound to know which chirp to play on
// its own NFC-verified saves, not just the manager who set it.
export async function GET() {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });

  await connectDB();
  const company = await Company.findById(
    companyId,
    "notificationSound timezone notificationsEnabled missedAlertGraceMinutes missedAlertIncludeOwner"
  ).lean<{
    notificationSound?: string;
    timezone?: string | null;
    notificationsEnabled?: boolean;
    missedAlertGraceMinutes?: number | null;
    missedAlertIncludeOwner?: boolean;
  }>();
  if (!company) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    notificationSound: company.notificationSound ?? "standard",
    timezone: company.timezone ?? null,
    notificationsEnabled: company.notificationsEnabled ?? true,
    // `?? 30` would incorrectly coerce an explicit "off" (null) back to 30
    // — only an actually-unset field should get the default.
    missedAlertGraceMinutes: company.missedAlertGraceMinutes === undefined ? 30 : company.missedAlertGraceMinutes,
    missedAlertIncludeOwner: company.missedAlertIncludeOwner ?? true,
  });
}

export async function PATCH(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const body = (await req.json()) as {
    notificationSound?: string;
    timezone?: string;
    notificationsEnabled?: boolean;
    missedAlertGraceMinutes?: number | null;
    missedAlertIncludeOwner?: boolean;
  };

  const update: Record<string, unknown> = {};
  if (body.notificationSound !== undefined) {
    if (body.notificationSound !== "standard" && body.notificationSound !== "male") {
      return NextResponse.json({ error: "notificationSound must be 'standard' or 'male'" }, { status: 400 });
    }
    update.notificationSound = body.notificationSound;
  }
  if (body.timezone !== undefined) {
    // Validated by trying to actually use it as an IANA zone name — the
    // cheapest correctness check available without a zone-name dependency.
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: body.timezone });
    } catch {
      return NextResponse.json({ error: "Invalid timezone" }, { status: 400 });
    }
    update.timezone = body.timezone;
  }
  if (body.notificationsEnabled !== undefined) {
    update.notificationsEnabled = !!body.notificationsEnabled;
  }
  if (body.missedAlertGraceMinutes !== undefined) {
    // null = turn missed alerts off entirely for this company — a valid,
    // deliberate value, not something to reject.
    if (
      body.missedAlertGraceMinutes !== null &&
      (!Number.isInteger(body.missedAlertGraceMinutes) ||
        body.missedAlertGraceMinutes < 0 ||
        body.missedAlertGraceMinutes > 240)
    ) {
      return NextResponse.json(
        { error: "missedAlertGraceMinutes must be null or an integer between 0 and 240" },
        { status: 400 }
      );
    }
    update.missedAlertGraceMinutes = body.missedAlertGraceMinutes;
  }
  if (body.missedAlertIncludeOwner !== undefined) {
    update.missedAlertIncludeOwner = !!body.missedAlertIncludeOwner;
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  await connectDB();
  const company = await Company.findByIdAndUpdate(companyId, { $set: update }, { returnDocument: "after" }).lean<{
    notificationSound?: string;
    timezone?: string | null;
    notificationsEnabled?: boolean;
    missedAlertGraceMinutes?: number | null;
    missedAlertIncludeOwner?: boolean;
  }>();
  if (!company) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Every shift-window list's own QStash schedule has this company's OLD
  // timezone baked into its CRON_TZ prefix (see lib/qstash-schedules.ts) —
  // a timezone correction needs to re-upsert all of them, not just take
  // effect for the next list a manager happens to edit. Best-effort: a
  // QStash hiccup here shouldn't fail the settings save itself.
  if (update.timezone !== undefined) {
    try {
      const lists = await TaskList.find(
        { companyId, isActive: true, startTime: { $ne: null } },
        "_id startTime scheduledDays"
      ).lean<{ _id: { toString(): string }; startTime: string; scheduledDays: number[] }[]>();
      await Promise.all(
        lists.map(async (list) => {
          const scheduleId = await upsertStartTimeSchedule({
            taskListId: list._id.toString(),
            startTime: list.startTime,
            scheduledDays: list.scheduledDays,
            timezone: company.timezone ?? null,
          });
          await TaskList.updateOne({ _id: list._id }, { $set: { qstashScheduleId: scheduleId } });
        })
      );
    } catch (err) {
      console.error(`PATCH /api/company/settings: schedule re-upsert failed for company ${companyId}`, err);
    }
  }

  return NextResponse.json({
    notificationSound: company.notificationSound ?? "standard",
    timezone: company.timezone ?? null,
    notificationsEnabled: company.notificationsEnabled ?? true,
    missedAlertGraceMinutes: company.missedAlertGraceMinutes === undefined ? 30 : company.missedAlertGraceMinutes,
    missedAlertIncludeOwner: company.missedAlertIncludeOwner ?? true,
  });
}
