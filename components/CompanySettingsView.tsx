"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronLeft, Play, Check } from "lucide-react";
import Header from "@/components/Header";
import { playNotificationSound, type NotificationSound } from "@/lib/notification-sound";

interface Props {
  userName: string;
  skipAuth: boolean;
  initialNotificationSound: NotificationSound;
  initialTimezone: string | null;
  initialNotificationsEnabled: boolean;
  initialMissedAlertGraceMinutes: number | null;
  initialMissedAlertIncludeOwner: boolean;
}

const OPTIONS: { value: NotificationSound; label: string; description: string }[] = [
  { value: "standard", label: "Standard", description: "The default chirp." },
  { value: "male", label: "Male", description: "An alternate chirp voice." },
];

// A curated list, not every IANA zone — this app is US-restaurant-first
// today. "Detect automatically" below covers anything outside this list by
// reading the manager's own browser zone directly.
const TIMEZONE_OPTIONS = [
  { value: "America/New_York", label: "Eastern (New York)" },
  { value: "America/Chicago", label: "Central (Chicago)" },
  { value: "America/Denver", label: "Mountain (Denver)" },
  { value: "America/Phoenix", label: "Mountain, no DST (Phoenix)" },
  { value: "America/Los_Angeles", label: "Pacific (Los Angeles)" },
  { value: "America/Anchorage", label: "Alaska (Anchorage)" },
  { value: "Pacific/Honolulu", label: "Hawaii (Honolulu)" },
];

export default function CompanySettingsView({
  userName,
  skipAuth,
  initialNotificationSound,
  initialTimezone,
  initialNotificationsEnabled,
  initialMissedAlertGraceMinutes,
  initialMissedAlertIncludeOwner,
}: Props) {
  const [notificationSound, setNotificationSound] = useState<NotificationSound>(initialNotificationSound);
  const [timezone, setTimezone] = useState<string | null>(initialTimezone);
  const [notificationsEnabled, setNotificationsEnabled] = useState(initialNotificationsEnabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Missed-alert grace period — how many minutes past a shift-window list's
  // end time before managers get the "missed" push (see
  // docs/features/notifications.md's "Missed-list alerts"). null = off for
  // this company entirely, distinct from the broader notificationsEnabled
  // switch above (which covers start-time reminders too). lastGraceMinutes
  // remembers the manager's own number across an off/on toggle within this
  // session — the number field stays populated with whatever they last
  // typed rather than resetting to 30 every time they flip it back on.
  const [missedAlertGraceMinutes, setMissedAlertGraceMinutes] = useState<number | null>(
    initialMissedAlertGraceMinutes
  );
  const [lastGraceMinutes, setLastGraceMinutes] = useState(initialMissedAlertGraceMinutes ?? 30);
  const [graceMinutesDraft, setGraceMinutesDraft] = useState(String(initialMissedAlertGraceMinutes ?? 30));
  const [graceMinutesError, setGraceMinutesError] = useState("");

  // Whether the missed-list push includes the owner alongside managers —
  // see docs/features/notification-job-tag-targeting.md. Unaffected by
  // job-tag targeting (that only narrows start-time reminders); this is a
  // separate, role-based on/off switch for the missed-alert escalation.
  const [missedAlertIncludeOwner, setMissedAlertIncludeOwner] = useState(initialMissedAlertIncludeOwner);

  const patch = async (body: Record<string, unknown>) => {
    setError("");
    try {
      const res = await fetch("/api/company/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error();
      return true;
    } catch {
      setError("Failed to save — please try again.");
      return false;
    }
  };

  const handleSelect = async (value: NotificationSound) => {
    if (value === notificationSound || saving) return;
    const previous = notificationSound;
    setNotificationSound(value);
    setSaving(true);
    if (!(await patch({ notificationSound: value }))) setNotificationSound(previous);
    setSaving(false);
  };

  const handleTimezoneChange = async (value: string) => {
    if (value === timezone || saving) return;
    const previous = timezone;
    setTimezone(value);
    setSaving(true);
    if (!(await patch({ timezone: value }))) setTimezone(previous);
    setSaving(false);
  };

  const handleDetectTimezone = () => {
    try {
      handleTimezoneChange(Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch {
      setError("Couldn't detect your timezone — please pick one manually.");
    }
  };

  const handleToggleAlerts = async () => {
    if (saving) return;
    const previous = notificationsEnabled;
    const next = !previous;
    setNotificationsEnabled(next);
    setSaving(true);
    if (!(await patch({ notificationsEnabled: next }))) setNotificationsEnabled(previous);
    setSaving(false);
  };

  const handleToggleMissedAlerts = async () => {
    if (saving) return;
    const previous = missedAlertGraceMinutes;
    const turningOn = previous === null;
    const next = turningOn ? lastGraceMinutes : null;
    setMissedAlertGraceMinutes(next);
    if (turningOn) setGraceMinutesDraft(String(lastGraceMinutes));
    setSaving(true);
    if (!(await patch({ missedAlertGraceMinutes: next }))) setMissedAlertGraceMinutes(previous);
    setSaving(false);
  };

  const commitGraceMinutes = async () => {
    setGraceMinutesError("");
    const parsed = parseInt(graceMinutesDraft, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 240) {
      setGraceMinutesError("Enter a number of minutes between 0 and 240.");
      setGraceMinutesDraft(String(lastGraceMinutes));
      return;
    }
    setLastGraceMinutes(parsed);
    setGraceMinutesDraft(String(parsed));
    // Alerts are off (missedAlertGraceMinutes === null) — just remember the
    // number for whenever the manager flips the toggle back on, no need to
    // save anything to the server yet.
    if (missedAlertGraceMinutes === null || parsed === missedAlertGraceMinutes) return;
    const previous = missedAlertGraceMinutes;
    setSaving(true);
    setMissedAlertGraceMinutes(parsed);
    if (!(await patch({ missedAlertGraceMinutes: parsed }))) setMissedAlertGraceMinutes(previous);
    setSaving(false);
  };

  const handleToggleIncludeOwner = async () => {
    if (saving) return;
    const previous = missedAlertIncludeOwner;
    const next = !previous;
    setMissedAlertIncludeOwner(next);
    setSaving(true);
    if (!(await patch({ missedAlertIncludeOwner: next }))) setMissedAlertIncludeOwner(previous);
    setSaving(false);
  };

  return (
    <div className="min-h-dvh bg-bg">
      <div className="mx-auto max-w-mobile px-4 pb-28">
        <Header userName={userName} skipAuth={skipAuth} />

        <div className="mt-4 mb-5 flex items-center gap-2">
          <Link href="/profile" className="flex items-center gap-1 text-muted font-body text-sm min-h-[44px]" aria-label="Back">
            <ChevronLeft size={16} />
          </Link>
          <h1 className="font-heading text-xl text-text">Company Settings</h1>
        </div>

        <p className="font-mono text-[10px] text-dim uppercase tracking-widest mb-3">
          NFC Save Sound
        </p>
        <p className="font-body text-xs text-muted mb-4">
          Plays on this device when a task is completed by scanning its linked NFC tag.
        </p>

        <div className="space-y-2">
          {OPTIONS.map((opt) => {
            const selected = notificationSound === opt.value;
            return (
              <div
                key={opt.value}
                className={`flex items-center gap-2 bg-card rounded-card border p-4 transition-colors ${
                  selected ? "border-olive" : "border-border"
                }`}
              >
                <button
                  type="button"
                  onClick={() => handleSelect(opt.value)}
                  disabled={saving}
                  className="flex-1 min-w-0 flex items-center justify-between text-left min-h-[44px] disabled:opacity-60"
                >
                  <div className="min-w-0">
                    <p className="font-body text-sm text-text">{opt.label}</p>
                    <p className="font-mono text-[10px] text-dim mt-0.5">{opt.description}</p>
                  </div>
                  {selected && (
                    <span className="flex-shrink-0 w-6 h-6 rounded-full bg-olive flex items-center justify-center ml-2">
                      <Check size={13} strokeWidth={3} className="text-bg" />
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => playNotificationSound(opt.value)}
                  aria-label={`Preview ${opt.label} sound`}
                  className="flex-shrink-0 w-9 h-9 rounded-full border border-border-light flex items-center justify-center text-muted hover:text-olive transition-colors"
                >
                  <Play size={13} />
                </button>
              </div>
            );
          })}
        </div>

        <p className="font-mono text-[10px] text-dim uppercase tracking-widest mt-8 mb-3">
          Timezone
        </p>
        <p className="font-body text-xs text-muted mb-4">
          Used to know when a shift-window task list&rsquo;s scheduled time has actually opened or
          passed — checklist alerts below are timed against this.
        </p>
        <div className="flex gap-2">
          <select
            value={timezone ?? ""}
            onChange={(e) => handleTimezoneChange(e.target.value)}
            disabled={saving}
            className="flex-1 min-w-0 bg-card border border-border rounded-card px-3 py-3 font-body text-sm text-text outline-none focus:border-border-light disabled:opacity-60"
          >
            <option value="" disabled>
              Select a timezone
            </option>
            {timezone && !TIMEZONE_OPTIONS.some((o) => o.value === timezone) && (
              <option value={timezone}>{timezone}</option>
            )}
            {TIMEZONE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleDetectTimezone}
            disabled={saving}
            className="flex-shrink-0 border border-border-light text-muted font-body text-xs px-3 rounded-card disabled:opacity-60 hover:text-olive hover:border-olive/40 transition-colors"
          >
            Detect
          </button>
        </div>

        <p className="font-mono text-[10px] text-dim uppercase tracking-widest mt-8 mb-3">
          Checklist Alerts
        </p>
        <div className="flex items-center gap-3 bg-card rounded-card border border-border p-4">
          <div className="min-w-0 flex-1">
            <p className="font-body text-sm text-text">Push notifications</p>
            <p className="font-mono text-[10px] text-dim mt-0.5">
              A nudge to everyone right when a shift checklist is due to start, and a heads-up to
              managers if its window closes with tasks still outstanding.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={notificationsEnabled}
            aria-label="Enable checklist push notifications"
            onClick={handleToggleAlerts}
            disabled={saving}
            className={`flex-shrink-0 w-11 h-6 rounded-pill relative transition-colors disabled:opacity-60 ${
              notificationsEnabled ? "bg-olive" : "bg-card-hover border border-border-light"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-bg shadow-sm transition-transform ${
                notificationsEnabled ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>

        <p className="font-mono text-[10px] text-dim uppercase tracking-widest mt-8 mb-3">
          Missed Alert Timing
        </p>
        <div className="bg-card rounded-card border border-border p-4 space-y-4">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-body text-sm text-text">Alert managers on a missed checklist</p>
              <p className="font-mono text-[10px] text-dim mt-0.5">
                How long past a shift checklist&rsquo;s expected end time before managers get a
                heads-up that it still isn&rsquo;t done. Applies to every shift-window list
                company-wide.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={missedAlertGraceMinutes !== null}
              aria-label="Alert managers on a missed checklist"
              onClick={handleToggleMissedAlerts}
              disabled={saving}
              className={`flex-shrink-0 w-11 h-6 rounded-pill relative transition-colors disabled:opacity-60 ${
                missedAlertGraceMinutes !== null ? "bg-olive" : "bg-card-hover border border-border-light"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-bg shadow-sm transition-transform ${
                  missedAlertGraceMinutes !== null ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </div>

          <div className={missedAlertGraceMinutes === null ? "opacity-50" : ""}>
            <label className="font-mono text-[10px] text-dim block mb-1.5">Minutes past end time</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={240}
                value={graceMinutesDraft}
                onChange={(e) => setGraceMinutesDraft(e.target.value)}
                onBlur={commitGraceMinutes}
                disabled={saving || missedAlertGraceMinutes === null}
                className="w-24 bg-bg border border-border rounded-card px-3 py-2 font-mono text-sm text-text outline-none focus:border-olive disabled:opacity-60"
              />
              <span className="font-mono text-xs text-dim">minutes</span>
            </div>
          </div>

          {graceMinutesError && (
            <p className="font-mono text-[11px] text-burgundy-light">{graceMinutesError}</p>
          )}

          <div className={`flex items-center gap-3 pt-3 border-t border-border ${missedAlertGraceMinutes === null ? "opacity-50" : ""}`}>
            <div className="min-w-0 flex-1">
              <p className="font-body text-sm text-text">Include owner</p>
              <p className="font-mono text-[10px] text-dim mt-0.5">
                Whether the owner gets this escalation too, alongside managers.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={missedAlertIncludeOwner}
              aria-label="Include owner in missed checklist alerts"
              onClick={handleToggleIncludeOwner}
              disabled={saving || missedAlertGraceMinutes === null}
              className={`flex-shrink-0 w-11 h-6 rounded-pill relative transition-colors disabled:opacity-60 ${
                missedAlertIncludeOwner ? "bg-olive" : "bg-card-hover border border-border-light"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-bg shadow-sm transition-transform ${
                  missedAlertIncludeOwner ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </div>
        </div>

        {error && <p className="font-mono text-xs text-burgundy-light mt-3">{error}</p>}
      </div>
    </div>
  );
}
