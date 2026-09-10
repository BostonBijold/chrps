> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Live Activity — Lock Screen / Dynamic Island Timer

While a routine timer is running, a branded card shows on the Lock Screen and Dynamic Island: the routine label, current habit, a live elapsed timer, an estimated-completion clock time, and an "Open App" button (see [Open App button](#open-app-button) below — it deep-links into the app rather than completing anything itself). This was the second piece of custom native code this project needed beyond Capacitor's stock plugins — the first was the native App Intents/Shortcuts "Trigger Habit" action, since removed entirely (see `docs/project-structure.md`'s "iOS Native Shell" section) — Live Activities have no JS/Capacitor-JS equivalent, only reachable from ActivityKit/WidgetKit in a real Widget Extension target.

## Why a second Xcode target was required

App Intents (the first piece of native code here) compiled directly into the `App` target — no extension needed, since Shortcuts/Siri/Spotlight integration doesn't render any UI of its own. A Live Activity's Lock Screen/Dynamic Island UI, by contrast, is rendered by the OS from a **Widget Extension** process, not the app's own process — ActivityKit requires that UI to live in a `.appex` target. `RoutineActivityExtension` (product name `RoutineActivity`, bundle id `com.bostonbijold.chrps.RoutineActivity`) was added via Xcode's own "Widget Extension" wizard (File → New → Target → Widget Extension, "Include Live Activity" checked) rather than hand-crafted in `project.pbxproj` — safer than scripting a whole new target from scratch, since Apple's template is what correctly wires the `NSExtension` Info.plist keys and the "Embed Foundation Extensions" build phase. Deployment target was lowered from Xcode's default (26.5) to 17.0 to match `App` (interactive Live Activity buttons need iOS 17+ anyway).

**The `RoutineActivity` folder is a filesystem-synchronized group** (`PBXFileSystemSynchronizedRootGroup`, Xcode 16+'s newer target-creation default) — any file physically present in `ios/App/RoutineActivity/` is automatically part of the `RoutineActivityExtension` target's Sources, with no `PBXBuildFile`/`PBXFileReference` bookkeeping needed. This is why `RoutineActivityAttributes.swift` (below) needed no explicit project-file surgery to join that target — only files that needed to cross *into* the traditionally-managed `App` group (or vice versa) needed the `xcodeproj` Ruby gem. (`CompleteHabitFromActivityIntent.swift` used to be the other example of a file that got this for free — deleted, see [Open App button](#open-app-button).)

## Swift file layout

```
ios/App/App/
  ChrpsAPI.swift                      — baseURL, triggerHabit, ChrpsAPIError. Dual target
                                         membership (App + RoutineActivityExtension) is now
                                         vestigial — triggerHabit/ChrpsAPIError were moved out of
                                         AppIntents/HabitEntityQuery.swift (where they used to live
                                         inline) specifically so the Live Activity's old "Done"
                                         button could reuse this networking code, and
                                         completeActiveHabit was added directly here for the same
                                         reason — but that button and completeActiveHabit are both
                                         gone (see "Open App button" below), and nothing in the
                                         RoutineActivityExtension target calls into this file
                                         anymore. fetchHabits/HabitsResponse stayed behind as an
                                         App-only extension on this same enum (HabitEntityQuery.swift)
                                         — its response decodes into [HabitEntity], which is
                                         App-target-only, so pulling it into this dual-membership
                                         file would fail to compile in the extension target.
  KeychainHelper.swift                — now dual target membership too (was App-only). Also
                                         changed to use an explicit kSecAttrAccessGroup instead
                                         of each target's implicit default group — see "Keychain
                                         Sharing" below.
  LiveActivityPlugin.swift            — App-only. CAPPlugin/CAPBridgedPlugin wrapping
                                         Activity<RoutineActivityAttributes>.request/update/end,
                                         registered in MainViewController.capacitorDidLoad()
                                         alongside ApiKeyBridgePlugin.

ios/App/RoutineActivity/              — filesystem-synchronized; see above
  RoutineActivityAttributes.swift     — the ActivityAttributes/ContentState shape. ALSO given
                                         explicit App target membership (via the xcodeproj gem —
                                         see below) since LiveActivityPlugin.swift needs it too,
                                         despite physically living in this folder.
  RoutineActivityLiveActivity.swift   — the actual Widget: Lock Screen view + Dynamic Island
                                         compact/expanded/minimal views. Hardcodes the app's
                                         dark/olive/gold palette (Palette enum) since a widget
                                         extension can't reach Tailwind config.
  RoutineActivityBundle.swift         — @main WidgetBundle; trimmed to just the one widget (the
                                         wizard's template also generates a plain home-screen
                                         widget and a Control Widget, both deleted — this project
                                         only wants the Live Activity).
  RoutineActivity.entitlements        — Keychain Sharing, matching App/App.entitlements. Now
                                         vestigial (see "Open App button" below) but left in place —
                                         no functional cost to an unused Sources/entitlements entry.
```

## Keychain Sharing

**Vestigial as of the Done → Open App change** (see [Open App button](#open-app-button) below) — nothing in the `RoutineActivityExtension` process reads Keychain anymore, since `openAppButton()` is a plain `Link`, not an intent that calls the API. Kept here for reference, and because the entitlement/target-membership plumbing is still physically in place (removing it buys nothing at runtime, and would need the same `xcodeproj`-gem project-file surgery that added it):

The old "Done" button's intent ran in the `RoutineActivityExtension` process, not the WebView or even the main `App` process — same "can't reach `localStorage`/React state" problem the (now-deleted) App Intents layer already solved with its own Keychain bridge, except now *two different bundle IDs* needed to read the same Keychain item (`com.bostonbijold.chrps` and `com.bostonbijold.chrps.RoutineActivity`), and each gets a different *implicit* default access group. Fix: both targets declare the same explicit **Keychain Sharing** group —

```xml
<key>keychain-access-groups</key>
<array><string>$(AppIdentifierPrefix)com.bostonbijold.chrps.shared</string></array>
```

— in `App/App.entitlements` and the new `RoutineActivity/RoutineActivity.entitlements` (wired to the extension target via `CODE_SIGN_ENTITLEMENTS`), and `KeychainHelper.swift`'s `save`/`load` now pass `kSecAttrAccessGroup` explicitly rather than relying on the per-target default. The value is hardcoded as `"X3DPK5Y29G.com.bostonbijold.chrps.shared"` (team ID + group name) rather than resolved from `$(AppIdentifierPrefix)` at runtime — Swift code needs the literal resolved string, not the build-setting macro; same manual-sync tradeoff as `ChrpsAPI.baseURL`, equally unlikely to change for a single-developer personal app.

**Migration note (historical)**: since the access group changed, an API key saved under the *old* implicit group before this change wouldn't be found by the new explicit-group `load()` on first launch after updating — self-healed automatically, since `NativeBootstrap.tsx` used to re-push the key via `save()` (targeting the new group) on every native cold start. Moot now that Keychain/API keys are gone entirely from this app — see [Open App button](#open-app-button) below.

## `RoutineActivityAttributes` — everything lives in `ContentState`

```swift
struct RoutineActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var routineLabel: String    // group name, or "Timer" for a standalone habit
        var habitName: String
        var startedAt: Date         // a *virtual* start time — see below, not always the raw server startedAt
        var projectedMinutes: Int   // 0 = no target (stopwatch) — hides the estimated-finish line
        var routineItemId: String
        var routineGroupId: String? // nil for standalone; set for a Task List Session item
    }
}
```

No fixed (non-`ContentState`) attributes — a single Activity persists for an entire Task List Session and is **updated in place**, not re-created, as the session advances from task to task (avoids the Lock Screen card re-animating/re-appearing on every task switch), so everything needs to be able to change across the Activity's lifetime.

### `startedAt` is a virtual anchor, not always the raw `TaskLog.startedAt`

The Lock Screen elapsed timer is a native `Text(timerInterval:)` — a free-running, self-updating countup that needs no repeated JS pushes, matching this codebase's existing "derive elapsed from wall-clock time, not ticks" philosophy ([`timer.md`](timer.md#how-elapsed-time-is-computed)). But `Text(timerInterval:)` only knows a single start instant — it has no concept of `pausedSeconds` banked from an earlier running segment (an item resumed after being jumped away from mid-session, see [`timer.md`](timer.md#single-active-timer-pause-instead-of-complete-or-run-concurrently)). Every call site computes the already-existing "seeded elapsed" value (`pausedSeconds + (now - startedAt)`, the same expression used throughout `TasksView.tsx`/`TaskListSessionView.tsx` for the in-app ring) and derives `startedAt: new Date(Date.now() - seeded * 1000).toISOString()` from it — a start instant that, if fed straight into a naive "now minus this" count, already reproduces the correct accumulated elapsed time and continues counting up accurately from there. The native side never needs to know `pausedSeconds` exists.

### Estimated completion

A static (non-live) `Text(date, style: .time)` computed once as `startedAt + projectedMinutes` — not a second live-updating element. `projectedMinutes: 0` (stopwatch items) hides this line entirely.

## `lib/native/routine-activity.ts` — call sites

Thin wrappers (`startRoutineActivity`, `updateRoutineActivity`, `endRoutineActivity`) around `lib/native/live-activity-bridge.ts`'s `registerPlugin` call, each `Capacitor.isNativePlatform()`-gated and swallowing rejections — mirrors `lib/native/api-key-bridge.ts`'s pattern exactly, so every call site below is a single unguarded call with no try/catch of its own.

- **`start`** always ends any existing Activity first, then `request()`s a fresh one — safe given the single-active-timer invariant (at most one relevant Activity ever exists), and used for the standalone `TimerScreen` path (`TasksView.tsx`'s `handleStartTimer` resume/fresh-start branches, and `openInProgressTimer`'s cold-start resume).
- **`update`** mutates the existing Activity's `ContentState` in place if one exists, otherwise falls back to `start()` — used by `TaskListSessionView.tsx`'s per-item effect (the same effect keyed on `currentIndex` that already POSTs `in_progress`/seeds `elapsed` on every item switch — see [`timer.md`](timer.md#the-sequential-session-tasklistsessionviewtsx)). This fallback is what lets the *first* item of a session and every *subsequent* switch use the exact same call, with no separate "is this the first item" branch needed.
- **`end`** — called from `TasksView.tsx`'s `handleTimerComplete`/`handleTimerMissed` (standalone timer), and from two places in `TaskListSessionView.tsx`: the `advance()` summary branch and the foreground-revalidation effect's summary branch — both genuine "every item in the group is finished" moments.

**Deliberately *not* called from `TimerScreen`'s plain `onClose`, nor from `TaskListSessionView`'s `handleClose`** (the X button) — both leave the current item's log `in_progress` on the server rather than completing it, and the whole point of a Live Activity is staying visible on the Lock Screen after the app itself is closed. `handleClose` used to flush the current item to `done` before calling the parent's close handler (see [`timer.md`](timer.md#the-sequential-session-tasklistsessionviewtsx)); that was changed specifically because it made X indistinguishable from actually finishing the item, and a still-running Live Activity now gives a real reason to just dismiss the session view without finishing anything — the user resumes via the FAB's active-timer indicator instead.

**Checkbox and form tasks** (see [`timer.md`](timer.md)) have no ring timer of their own; `TaskListSessionView.tsx`'s per-item effect calls `end` rather than `update` when landing on either (`isCheckboxTask || isFormTask`), so the Lock Screen doesn't show a frozen, meaningless timer while the user is filling in a check's fields. Landing on the *next* timed item afterward goes through `update()`'s start-fallback, same as a session's very first item.

## Open App button

The Lock Screen/Dynamic Island button is a plain SwiftUI `Link(destination:)` (`openAppButton()` in `RoutineActivityLiveActivity.swift`), not an `AppIntent` — tapping it opens `https://chrps.vercel.app/tasks`. **Note (post-NFC-rework):** this section used to describe that tap as routing into the app via the same `com.apple.developer.associated-domains`/Universal Links entitlement the old tap-to-trigger NFC system relied on — that entitlement and its AASA route were removed entirely along with tap-to-trigger (see [`nfc.md`](nfc.md)'s "History: Tap-to-trigger (removed)"). The AASA file's `paths` were always scoped to `/nfc/*` only, never `/tasks`, so this button's own link likely never actually matched via Universal Links in the first place — unverified either way without a real device, flagging rather than asserting. No network call, no Keychain read, no `LiveActivityIntent` — the button does nothing but launch (or attempt to launch) the app to `/tasks`, where the FAB's existing active-timer resume pill (`components/BottomNav.tsx`'s `fetchActiveTimer`) already picks up whatever's `in_progress` with no query param needed, letting the user actually finish the task the normal in-app way (answer a form task's fields, do an NFC-bound task's in-app scan, etc.).

### Why it isn't a "Done" button anymore

The card used to have a one-tap **Done** button (`CompleteHabitFromActivityIntent`, a `LiveActivityIntent` calling the external API's `complete-active-task` endpoint — see [History](#history-the-done-button-20252026) below) that tried to complete the current task directly from the Lock Screen, with no app UI involved at all. That worked fine for the old timer-only habit model this feature was originally built for, but broke once virtually every task became `form`-type (the only creatable type post-pivot — see CLAUDE.md's Vocabulary section):

- **Most tasks need "questions" answered** — a form task's numeric readings or yes/no fields (`formFields`). A widget extension button has no UI to collect those, so a blind Done tap called `completeInProgressLog`/`startImmediateLog` with `formData: null` — the task got marked done with **no reading ever captured**, silently, no error shown.
- **Some tasks require an in-app NFC scan** — a task bound to a physical tag (`TaskDefinition.nfcTagUid`, see [`nfc.md`](nfc.md#in-app-scan-to-complete-binding)) can only be completed with a verified scan. `assertNfcVerified` (`lib/task-log-actions.ts`) unconditionally throws `NfcTagRequiredError` for every caller that can't supply one — which is every external trigger path, Done button included — so tapping Done on one of these just failed, with no way for a `LiveActivityIntent` to surface that error message anywhere the user would see it.

Both are unfixable from inside the widget extension process — there's no UI surface there to ask a question or scan a tag — so the button now opens the app instead of attempting either.

### What was removed

`CompleteHabitFromActivityIntent.swift` (the intent itself) and `ChrpsAPI.completeActiveHabit(apiKey:)` (the networking call backing it, in `ios/App/App/ChrpsAPI.swift`) were deleted outright when this button was replaced — nothing else called either. At the time, the backend (`lib/task-trigger.ts`'s `completeActiveTask()` and `POST /api/external/complete-active-task`) was deliberately left in place as orphaned-but-still-documented external API surface. **That's since changed too**: the entire external API (that route included) was deleted outright in a later pass, once Shortcuts/App Intents — its other major consumer — was also removed; `completeActiveTask()` itself is gone now, not just its route. See `docs/project-structure.md`'s "iOS Native Shell" section for that full removal.

### History: the "Done" button (2025–2026)

Kept for institutional memory — none of this describes current behavior. Getting the old Done button's *data* side right (which habit is "current," from inside a Live Activity extension process) took three iterations, because the failure modes were non-obvious and specific to that process, not an ordinary Shortcuts-invoked intent:

1. **`ChrpsAPI.triggerHabit(routineItemId:, routineGroupId:)` with those two values passed as the button's bound `@Parameter`s**, captured at `Button(intent:)` construction time from `context.state`. Confirmed on-device: tapping Done a *second* time while the screen had stayed asleep since the first tap re-fired against the *first* habit's id — the value baked into the button at the last time SwiftUI actually rendered it, not the current one, even though the Activity's real content state had already moved on.
2. **Same endpoint, but `perform()` read `routineItemId`/`routineGroupId` fresh from `Activity<RoutineActivityAttributes>.activities.first?.content.state`** instead of trusting the bound parameters — reasoning that it's a live, system-synced data source independent of view rendering. Confirmed on-device: this made the Done button do **nothing at all** — no completion, no advance — because `Activity.activities` was empty when queried from inside this intent's `perform()`, so the guard at the top of the function returned immediately.
3. **`POST /api/external/complete-active-task`** — takes no `routineItemId` at all, resolving "which task" server-side from the single in_progress `TaskLog` (server-authoritative, via the single-active-timer invariant). This is the one that actually worked, correctness no longer depending on any value the widget extension itself had to track or look up, only on the API key in Keychain.

A fourth iteration tried using `Activity.activities` for a *cosmetic-only* update — swap the card to show the newly-started next habit in place, falling back to `.end()` if that data wasn't available. **Confirmed via a Simulator log capture that this wasn't viable either**: `xcrun simctl spawn <udid> log stream` filtered to the `RoutineActivityExtension` process showed ActivityKit's own internal `[com.apple.activitykit:outputClient] Fetched descriptors for content states: []` logged nine times, ~200ms apart, staying empty for the full ~2 seconds `perform()` polled — the extension process's `ActivityClient` connection didn't finish syncing with the system's activity store fast enough, and 2 seconds was already too long to make an interactive widget button wait.

**Net effect while it existed, and not itself a bug**: tapping Done reliably completed the current habit and advanced to the next one (or finished the routine) *server-side* for genuine timer-based tasks — but the Lock Screen card itself kept showing the habit that was just completed until the app was next opened, at which point `TaskListSessionView.tsx`'s foreground-revalidation effect ([`timer.md`](timer.md)) caught it up. This card-staleness behavior is moot now — the Open App button never completes anything, so there's nothing for the card to have gotten stale about.

## No tap-through on the card body

`widgetURL`/`Link` on the card body itself (tapping anywhere that isn't the Open App button) remains deliberately unset — only the button is a `Link` (see [Open App button](#open-app-button) above), not the whole card. See that section's note on the now-removed Universal Links entitlement this used to also back. Making the entire card body tappable too would be a small additional change (another `Link` wrapping the outer `VStack`, or a `widgetURL` on the whole `ActivityConfiguration` view) — not done here since the button already covers the one interaction anyone's asked for, and a fully-tappable card risks accidental taps while just glancing at the Lock Screen.

## Palette and typography

`RoutineActivityLiveActivity.swift`'s `Palette` enum hardcodes the white/blue hex values from CLAUDE.md's Design System section (`bg`, `text`, `muted`, `olive`, `gold`, `done`) — a widget extension has no access to the app's Tailwind config. Token *names* (`olive`, `gold`) are kept from the pre-rebrand dark theme for continuity with the rest of this file, same convention as the web app's own tokens — only their hex values changed, now both resolving to the same blue accent. `Palette.done` is the one addition: the completed-timeline-segment color reads the dedicated Ch'rps Green token instead of the blue accent, matching the web app's own separation of "done" indicators from ordinary blue actions/buttons. Typography uses the system font (SF Pro), not Playfair Display/IBM Plex Mono — bundling and registering a custom font for a widget extension target was judged not worth it for a Lock Screen glance; only the color palette carries the brand.

## Push-driven updates

**Note (post-NFC-rework): this whole mechanism is now orphaned, not actively reachable.** It existed solely to update the Lock Screen card when a task changed via a path that bypassed the app's own foreground JS — specifically an NFC tap-to-trigger tap or a Shortcuts run. Both were removed entirely (see `docs/features/nfc.md`'s "History: Tap-to-trigger (removed)" and `docs/project-structure.md`'s "iOS Native Shell" section) — every remaining way to change a task's state (filling in a form, scanning an NFC-bound tag) runs through the app's own foreground JS by construction, which already updates the card locally. `lib/task-trigger.ts`'s `notifyLiveActivity()`/`buildTaskListTimeline()` — this section's push-sending code — were deleted along with the rest of `lib/task-trigger.ts`; `lib/apns.ts`'s `sendLiveActivityPush()`/`toAppleReferenceSeconds()`/`RoutineActivityContentState` (and the native push-token registration flow described below) are left in place but now have zero callers. Kept for reference below rather than deleted outright — cleaning up the token-registration flow touches native Swift and a live APNs integration, judged worth a deliberate follow-up pass rather than folding into the NFC registry rework that surfaced this.

Local `start`/`update`/`end` from `LiveActivityPlugin.swift` shares one limitation: it only works while the app's own process is alive and in the foreground to issue the call. An **NFC tap or a Shortcut, with the app not open**, changes the active task on the server with nothing able to tell the Lock Screen card about it (the Open App button no longer falls into this category at all — it never touches the server, so there's no card-staleness gap for it to close; see [History](#history-the-done-button-20252026) above for why that used to be different when the button was itself a server-calling intent). Apple's actual answer to this general problem is **ActivityKit push updates** — the server sends an Apple Push Notification carrying the new content state, and iOS renders it directly, with no app or extension process needing to be running or synced at all.

### Token flow

1. `LiveActivityPlugin.start()` requests the Activity with `pushType: .token` (was `nil`) — this makes iOS issue a **push-to-update token** specific to that Activity (distinct from a device's general remote-notification token; no Notifications permission prompt involved).
2. `observePushToken(for:)` consumes `Activity<RoutineActivityAttributes>.pushTokenUpdates` (an `AsyncSequence` that yields a new token whenever iOS (re)issues one, and finishes on its own once the Activity ends) and forwards each one to JS via `notifyListeners("pushTokenReceived", ...)`, hex-encoded, tagged with `"sandbox"` or `"production"` via a `#if DEBUG` check (this project's only build config today is Debug/Development-signed, which must push through APNs' sandbox host — see the entitlement note below).
3. `lib/native/routine-activity.ts`'s `registerPushTokenForwarding()` — called once from `components/NativeBootstrap.tsx`, same pattern as the API key bridge — listens for that event and `POST`s it to `/api/live-activity/push-token`.
4. That route (session-authenticated, not the API key — this call originates from the app's own logged-in context) upserts `User.liveActivityPushToken`/`liveActivityPushEnvironment`, always overwriting rather than versioning: only the latest token is ever usable, and there's at most one relevant Live Activity per user (single-active-timer invariant).

### Sending a push

`lib/apns.ts`'s `sendLiveActivityPush()` — signs a fresh ES256 provider JWT per call (via `jose`, already present transitively through `@auth/core` and pinned as a direct dependency) using `APNS_KEY_ID`/`APNS_TEAM_ID`/`APNS_PRIVATE_KEY`, then POSTs to `https://api.push.apple.com` or `.sandbox.` over HTTP/2 (Node's built-in `http2` client — APNs requires HTTP/2, HTTP/1.1 isn't supported) with `apns-topic: com.bostonbijold.chrps.push-type.liveactivity` and `apns-push-type: liveactivity`. One connection per call — correct at this app's volume (a personal, single-user app sending at most a handful of pushes a day), not tuned for the connection-reuse a high-throughput provider would want.

`lib/task-trigger.ts`'s `notifyLiveActivity()` builds the actual payload and is called from `triggerTask()` after it resolves — the NFC Universal Link tap (`app/nfc/[tagCode]/page.tsx`), the only entry point left; `completeActiveTask()`, which used to call this too, was deleted along with the rest of the external API (see `docs/project-structure.md`'s "iOS Native Shell" section). Not called from the in-app `/api/task-logs` routes, since those are already covered by the app's own local `update()`/`end()` calls firing from foreground JS. It looks up the target task (whichever just started, or whichever just completed if nothing new started) via `Task`/`TaskList` directly — full DB access, so the pushed content state is always fully correct (`projectedMinutes` included, no `0`-placeholder needed) on the first try. Sends an `"update"` event if something's now active, an `"end"` event (with a `dismissal-date` of now) if nothing is. Wrapped in a try/catch that never throws — a push failure shouldn't fail the task-completion request that triggered it.

**`content-state`'s `startedAt` is a JSON number, not an ISO string — and specifically seconds since the Cocoa reference date (2001-01-01T00:00:00Z), not Unix epoch seconds.** Swift's default `Codable` synthesis for `Date` (`.deferredToDate`, which `RoutineActivityAttributes.ContentState` doesn't override, and which is what APNs-delivered content actually gets decoded through on-device) encodes/decodes `Date` as `timeIntervalSinceReferenceDate`, not `timeIntervalSince1970` — a 31-year, `978307200`-second difference that's a genuinely common Foundation gotcha, not specific to this feature. Confirmed on-device: sending raw Unix seconds decoded to a `startedAt` ~31 years in the future, so the Lock Screen's `Text(timerInterval:)` — whose displayed range never included "now" — just showed a frozen value instead of counting up, even though the habit name/label updated correctly (those are plain strings, unaffected). `lib/apns.ts`'s `toAppleReferenceSeconds()` does the conversion; `lib/task-trigger.ts`'s `notifyLiveActivity()` is the only caller.

This is the one place in this feature where the wire format for the *same* struct differs depending on the transport: the local plugin's `parseContentState` reads an ISO string (matching JS's `Date#toISOString()`) because that request is JSON-encoded by hand in `LiveActivityPlugin.swift`'s own Capacitor call layer, not by `Codable` — so the reference-date gotcha above is specific to the push path and doesn't affect local `start`/`update`/`end` calls at all.

### Push Notifications entitlement

`App.entitlements` needs `aps-environment` for the Activity to receive a push token at all — added as `development` (matching this project's only build config, Debug/Development-signed; would need to become `production` alongside an eventual Distribution-signed Release build). Same underlying entitlement ordinary remote notifications would need if this app ever adds those — `lib/apns.ts`'s JWT-signing and HTTP/2 send logic is written to be reusable for that (only the payload shape and `apns-push-type` header are Live-Activity-specific), even though nothing else calls it yet.

### What still doesn't get pushed live

An NFC tap or a Shortcut run with the app not open still updates the card only as fast as the resulting push arrives (typically under a second, but not instant) — there's no synchronous, same-tap cosmetic update path for either. This used to also describe the old Done button specifically (its `perform()` never touched `Activity.activities` for a same-tap update, so tapping Done wouldn't flip the card instantly either); that's moot now since the Open App button doesn't touch the server or the card at all.

## Countdown timer, and colors

`RoutineActivityLiveActivity.swift`'s `timerText(_:size:)` shows a real countdown (`Text(timerInterval:countsDown: true)`) toward the target for items with `projectedMinutes > 0`, falling back to the plain count-up elapsed display (as before) for stopwatch items with no target. `timerColor(_:)` is a deliberately simpler two-color scheme than the in-app ring's olive → amber → burgundy: olive until 75% of target, amber from there on — including once over target, where the in-app ring would step to burgundy but this doesn't. Confirmed with the user that's the wanted behavior here specifically, not an oversight.

**Does flip to a live "+HH:MM:SS" count-up once over target, matching the in-app ring** — an earlier version of this doc said this wasn't achievable without a scheduled push exactly at the crossing moment, reasoning that `Text(timerInterval:)` has no built-in "count down, then count up past zero" mode. That's still true of a *single* `Text(timerInterval:)`, but it turned out not to matter: `timerText(_:size:)` branches at render time — `if Date() >= target`, it renders `overtimeText(from:)` (a fresh count-up `Text(timerInterval:)` anchored to `target`, prefixed with `"+"` via SwiftUI's `Text` concatenation) instead of the countdown. The flip happens at the next real redraw (a local/push update, or an OS-triggered periodic reload), not necessarily the exact crossing instant — the same "eventually consistent" characteristic every other live-computed value in this file already has, not a new limitation.

**No way to hide the seconds field** — confirmed while designing this: `Text(timerInterval:)` has no API for suppressing seconds, only `showsHours` (HH:MM:SS vs MM:SS). A "+3:47" ticking every second was accepted as reading fine, framed as an explicit overage badge rather than a wall-clock label that would look broken ticking seconds.

**A freshly-started Activity's countdown can render as a frozen, non-ticking snapshot** — confirmed on-device: starting a routine while the phone was already locked showed the full target duration (e.g. `10:00`) the entire time, only beginning to actually tick once the app was reopened and its own foreground re-sync issued a fresh `update()` call. `LiveActivityPlugin.start()` now works around this by following its own `request()` with an `update()` call carrying identical content ~500ms later — the extra call is what attaches live-ticking behavior; a `request()` alone was, at least in this instance, not sufficient on its own.

## Task list timeline

The original single "Finish by 7:45 AM" line read ambiguously once a routine had more than one item left — indistinguishable from "this *habit* finishes at 7:45," which was never the intent. `ContentState.timelineSegments`/`routineStartedAt`/`routineFinishAt` (`RoutineActivityAttributes.swift`) carry a whole-routine view instead: a proportional segment bar (`timelineBar`/`routineTimelineBlock`, `RoutineActivityLiveActivity.swift`) plus the routine's actual start time and live projected finish, both shown side-by-side with the bar. Empty/`nil` (a standalone, non-session timer, which has no routine to show one for) falls back to the original single-habit `finishLine`.

**The math is the exact same functions the in-app view already uses** — `lib/projected-finish.ts`'s `TaskProjection`/`projectedFinishTime` and `lib/task-timeline.ts`'s `computeTimeline`, both pure functions with no React dependency, so nothing needed reimplementing:

- **Local path** (`TaskListSessionView.tsx`'s per-item switch effect) builds `projectionItems` from `items` + the `records` it already just fetched via `fetchDayLogs()` (the current item is `"active"`, everything else resolved from that fresh fetch — simpler than the render-time version below it, which additionally has to reconcile `sessionLogs`/`latestLogs`/`externalLogs` precedence for its own live display) and passes `timelineSegments`/`routineStartedAt`/`routineFinishAt` alongside the existing fields in the same `updateRoutineActivity(...)` call — no new call site, no extra bridge round-trip.
- **Push path** (`lib/task-trigger.ts`'s new `buildTaskListTimeline()`, called from `notifyLiveActivity()` whenever `target.sessionTaskListId` is set) does the server-side equivalent: queries every active `Task` in the list plus today's `TaskLog`s for them, resolves each to the same four-state `TaskProjection`, and calls the identical `computeTimeline`/`projectedFinishTime`.

Both paths map `TimelineColorState`'s `"active-over"` to `"activeOver"` before sending — a Swift-identifier-friendly rename, not a semantic change; `RoutineActivityAttributes.TimelineSegment.colorState` is a plain `String`, not a Swift enum, so this is just string matching in `timelineSegmentColor(_:)`, not a shared type.

**One deliberate divergence from `computeTimeline`'s own color mapping**: `lib/task-timeline.ts` always reports a `"done"` item as olive regardless of variance (matching `TaskRow`'s done badge elsewhere in the app — see that file's own comment), and that in-app behavior is untouched. But confirmed with the user: on the Lock Screen specifically, a habit that ran well over target reverting straight to green the moment it's marked done loses information worth keeping visible at a glance. Both `TaskListSessionView.tsx` (via a local `projectionById` lookup) and `buildTaskListTimeline()` server-side re-label a segment as `"activeOver"` (amber) whenever its underlying `TaskProjection` is `state: "done"` with `actualMinutes > projectedMinutes` — a payload-building-time override, not a change to `computeTimeline` or anything the in-app timeline bar renders.

Like the countdown/color above, this is refreshed only on an item switch (or a push trigger), not per-second — a routine's projected finish time doesn't need second-level precision on a Lock Screen glance, and refreshing on every habit transition is already far more granular than the "only updates when the app is reopened" gap this feature exists to close.

**The active item's own segment is a second exception, and can't be a payload-building-time override the way the done-over-target one is.** Confirmed by the user: while a habit was still running and went over target, the timer text correctly turned amber (it's computed live from `Date()` on every render — see above) but its timeline segment stayed olive, because unlike the timer text, a segment's `colorState` is just a string read straight off whatever `ContentState` was last pushed — computed once, at update time, then frozen until the next update/push, with nothing to correct it as real time passes and the *same* habit quietly crosses from on-track to over. `timelineBar` now special-cases this: a segment whose `colorState` is `"active"` or `"activeOver"` (there's always at most one — `computeTimeline` only ever gives the current item one of those two states) ignores that static string entirely and renders via `timerColor(state)` instead, live, the same function the timer text already uses. Every other segment (`"done"`, `"pending"`) still reads its static color normally — only the one segment that can actually go stale between updates needed the live path.

**`routineFinishAt` itself turns out not to need a live correction, only a live *addition*.** The user's original ask was for the finish time to visibly creep later, minute by minute, while a habit sits over target with no new push arriving — genuinely not achievable the way the timer text is (there's no SwiftUI primitive for "a live-updating absolute clock time," only durations). But the math resolves it without one: `routineFinish` is sent at the moment the active item *starts* (elapsed ≈ 0, still on schedule), so the value sent is always exactly `targetInstant + (sum of every pending item's projectedMinutes)` — call this `baseFinish`. Once the active item runs over its own target, `lib/projected-finish.ts`'s `remainingMinutes` stops crediting it anything further, so the *true* live finish is `now + (that same pending sum)` — which is algebraically identical to `baseFinish + (now - targetInstant)`, i.e. `baseFinish` plus however long the active item has been over. That second term is exactly `overtimeText(from:)` — the same count-up powering the timer flip above. So `routineFinish` never needs correcting on its own; `overtimeBadge(_:)` appends that live "+HH:MM:SS" right next to it, inline, whenever the active item is over target, and the two numbers together are always exactly right.

**Known cosmetic issue, not yet resolved**: the badge sits inline with "Finish by" in the same `HStack`, trailing-anchored via a `Spacer` — so "Finish by"'s own position visibly shifts as the badge appears and as its digit count changes tick to tick, since anything sharing that `HStack` reflows when the badge's width changes. A separate-row layout was tried to fix this and rolled back — confirmed by the user it didn't actually help — so this is back to the simpler inline version with the shift still present, rather than carrying unproven complexity forward for no benefit.

## Setting it up

This only ships via an actual `xcodebuild`/install cycle, not a web-only Vercel deploy. After installing:

1. Start any routine timer — the Lock Screen card should appear within a second or two (no permission prompt beyond the OS's standard Live Activities toggle, on by default).
2. Confirm Settings → Face ID & Passcode (or per-app) hasn't disabled Live Activities for Ch'rps — `LiveActivityPlugin.isSupported()` surfaces `ActivityAuthorizationInfo().areActivitiesEnabled` if this needs checking programmatically later.
3. For push updates specifically: `APNS_KEY_ID`/`APNS_TEAM_ID`/`APNS_PRIVATE_KEY` need to be set both locally (`.env.local`) and on Vercel (production env) — see CLAUDE.md's Environment Variables section. A **physical device is required to test this end to end**; the Simulator cannot receive genuine APNs pushes (only `xcrun simctl push` for locally-simulated payloads, which doesn't exercise the real server round trip).

## Depends on

[`timer.md`](timer.md) (elapsed-time computation, the single-active-timer invariant, the Task List Session's per-task switch effect and foreground-revalidation effect) and [`nfc.md`](nfc.md#native-setup) (the Universal Links entitlement the Open App button reuses). Used to also depend on the external API and the native App Intents layer's Keychain bridge — both deleted entirely, see `docs/project-structure.md`'s "iOS Native Shell" section.
