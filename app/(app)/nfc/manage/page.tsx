import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { resolveSessionUser, isManagerOrAbove } from "@/lib/session";
import ManageNfcTagsView from "@/components/ManageNfcTagsView";

export const dynamic = "force-dynamic";

// Manager-only "Manage Ch'rps" screen — see docs/features/nfc.md's
// "Manage Ch'rps". "Ch'rp" is this app's product-facing name for a
// physical NFC tag (a nod to the completion "chirp" sound, see
// docs/features/nfc.md's "Save chirp") — internal code keeps `NfcTag`/
// "tag" naming throughout, only user-facing copy says "Ch'rp(s)". A third
// "Manage" entry point alongside /tasks/manage and /inventory/manage.
export default async function ManageNfcTagsPage() {
  const skipAuth = process.env.SKIP_AUTH === "true";
  const session = await auth();
  if (!skipAuth && !session?.user?.id) redirect("/login");

  const sessionUser = await resolveSessionUser();
  if (!sessionUser) redirect("/login");
  const { companyId } = sessionUser;
  if (!companyId) redirect("/tasks");
  if (!isManagerOrAbove(sessionUser.role)) redirect("/tasks");

  const userName = session?.user?.name ?? "Developer";

  return <ManageNfcTagsView userName={userName} skipAuth={skipAuth} />;
}
