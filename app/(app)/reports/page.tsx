import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { resolveSessionUser, pickActiveLocationId } from "@/lib/session";
import ReportsView from "@/components/ReportsView";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const skipAuth = process.env.SKIP_AUTH === "true";
  const session = await auth();
  if (!skipAuth && !session?.user?.id) redirect("/login");

  const sessionUser = await resolveSessionUser();

  return (
    <ReportsView
      userName={session?.user?.name ?? "Developer"}
      role={sessionUser?.role ?? "manager"}
      activeLocationId={sessionUser ? pickActiveLocationId(sessionUser, null) : null}
      locationId={sessionUser?.locationId ?? null}
      skipAuth={skipAuth}
    />
  );
}
