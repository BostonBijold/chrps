**Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Header location switcher (merged into `<Header>`)

**Status: BUILT.** Refactor of the existing `components/LocationSwitcher.tsx`
(see [`locations.md`](locations.md)'s "Location switcher" section) — no new
data model, no new API route. This only changed *where* and *how* that
control renders on mobile's 4 bottom-nav pages; `LocationSwitcher.tsx`
itself is untouched and still used directly by the desktop Admin Console
(`/console/tasks`, `/console/reports`, `/console/inventory`).

## Why

Each of the 4 bottom-nav pages (Tasks, Team, Reports, Inventory) used to
render the app wordmark ("Ch'rps") in the header, and — directly below it,
only for owners at 2+-location companies — a separate `<LocationSwitcher>`
`<select>` row. That was two places showing "which location am I looking
at," stacked on top of each other, for the one role that actually needs to
switch. The logo mark already carries brand identity, so the wordmark in
the header was redundant with it — freeing that space for the one piece of
context that's actually useful in-app: *which location this screen is
showing.*

## Implementation

`components/Header.tsx` takes one new optional prop, `location?:
LocationContext`:

```ts
interface LocationContext {
  isOwner: boolean;
  activeLocationId: string | null; // the page's own switcher/query value
  locationId: string | null;       // this user's own primary location (User.locationId)
  allowAll?: boolean;               // Team only — adds an "All Locations" entry
  onLocationChanged?: () => void;   // fired after a successful PATCH, alongside router.refresh()
}
```

- **Opt-in, passed only by the 4 bottom-nav pages** (`TasksView.tsx`,
  `TeamView.tsx`, `ReportsView.tsx`, `InventoryView.tsx`). Every other
  `<Header>` call site (`ProfileView.tsx`, `ManageTasksView.tsx`,
  `ManageInventoryView.tsx`, `InventoryItemDetailView.tsx`,
  `CompanySettingsView.tsx`) omits it — those keep the plain "Ch'rps"
  wordmark unchanged, and `Header` skips its `/api/locations` fetch
  entirely when `location` isn't passed, so there's no extra network cost
  on pages that don't need it.
- **Owner, company has 2+ active `Location`s:** the header's title area
  renders the current active location's name as an interactive native
  `<select>` (`showSwitcher` in `Header.tsx`), styled with the same
  wordmark typography (`font-brand font-extrabold text-xl tracking-wide
  text-olive`) plus a `ChevronDown` caret, so it still visually reads as
  tappable. Same options as before: every active location under the
  company; Team's instance also passes `allowAll`, adding an "All
  Locations" entry that `PATCH`es `activeLocationId` back to `null` (not a
  separate sentinel).
- **Owner at a single-location company, or any manager/employee:** static
  text — no `<select>`, no caret. Resolved as
  `locations.find(l => l._id === (activeLocationId ?? locationId))?.name`,
  falling back to `locationId` because Team passes
  `activeLocationId=sessionUser.activeLocationId` (always `null` for a
  non-owner) while Tasks/Reports/Inventory already fold this into
  `activeLocationId` via `pickActiveLocationId`. Resolved product decision:
  this always shows the location's real name (including the backfill
  script's "Main Location" default for a pre-migration single-location
  company) — no special-cased fallback to the "Ch'rps" wordmark for that
  case.
- **Date subtitle:** unchanged, stays directly beneath.
- **Logo mark (top-left corner):** unchanged — the only brand identifier
  now that the "Ch'rps" wordmark is conditional.
- **Fallback text:** if `location` is passed but no location name can be
  resolved yet (locations still loading, or genuinely unresolvable), the
  header falls back to the plain "Ch'rps" wordmark rather than rendering
  blank — a defensive default, not the single-location product decision
  above.

The separate `<LocationSwitcher>` row previously rendered under `<Header>`
on all 4 mobile pages is removed; each of the 4 view components now passes
its `isOwner`/`activeLocationId`/`onChanged` values into `Header`'s
`location` prop instead (renamed `onChanged` → `onLocationChanged` for
clarity alongside the other `location.*` fields). Each page's server
component (`app/(app)/tasks/page.tsx`, `.../team/page.tsx`,
`.../reports/page.tsx`, `.../inventory/page.tsx`) now also passes
`sessionUser.locationId` straight through as the new `locationId` prop.

## What stayed exactly the same

- Data model, session field (`User.activeLocationId`), and API
  (`PATCH /api/session/active-location`, owner-only,
  `lib/locations.ts`'s `validateLocationId`) — unchanged.
- Per-page null-resolution rules from `locations.md` — unchanged:
  Tasks/Reports/Inventory via `pickActiveLocationId`
  (`requestedLocationId || activeLocationId || locationId`); Team reads
  `activeLocationId` directly, `null` = unfiltered "All Locations."
- The `onChanged`/`onLocationChanged` callback mechanism used to force a
  refetch after switching (`InventoryView`/`TeamView`'s
  `fetchAll`/`fetchTeam`; `ReportsView`'s remount-via-counter-key) —
  unchanged, just now wired to `Header`'s `location.onLocationChanged`
  instead of the standalone component's `onChanged`.
- Visibility rule: an owner at a single-location company, or a
  manager/employee, sees no *interactive* switcher — matches the
  pre-refactor "no UI change at all" behavior for those cases, just now
  expressed as static header text instead of a hidden component.
- The desktop Admin Console's own `LocationSwitcher.tsx` usage — untouched.

## Depends on

[`locations.md`](locations.md) — this doc modifies its "Location switcher"
section's mobile UI placement only; the data/session/API layer it
documents is unchanged.
