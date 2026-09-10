"use client";

import { useState } from "react";
import ManagerOverview from "@/components/reports/ManagerOverview";
import EmployeeOverview from "@/components/reports/EmployeeOverview";
import LogsTab from "@/components/reports/LogsTab";
import InventoryTab from "@/components/reports/InventoryTab";
import { isManagerOrAbove } from "@/lib/roles";

interface Props {
  role: "manager" | "employee" | "owner" | "developer";
}

type Tab = "overview" | "logs" | "inventory";

// Thin dispatcher: "Reports" heading + segmented control, branching each
// tab by role. See docs/features/reports.md. The "Inventory" pill (Stories
// 5/6 of the "Reports v2" addendum) is manager-only, same reasoning as the
// rest of Inventory reporting — counts aren't attributed to "your" work
// the way tasks are, so there's no employee-personal equivalent to split
// against.
export default function ReportsContent({ role }: Props) {
  const [tab, setTab] = useState<Tab>("overview");

  return (
    <>
      <div className="flex items-center justify-between mb-6 gap-2">
        <h2 className="font-heading text-xl text-text flex-shrink-0">Reports</h2>
        <div className="flex bg-card border border-border rounded-pill p-0.5">
          <button
            onClick={() => setTab("overview")}
            className={`font-mono text-xs px-3 py-1.5 rounded-pill transition-colors ${
              tab === "overview" ? "bg-olive text-text" : "text-dim hover:text-muted"
            }`}
          >
            Overview
          </button>
          <button
            onClick={() => setTab("logs")}
            className={`font-mono text-xs px-3 py-1.5 rounded-pill transition-colors ${
              tab === "logs" ? "bg-olive text-text" : "text-dim hover:text-muted"
            }`}
          >
            Logs
          </button>
          {isManagerOrAbove(role) && (
            <button
              onClick={() => setTab("inventory")}
              className={`font-mono text-xs px-3 py-1.5 rounded-pill transition-colors ${
                tab === "inventory" ? "bg-olive text-text" : "text-dim hover:text-muted"
              }`}
            >
              Inventory
            </button>
          )}
        </div>
      </div>

      {tab === "overview" && (isManagerOrAbove(role) ? <ManagerOverview /> : <EmployeeOverview />)}
      {tab === "logs" && <LogsTab role={role} />}
      {tab === "inventory" && isManagerOrAbove(role) && <InventoryTab />}
    </>
  );
}
