"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { Users, BarChart3, LayoutDashboard, LogOut, ListChecks, Package } from "lucide-react";

// The Rollup Dashboard is now /console's own landing content (see
// app/(console)/console/page.tsx) rather than a separate sidebar page, so
// it's this "Dashboard" entry instead of a distinct route — an owner's
// home. Locations was removed from the console entirely (no nav item, no
// page) — see docs/features/admin-console.md. Team & Access stays
// owner-only; Task Management, Reports, and Inventory are the three items
// a manager can also see — see docs/features/console-task-management.md's
// "Required change: the console is no longer owner-only",
// docs/features/console-reports.md's "Sidebar", and
// docs/features/console-inventory.md's "Sidebar". Reports/Inventory use
// the same BarChart3/Package icons as mobile's own bottom-nav tabs
// (components/BottomNav.tsx).
const DASHBOARD_NAV_ITEM = { href: "/console", label: "Dashboard", icon: LayoutDashboard } as const;
const TEAM_NAV_ITEM = { href: "/console/team", label: "Team & Access", icon: Users } as const;
const TASKS_NAV_ITEM = { href: "/console/tasks", label: "Task Management", icon: ListChecks } as const;
const REPORTS_NAV_ITEM = { href: "/console/reports", label: "Reports", icon: BarChart3 } as const;
const INVENTORY_NAV_ITEM = { href: "/console/inventory", label: "Par Sheet", icon: Package } as const;

// Desktop sidebar shell for the Admin Console — see
// docs/features/admin-console.md's "Nav & shell". Distinct from
// components/BottomNav.tsx's mobile bottom-nav chrome; this section is
// desktop-first and never shares layout with the Capacitor app's pages.
export default function ConsoleSidebar({ userName, isOwner }: { userName: string; isOwner: boolean }) {
  const pathname = usePathname();

  // An owner sees all five items, Dashboard first; a manager (who can't
  // see the cross-location Dashboard or Team & Access) sees only Task
  // Management, Reports, and Inventory — see
  // docs/features/console-task-management.md, docs/features/console-reports.md,
  // and docs/features/console-inventory.md.
  const navItems = isOwner
    ? [DASHBOARD_NAV_ITEM, TEAM_NAV_ITEM, TASKS_NAV_ITEM, REPORTS_NAV_ITEM, INVENTORY_NAV_ITEM]
    : [TASKS_NAV_ITEM, REPORTS_NAV_ITEM, INVENTORY_NAV_ITEM];

  return (
    <aside className="w-60 flex-shrink-0 border-r border-border bg-card flex flex-col h-dvh sticky top-0">
      <div className="px-5 py-6">
        <p className="font-heading text-lg text-text">Ch&apos;rps</p>
        <p className="font-mono text-[10px] text-dim uppercase tracking-widest mt-0.5">Admin Console</p>
      </div>

      <nav className="flex-1 px-3 space-y-1">
        {navItems.map(({ href, label, icon: Icon }) => {
          // "/console" itself needs an exact match — startsWith alone would
          // also light up Dashboard on every other console route, since
          // they're all prefixed with "/console" too.
          const active = href === "/console" ? pathname === "/console" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-2.5 px-3 py-2.5 rounded-card font-body text-sm transition-colors ${
                active ? "bg-olive/10 text-olive" : "text-muted hover:bg-card-hover hover:text-text"
              }`}
            >
              <Icon size={16} />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="px-3 py-4 border-t border-border">
        <p className="px-3 font-body text-xs text-dim truncate mb-2">{userName}</p>
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-card font-body text-sm text-muted hover:bg-card-hover hover:text-burgundy-light transition-colors"
        >
          <LogOut size={16} />
          Sign Out
        </button>
      </div>
    </aside>
  );
}
