import { Schema, Document, model, models } from "mongoose";

// Stubbed for v1 — no billing is wired up yet (no Stripe calls, no checkout,
// no webhook handlers), but every tenant will need this once we start
// charging, so the shape exists ahead of that work. Every company defaults
// to "trialing" / "free" on creation; nothing currently moves a company out
// of that default.
export interface ICompanySubscription {
  status: "trialing" | "active" | "past_due" | "canceled" | "none";
  tier: "free" | "starter" | "pro";
  stripeCustomerId: string | null; // "cus_..." — set once they exist in Stripe, even pre-payment
  stripeSubscriptionId: string | null; // "sub_..." — set once they actually subscribe
  trialEndsAt: Date | null;
  seatLimit: number | null; // for later per-seat pricing
  currentPeriodEnd: Date | null; // avoids hitting the Stripe API just to show "renews on X"
}

// Top-level tenant record. Deliberately generic — a restaurant, gym, hotel,
// or any other location-based service business is just a Company with its
// own users, shift groups, tasks, and check history. Nothing here (or in
// code that touches it) should be restaurant-specific.
export interface ICompany extends Document {
  companyName: string;
  // Stubbed for v1 — no UI or logic reads this yet, but every tenant will
  // eventually need it, so the field exists ahead of that work.
  industry: string | null;
  // IANA zone name ("America/Chicago"), not a raw UTC offset — DST is
  // handled for free by any zone-aware date computation. No longer stubbed
  // as of the missed-shift-list alert sweep (see
  // docs/features/notifications.md), which needs to know "has this
  // company's shift window closed?" independent of any browser's own
  // offset. Best-effort default at signup from the creating user's browser
  // (Intl.DateTimeFormat().resolvedOptions().timeZone), editable afterward
  // from Company Settings. Pre-existing companies are backfilled by a
  // one-off script (see docs/features/notifications.md) rather than left
  // null, since a null zone here means the sweep can't evaluate that
  // company's lists at all.
  timezone: string | null;
  notificationPreferences: Record<string, unknown>;
  // Which chirp plays on a device that just completed a task via the NFC
  // scan-to-complete binding's "Scan NFC to Save" step (see
  // docs/features/nfc.md) — a real, company-wide preference, not part of
  // the still-unused notificationPreferences bag above.
  notificationSound: "standard" | "male";
  // Company-wide kill switch for missed-shift-list push alerts (see
  // docs/features/notifications.md) — no per-manager mute in v1, so if a
  // company doesn't want these at all, they turn this off entirely.
  notificationsEnabled: boolean;
  // Minutes past a shift-window list's derived end time before the
  // missed-list sweep (`app/api/cron/check-missed-lists`) will alert
  // managers that it's still not done — see docs/features/notifications.md's
  // "Missed-list alerts". Manager-editable from Company Settings, one value
  // for every shift-window list company-wide (not per-list). `null` means
  // missed alerts are turned off entirely for this company — distinct from
  // `notificationsEnabled` above, which is the broader kill switch covering
  // BOTH alert types. `undefined` (a company document that predates this
  // field) is treated as the original flat 30-minute default everywhere
  // this is read, not as "off" — see `DEFAULT_MISSED_LIST_GRACE_MINUTES` in
  // `lib/task-list-window.ts`.
  missedAlertGraceMinutes: number | null;
  // Whether the missed-list sweep's push includes the owner alongside
  // managers — see docs/features/notification-job-tag-targeting.md.
  // Defaults `true` so every existing company keeps today's behavior
  // without a migration. Missed-list alerts stay role-based regardless
  // (unaffected by job-tag targeting, which only narrows start-time
  // reminders) — this is a narrower, separate on/off switch for just the
  // owner's own membership in that role-based audience.
  missedAlertIncludeOwner: boolean;
  subscription: ICompanySubscription;
}

const CompanySubscriptionSchema = new Schema<ICompanySubscription>(
  {
    status: {
      type: String,
      enum: ["trialing", "active", "past_due", "canceled", "none"],
      default: "trialing",
    },
    tier: { type: String, enum: ["free", "starter", "pro"], default: "free" },
    stripeCustomerId: { type: String, default: null },
    stripeSubscriptionId: { type: String, default: null },
    trialEndsAt: { type: Date, default: null },
    seatLimit: { type: Number, default: null },
    currentPeriodEnd: { type: Date, default: null },
  },
  { _id: false }
);

const CompanySchema = new Schema<ICompany>(
  {
    companyName: { type: String, required: true },
    industry: { type: String, default: null },
    timezone: { type: String, default: null },
    notificationPreferences: { type: Schema.Types.Mixed, default: {} },
    notificationSound: { type: String, enum: ["standard", "male"], default: "standard" },
    notificationsEnabled: { type: Boolean, default: true },
    missedAlertGraceMinutes: { type: Number, default: 30 },
    missedAlertIncludeOwner: { type: Boolean, default: true },
    subscription: { type: CompanySubscriptionSchema, default: () => ({}) },
  },
  { timestamps: true }
);

export default models.Company || model<ICompany>("Company", CompanySchema);
