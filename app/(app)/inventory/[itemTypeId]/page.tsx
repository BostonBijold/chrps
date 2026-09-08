import { redirect, notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { connectDB } from "@/lib/mongoose";
import Company from "@/models/Company";
import InventoryItemType from "@/models/InventoryItemType";
import { resolveSessionUser, isManagerOrAbove, pickActiveLocationId } from "@/lib/session";
import InventoryItemDetailView from "@/components/InventoryItemDetailView";

export const dynamic = "force-dynamic";

// Item detail/log screen — current count, log a new count (optionally via
// NFC), recent history, plus manager-only edit/bind/archive. See
// docs/features/inventory.md. `verifiedNfcUid` arrives from the FAB's
// "scan to open" shortcut (components/BottomNav.tsx) when this item type
// was the scan's single (or disambiguated) match — same pre-verified
// pattern as a task's own preVerifiedNfcUid, but never a REQUIREMENT to
// save here, unlike a bound TaskDefinition.
export default async function InventoryItemDetailPage({
  params,
  searchParams,
}: {
  params: { itemTypeId: string };
  searchParams: { verifiedNfcUid?: string };
}) {
  const skipAuth = process.env.SKIP_AUTH === "true";
  const session = await auth();
  if (!skipAuth && !session?.user?.id) redirect("/login");

  const sessionUser = await resolveSessionUser();
  if (!sessionUser) redirect("/login");
  const { companyId } = sessionUser;
  if (!companyId) redirect("/inventory");

  await connectDB();

  // Location-scoped — an item type belongs to exactly one location, see
  // docs/features/locations.md's "Location scoping". A foreign-location
  // itemTypeId (e.g. a stale bookmark) 404s the same as any other
  // not-found id.
  const locationId = pickActiveLocationId(sessionUser, null);
  const itemType = await InventoryItemType.findOne({
    _id: params.itemTypeId,
    companyId,
    locationId,
    isActive: true,
  }).lean();
  if (!itemType) notFound();

  const company = await Company.findById(companyId, "notificationSound").lean<{ notificationSound?: string }>();
  const notificationSound = (company?.notificationSound === "male" ? "male" : "standard") as "standard" | "male";

  const today = new Date().toISOString().split("T")[0];
  const userName = session?.user?.name ?? "Developer";

  return (
    <InventoryItemDetailView
      userName={userName}
      today={today}
      skipAuth={skipAuth}
      isManager={isManagerOrAbove(sessionUser.role)}
      notificationSound={notificationSound}
      preVerifiedNfcUid={searchParams.verifiedNfcUid ?? null}
      itemType={{
        _id: itemType._id.toString(),
        name: itemType.name,
        unit: itemType.unit ?? null,
        parLevel: itemType.parLevel ?? null,
        nfcTagUid: itemType.nfcTagUid ?? null,
        nfcRequiredToLog: itemType.nfcRequiredToLog ?? false,
        groupId: itemType.groupId ? itemType.groupId.toString() : null,
      }}
    />
  );
}
