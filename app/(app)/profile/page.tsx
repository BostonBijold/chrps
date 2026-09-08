import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { resolveSessionUser, isManagerOrAbove, isOwner } from "@/lib/session";
import { connectDB } from "@/lib/mongoose";
import User from "@/models/User";
import ProfileView from "@/components/ProfileView";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const skipAuth = process.env.SKIP_AUTH === "true";
  const session = await auth();
  if (!skipAuth && !session?.user?.id) redirect("/login");

  const sessionUser = await resolveSessionUser();

  let hasPassword = false;
  if (session?.user?.id) {
    await connectDB();
    const user = await User.findById(session.user.id, "passwordHash").lean<{ passwordHash?: string | null }>();
    hasPassword = !!user?.passwordHash;
  }

  return (
    <ProfileView
      name={session?.user?.name ?? "Developer"}
      email={session?.user?.email ?? "dev@local"}
      skipAuth={skipAuth ?? false}
      isManager={!!sessionUser && isManagerOrAbove(sessionUser.role)}
      isOwner={!!sessionUser && isOwner(sessionUser.role)}
      hasPassword={hasPassword}
    />
  );
}
