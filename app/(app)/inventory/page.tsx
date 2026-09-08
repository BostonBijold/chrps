import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { resolveSessionUser, isManagerOrAbove, isOwner, pickActiveLocationId } from "@/lib/session";
import NoCompanyMessage from "@/components/NoCompanyMessage";
import InventoryView from "@/components/InventoryView";

export const dynamic = "force-dynamic";

// Inventory tab (5th bottom-nav slot) — a top-up count tracker, not a
// decrement ledger. See docs/features/inventory.md. Open to any signed-in
// company member, same as Team; InventoryView itself gates the
// manager-only "add item type" affordance.
export default async function InventoryPage() {
  const skipAuth = process.env.SKIP_AUTH === "true";
  const session = await auth();
  if (!skipAuth && !session?.user?.id) redirect("/login");

  const sessionUser = await resolveSessionUser();
  if (!sessionUser) redirect("/login");

  const userName = session?.user?.name ?? "Developer";

  if (!sessionUser.companyId) {
    return <NoCompanyMessage userName={userName} />;
  }

  return (
    <InventoryView
      userName={userName}
      skipAuth={skipAuth}
      isManager={isManagerOrAbove(sessionUser.role)}
      isOwner={isOwner(sessionUser.role)}
      activeLocationId={pickActiveLocationId(sessionUser, null)}
      locationId={sessionUser.locationId}
    />
  );
}
