"use client";

import { useState } from "react";
import Header from "@/components/Header";
import ReportsContent from "@/components/ReportsContent";
import { isOwner } from "@/lib/roles";

interface Props {
  userName: string;
  role: "manager" | "employee" | "owner" | "developer";
  // Already resolved server-side via pickActiveLocationId — see
  // docs/features/locations.md's "Location switcher".
  activeLocationId: string | null;
  // This signed-in user's own primary location (User.locationId) — see
  // Header.tsx's LocationContext.locationId.
  locationId: string | null;
  skipAuth?: boolean;
}

export default function ReportsView({ userName, role, activeLocationId, locationId, skipAuth }: Props) {
  // ReportsContent's own sub-tabs (ManagerOverview/EmployeeOverview/
  // LogsTab/InventoryTab) each fetch their own data once on mount — a
  // plain router.refresh() re-runs this page's server component but
  // doesn't re-trigger an effect that already ran. Bumping this counter on
  // every switcher change forces the whole subtree to remount and refetch
  // against the newly-selected location instead of threading a refetch
  // callback through four separate tab components.
  const [refreshTick, setRefreshTick] = useState(0);

  return (
    <div className="min-h-dvh bg-bg">
      <div className="mx-auto max-w-mobile px-4 pb-12">
        <Header
          userName={userName}
          skipAuth={skipAuth}
          location={{
            isOwner: isOwner(role),
            activeLocationId,
            locationId,
            onLocationChanged: () => setRefreshTick((t) => t + 1),
          }}
        />
        <ReportsContent key={`${activeLocationId}-${refreshTick}`} role={role} />
      </div>
    </div>
  );
}
