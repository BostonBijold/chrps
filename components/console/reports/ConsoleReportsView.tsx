"use client";

import { useState } from "react";
import LocationSwitcher from "@/components/LocationSwitcher";
import ConsoleOverviewTab from "@/components/console/reports/ConsoleOverviewTab";
import ConsoleLogsTab from "@/components/console/reports/ConsoleLogsTab";
import ConsoleInventoryTab from "@/components/console/reports/ConsoleInventoryTab";

type Tab = "overview" | "logs" | "inventory";

const TAB_LABELS: Record<Tab, string> = { overview: "Overview", logs: "Logs", inventory: "Par Sheet" };

interface Props {
  isOwner: boolean;
  activeLocationId: string | null;
}

// Desktop-shaped counterpart to components/ReportsView.tsx — same data,
// same APIs, new presentational components built for the extra screen
// width a console page has (see docs/features/console-reports.md). Every
// console viewer is manager-or-above already (an employee can't reach
// /console at all), so unlike mobile's ReportsContent.tsx there's no
// employee/manager role branch here — this always shows the
// manager-shaped view, and Logs never hides the team-member filter.
export default function ConsoleReportsView({ isOwner, activeLocationId }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  // Same "remount the whole subtree" convention as ReportsView.tsx's
  // refreshTick — each tab fetches its own data once on mount, so a
  // location-switcher change needs a key bump rather than a threaded
  // refetch callback.
  const [refreshTick, setRefreshTick] = useState(0);

  return (
    <div>
      <div className="flex items-center justify-between mb-1 gap-2">
        <h1 className="font-heading text-2xl text-text">Reports</h1>
        <div className="flex bg-card border border-border rounded-pill p-0.5">
          {(["overview", "logs", "inventory"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`font-mono text-xs px-4 py-1.5 rounded-pill transition-colors ${
                tab === t ? "bg-olive text-text" : "text-dim hover:text-muted"
              }`}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>
      </div>
      <p className="font-body text-sm text-muted mb-4">The same task, log, and par sheet reporting the phone shows — laid out for a bigger screen.</p>

      <LocationSwitcher
        isOwner={isOwner}
        activeLocationId={activeLocationId}
        onChanged={() => setRefreshTick((t) => t + 1)}
      />

      <div key={`${activeLocationId}-${refreshTick}`}>
        {tab === "overview" && <ConsoleOverviewTab />}
        {tab === "logs" && <ConsoleLogsTab />}
        {tab === "inventory" && <ConsoleInventoryTab />}
      </div>
    </div>
  );
}
