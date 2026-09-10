import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { resolveSessionUser, isDeveloper } from "@/lib/session";
import ProvisionNfcTagView from "@/components/ProvisionNfcTagView";

export const dynamic = "force-dynamic";

// Developer-only — see docs/features/nfc.md's "Provisioning". Reached from
// a "Provision Tag" card on Profile shown only to the "developer" role
// tier, which is never assigned through any in-app flow (hand-set in
// MongoDB, same precedent as "owner"). A non-developer never sees this
// page exist — redirected to /tasks, same "don't expose UI a role can't
// use" pattern as NoCompanyMessage.tsx and the Admin Console's own gate.
export default async function ProvisionNfcTagPage() {
  const skipAuth = process.env.SKIP_AUTH === "true";
  const session = await auth();
  if (!skipAuth && !session?.user?.id) redirect("/login");

  const sessionUser = await resolveSessionUser();
  if (!sessionUser) redirect("/login");
  if (!isDeveloper(sessionUser.role)) redirect("/tasks");

  const userName = session?.user?.name ?? "Developer";

  return <ProvisionNfcTagView userName={userName} skipAuth={skipAuth ?? false} />;
}
