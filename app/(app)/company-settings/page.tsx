import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { connectDB } from "@/lib/mongoose";
import Company from "@/models/Company";
import { resolveSessionUser, isManagerOrAbove } from "@/lib/session";
import CompanySettingsView from "@/components/CompanySettingsView";
import type { NotificationSound } from "@/lib/notification-sound";

export const dynamic = "force-dynamic";

// Manager-only — reached from a manager-only link on the Profile page.
export default async function CompanySettingsPage() {
  const skipAuth = process.env.SKIP_AUTH === "true";
  const session = await auth();
  if (!skipAuth && !session?.user?.id) redirect("/login");

  const sessionUser = await resolveSessionUser();
  if (!sessionUser) redirect("/login");
  const { companyId } = sessionUser;
  if (!companyId) redirect("/tasks");
  if (!isManagerOrAbove(sessionUser.role)) redirect("/tasks");

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

  const userName = session?.user?.name ?? "Developer";

  return (
    <CompanySettingsView
      userName={userName}
      skipAuth={skipAuth}
      initialNotificationSound={(company?.notificationSound as NotificationSound) ?? "standard"}
      initialTimezone={company?.timezone ?? null}
      initialNotificationsEnabled={company?.notificationsEnabled ?? true}
      initialMissedAlertGraceMinutes={
        company?.missedAlertGraceMinutes === undefined ? 30 : company.missedAlertGraceMinutes
      }
      initialMissedAlertIncludeOwner={company?.missedAlertIncludeOwner ?? true}
    />
  );
}
