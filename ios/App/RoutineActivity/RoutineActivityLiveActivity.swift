import ActivityKit
import WidgetKit
import SwiftUI

// Ch'rps' white/blue palette, hardcoded here since a widget extension can't
// reach the app's Tailwind config — see CLAUDE.md's Design System section
// for the source values. Token *names* (olive, gold) are kept from the old
// dark theme for continuity with the rest of this file — only their hex
// values changed, same convention CLAUDE.md documents for the web app's own
// tokens.
private enum Palette {
    static let bgPrimary = Color(red: 0xff / 255, green: 0xff / 255, blue: 0xff / 255)
    static let textPrimary = Color(red: 0x0f / 255, green: 0x17 / 255, blue: 0x2a / 255)
    static let textMuted = Color(red: 0x64 / 255, green: 0x74 / 255, blue: 0x8b / 255)
    static let olive = Color(red: 0x25 / 255, green: 0x63 / 255, blue: 0xeb / 255)
    static let gold = Color(red: 0x3b / 255, green: 0x82 / 255, blue: 0xf6 / 255)
    static let amber = Color(red: 0xd9 / 255, green: 0x77 / 255, blue: 0x06 / 255)
    // Ch'rps Green — completed-timeline-segment only, kept distinct from the
    // blue `olive`/`gold` accent same as the web app's own `done` token (see
    // CLAUDE.md's Design System section).
    static let done = Color(red: 0x22 / 255, green: 0xb3 / 255, blue: 0x7c / 255)
}

// A 24h upper bound is just a cap for Text(timerInterval:)'s range — no
// habit timer runs anywhere near that long; it only needs to be safely
// beyond any realistic elapsed time so the text never stops updating.
private func elapsedRange(from startedAt: Date) -> ClosedRange<Date> {
    startedAt...startedAt.addingTimeInterval(24 * 60 * 60)
}

// A live "+HH:MM:SS" (or "+MM:SS") count-up from the moment a target was
// crossed — used both by timerText's post-target branch and by the routine
// finish badge below. The two are the same number by construction: once
// the active item is over its own target, its remaining contribution to
// the routine's projected finish is zero (lib/projected-finish.ts's
// remainingMinutes), so routineFinishAt(now) == (the finish time as of the
// moment target was crossed) + (however long over target now) — i.e.
// exactly this count-up. No seconds-hiding is possible here:
// Text(timerInterval:) has no API for suppressing the seconds field, only
// showsHours toggling HH:MM:SS vs MM:SS — confirmed with the user this
// reads fine framed as an explicit "+" overage, unlike a wall-clock label
// silently ticking seconds would.
private func overtimeText(from target: Date) -> Text {
    Text("+") + Text(timerInterval: target...target.addingTimeInterval(24 * 60 * 60), countsDown: false, showsHours: false)
}

private func targetInstant(_ state: RoutineActivityAttributes.ContentState) -> Date? {
    guard state.projectedMinutes > 0 else { return nil }
    return state.startedAt.addingTimeInterval(TimeInterval(state.projectedMinutes * 60))
}

private func estimatedFinish(_ state: RoutineActivityAttributes.ContentState) -> Date? {
    targetInstant(state)
}

// Two-color scheme (olive → amber), deliberately simpler than the in-app
// countdown ring's olive → amber → burgundy — confirmed with the user that
// on the Lock Screen, "over target" should read the same amber as the
// 75%-warning state, not step further to burgundy. Evaluated at render
// time, so — like the timer text itself — this only updates when the
// widget actually redraws (a local/push update, or an OS-triggered
// periodic reload), not continuously; see docs/features/live-activity.md's
// platform note on this.
private func timerColor(_ state: RoutineActivityAttributes.ContentState) -> Color {
    guard let target = targetInstant(state) else { return Palette.olive }
    let totalSeconds = TimeInterval(state.projectedMinutes * 60)
    guard totalSeconds > 0 else { return Palette.olive }
    if Date() >= target { return Palette.amber }
    let ratio = Date().timeIntervalSince(state.startedAt) / totalSeconds
    if ratio >= 0.75 { return Palette.amber }
    return Palette.olive
}

// Countdown-to-target for items with a projected time, flipping to a live
// "+HH:MM:SS" count-up (overtimeText, above) once "now" passes it — matches
// the in-app ring's own countdown-then-overtime behavior. This branch is
// evaluated at render time (see timerColor's comment on what that means for
// freshness), so the flip itself happens at the next real redraw, not
// necessarily the exact crossing instant — same "eventually consistent"
// characteristic already documented for color/timeline updates elsewhere in
// this feature, not a new limitation. Falls back to a plain count-up
// elapsed display for stopwatch items (projectedMinutes == 0, no target to
// count down to or over).
@ViewBuilder
private func timerText(_ state: RoutineActivityAttributes.ContentState, size: CGFloat) -> some View {
    if let target = targetInstant(state) {
        Group {
            if Date() >= target {
                overtimeText(from: target)
            } else {
                Text(timerInterval: state.startedAt...target, countsDown: true, showsHours: false)
            }
        }
        .font(.system(size: size, weight: .semibold, design: .monospaced))
        .foregroundStyle(timerColor(state))
        .monospacedDigit()
    } else {
        Text(timerInterval: elapsedRange(from: state.startedAt), countsDown: false, showsHours: false)
            .font(.system(size: size, weight: .semibold, design: .monospaced))
            .foregroundStyle(Palette.textPrimary)
            .monospacedDigit()
    }
}

// Mirrors lib/routine-timeline.ts's TIMELINE_COLOR map (done reads
// Palette.done — "in hand" regardless of variance, unless the payload
// already re-labeled it "activeOver" for running over target while done,
// see docs/features/live-activity.md — pending is a dim neutral fill).
// Deliberately does NOT handle "active"/"activeOver" — those are always
// resolved live via timerColor(_:) instead, see the comment on
// timelineBar below for why a static lookup isn't enough for that one.
private func timelineSegmentColor(_ colorState: String) -> Color {
    switch colorState {
    case "done": return Palette.done
    case "activeOver": return Palette.amber
    default: return Palette.textMuted.opacity(0.35) // "pending"
    }
}

// One segment per remaining/completed item in the routine, proportional to
// its current share of the group's running total — see
// lib/routine-timeline.ts (the same math, computed JS-side and shipped over
// as plain pct/colorState pairs, since neither the app process nor the push
// sender can hand the widget extension a live-recomputing view). Only shown
// when the current habit belongs to a routine (see ContentState's
// timelineSegments/routineStartedAt/routineFinishAt doc comment) — a
// standalone timer falls back to the simpler per-habit finishLine below.
//
// The active item's own segment is the one exception to "just read
// colorState off the payload": that string was fixed at whatever moment
// the last update/push fired, so a habit that was on-track when its timer
// started but has since run over target would otherwise stay olive
// indefinitely, with no new push to correct it — confirmed by the user:
// only the timer text (already computed live via timerColor(_:), not read
// from the payload) reflected running over; the segment didn't. There's
// only ever one such segment (computeTimeline gives the current item
// "active"/"active-over" — mapped to "active"/"activeOver" for the wire —
// and nothing else), so matching on that colorState value is enough to
// find it without needing per-segment ids.
private func timelineBar(_ state: RoutineActivityAttributes.ContentState) -> some View {
    GeometryReader { geo in
        HStack(spacing: 2) {
            ForEach(Array(state.timelineSegments.enumerated()), id: \.offset) { _, segment in
                let isActiveSegment = segment.colorState == "active" || segment.colorState == "activeOver"
                RoundedRectangle(cornerRadius: 2)
                    .fill(isActiveSegment ? timerColor(state) : timelineSegmentColor(segment.colorState))
                    .frame(width: max(3, geo.size.width * CGFloat(segment.pct / 100)))
            }
        }
    }
    .frame(height: 6)
}

@ViewBuilder
private func routineTimelineBlock(_ state: RoutineActivityAttributes.ContentState) -> some View {
    if !state.timelineSegments.isEmpty, let routineStart = state.routineStartedAt, let routineFinish = state.routineFinishAt {
        VStack(alignment: .leading, spacing: 5) {
            timelineBar(state)
            HStack {
                Text(routineStart, style: .time)
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(Palette.textMuted)
                Spacer()
                HStack(spacing: 4) {
                    Image(systemName: "flag.checkered")
                        .font(.system(size: 10, weight: .semibold))
                    Text(routineFinish, style: .time)
                        .font(.system(size: 13, weight: .semibold))
                    overtimeBadge(state)
                }
                .foregroundStyle(Palette.textPrimary)
            }
        }
    } else {
        finishLine(state)
    }
}

// The static `routineFinish` sent in the payload is the "on-schedule"
// projected finish as of the moment the active item started — which is
// exactly baseFinish in the derivation above, so it stays correct as a
// reference point and never needs correcting on its own. This badge is the
// live correction on top of it: how much later the true finish now is,
// ticking up in lockstep with the active item's own overtime. Hidden
// entirely while the active item is still on schedule.
//
// Inline next to "Finish by", not on its own row — a separate-row version
// was tried and rolled back: confirmed by the user it didn't actually fix
// anything, so this reverts to the simpler inline layout rather than carry
// unproven complexity forward.
@ViewBuilder
private func overtimeBadge(_ state: RoutineActivityAttributes.ContentState) -> some View {
    if let target = targetInstant(state), Date() >= target {
        overtimeText(from: target)
            .font(.system(size: 12, weight: .semibold, design: .monospaced))
            .foregroundStyle(Palette.amber)
    }
}

@ViewBuilder
private func finishLine(_ state: RoutineActivityAttributes.ContentState) -> some View {
    if let finish = estimatedFinish(state) {
        HStack(spacing: 6) {
            Image(systemName: "flag.checkered")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Palette.gold)
            Text("Finish by \(finish, style: .time)")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Palette.textPrimary)
            overtimeBadge(state)
        }
    }
}

// Opens the app instead of trying to complete the current task itself —
// see docs/features/live-activity.md's "Open App button" section for why
// the old one-tap "Done" (CompleteHabitFromActivityIntent, now removed)
// didn't work: most tasks are `form`-type, needing readings/yes-no answers
// this widget has no UI to collect, and some are bound to a physical NFC
// tag requiring an in-app scan — a blind completion either silently
// recorded a check with no data captured, or failed outright with no way
// to show why. A plain Link (not an intent) needs no KeychainHelper/API
// call at all — it just needs Universal Links to route it into the app,
// the same applinks:www.chrps.app entitlement the NFC tap-to-trigger
// flow already relies on (see nfc.md's "Native setup") — landing on
// /tasks, where the FAB's existing active-timer resume pill already picks
// up whatever's in_progress with no query param needed (see
// components/BottomNav.tsx's fetchActiveTimer).
private func openAppButton() -> some View {
    Link(destination: URL(string: "https://www.chrps.app/tasks")!) {
        Text("Open App")
            .font(.system(size: 13, weight: .semibold))
            .frame(maxWidth: .infinity)
    }
    .tint(Palette.olive)
    .buttonStyle(.borderedProminent)
}

struct RoutineActivityLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RoutineActivityAttributes.self) { context in
            // ── Lock Screen / banner ──
            let state = context.state
            VStack(alignment: .leading, spacing: 10) {
                Text(state.routineLabel.uppercased())
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(1.2)
                    .foregroundStyle(Palette.gold)

                HStack(alignment: .firstTextBaseline) {
                    Text(state.habitName)
                        .font(.system(size: 19, weight: .semibold))
                        .foregroundStyle(Palette.textPrimary)
                        .lineLimit(1)
                    Spacer()
                    timerText(state, size: 19)
                        .frame(minWidth: 64, alignment: .trailing)
                }

                routineTimelineBlock(state)

                openAppButton()
            }
            .padding(16)
            .activityBackgroundTint(Palette.bgPrimary)
            .activitySystemActionForegroundColor(Palette.textPrimary)

        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(state.routineLabel.uppercased())
                            .font(.system(size: 9, weight: .semibold))
                            .tracking(1)
                            .foregroundStyle(Palette.gold)
                        Text(state.habitName)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Palette.textPrimary)
                            .lineLimit(1)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    timerText(state, size: 17)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 8) {
                        routineTimelineBlock(state)
                        openAppButton()
                    }
                }
            } compactLeading: {
                Image(systemName: "timer")
                    .foregroundStyle(Palette.gold)
            } compactTrailing: {
                timerText(state, size: 13)
                    .frame(maxWidth: 44)
            } minimal: {
                Image(systemName: "timer")
                    .foregroundStyle(Palette.gold)
            }
            .keylineTint(Palette.olive)
        }
    }
}
