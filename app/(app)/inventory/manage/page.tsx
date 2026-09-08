import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { resolveSessionUser, isManagerOrAbove } from "@/lib/session";
import ManageInventoryView from "@/components/ManageInventoryView";

export const dynamic = "force-dynamic";

// Manager-only "Manage Inventory" screen — item type name/unit/parLevel/
// group editing, NFC tag sync, and Groups CRUD, one layer down from the
// everyday Inventory tab. Not part of the bottom nav — reached from a
// manager-only "Manage" button on the Inventory tab and from the Profile
// page, same convention as /tasks/manage. See docs/features/inventory.md.
export default async function ManageInventoryPage() {
  const skipAuth = process.env.SKIP_AUTH === "true";
  const session = await auth();
  if (!skipAuth && !session?.user?.id) redirect("/login");

  const sessionUser = await resolveSessionUser();
  if (!sessionUser) redirect("/login");
  const { companyId } = sessionUser;
  if (!companyId) redirect("/inventory");
  if (!isManagerOrAbove(sessionUser.role)) redirect("/inventory");

  const userName = session?.user?.name ?? "Developer";

  return <ManageInventoryView userName={userName} skipAuth={skipAuth} />;
}
