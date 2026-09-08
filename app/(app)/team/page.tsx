import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { resolveSessionUser, isManagerOrAbove, isOwner } from "@/lib/session";
import NoCompanyMessage from "@/components/NoCompanyMessage";
import TeamView from "@/components/TeamView";

export const dynamic = "force-dynamic";

// Team roster + (managers only) invite management — see
// docs/features/team-invites.md. Open to any signed-in company member,
// unlike Manage Tasks; TeamView itself gates the manager-only sections.
export default async function TeamPage() {
  const skipAuth = process.env.SKIP_AUTH === "true";
  const session = await auth();
  if (!skipAuth && !session?.user?.id) redirect("/login");

  const sessionUser = await resolveSessionUser();
  if (!sessionUser) redirect("/login");

  const today = new Date().toISOString().split("T")[0];
  const userName = session?.user?.name ?? "Developer";

  if (!sessionUser.companyId) {
    return <NoCompanyMessage userName={userName} />;
  }

  return (
    <TeamView
      userName={userName}
      today={today}
      skipAuth={skipAuth}
      isManager={isManagerOrAbove(sessionUser.role)}
      isOwner={isOwner(sessionUser.role)}
      currentUserId={sessionUser.userId}
      activeLocationId={sessionUser.activeLocationId}
      locationId={sessionUser.locationId}
    />
  );
}
