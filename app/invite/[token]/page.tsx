import { redirect } from "next/navigation";
import { resolveSessionUser } from "@/lib/session";
import { connectDB } from "@/lib/mongoose";
import { redeemInvite } from "@/lib/invites";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh bg-bg flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-mobile text-center">{children}</div>
    </main>
  );
}

// Public, unauthenticated deep link — not in middleware.ts's
// PUBLIC_PAGE_PATHS, so a logged-out tap redirects through
// /login?callbackUrl=/invite/<token> and lands back here afterward.
// companyId/role are never client-supplied — always resolved from the
// Invite document itself. See docs/features/team-invites.md.
export default async function InvitePage({
  params,
}: {
  params: { token: string };
}) {
  const { token } = params;
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) {
    redirect(`/login?callbackUrl=/invite/${token}`);
  }

  await connectDB();

  const result = await redeemInvite(token, sessionUser);

  if (!result.ok) {
    return result.reason === "different-company" ? (
      <Shell>
        <h1 className="font-heading text-2xl text-text mb-2">Already on a team</h1>
        <p className="text-muted font-body text-sm">
          You&apos;re already part of a team — contact support to switch companies.
        </p>
      </Shell>
    ) : (
      <Shell>
        <h1 className="font-heading text-2xl text-text mb-2">Invite not valid</h1>
        <p className="text-muted font-body text-sm">This invite is no longer valid.</p>
      </Shell>
    );
  }

  redirect(result.alreadyMember ? "/tasks" : "/welcome");
}
