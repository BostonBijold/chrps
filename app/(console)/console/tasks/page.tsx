import { resolveSessionUser, isOwner, pickActiveLocationId } from "@/lib/session";
import TaskManagementView from "@/components/console/TaskManagementView";

export const dynamic = "force-dynamic";

// Manager-or-above (see docs/features/console-task-management.md) — the
// one console page an owner and a manager both reach. Resolves
// activeLocationId server-side via pickActiveLocationId, same convention
// as app/(console)/console/reports/page.tsx, so TaskManagementView's
// LocationSwitcher gets an already-resolved value rather than fetching its
// own — task lists/definitions are now location-owned (see
// docs/features/locations.md), so a 2+-location owner needs this the same
// way Reports/Inventory already do. TaskManagementView still fetches
// GET /api/task-lists and GET /api/task-definitions itself client-side,
// same convention as every other console page (TeamConsoleView,
// RollupTable) — those routes resolve locationId from session, so no
// further prop threading is needed for the fetches themselves.
export default async function ConsoleTasksPage() {
  const sessionUser = await resolveSessionUser();
  return (
    <TaskManagementView
      isOwner={!!sessionUser && isOwner(sessionUser.role)}
      activeLocationId={sessionUser ? pickActiveLocationId(sessionUser, null) : null}
    />
  );
}
