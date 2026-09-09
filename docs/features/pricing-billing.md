> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Pricing & Billing

**STATUS: NOT BUILT — spec only.** `Company.subscription` (tier, status, stripeCustomerId) is already schema-stubbed, but no Stripe integration, pricing page, or tier-gating logic exists yet. This document defines the pricing model to build against.

**Depends on:** Stripe billing integration (not yet built — estimated 2–3 days for a working happy path per prior scoping). Blocks: any tier-gated feature access, the public pricing page, the signup → paywall flow, NFC hardware kit checkout.

## Model

Per-location monthly subscription, billed to the company (not per-user). Per-location pricing was chosen deliberately over per-seat: restaurant staff counts fluctuate constantly, and per-seat pricing punishes a customer for hiring or creates a billing conversation on every turnover event. Per-location stays predictable as a customer's headcount changes and matches how owners/GMs actually budget (per-restaurant, not per-employee).

Annual billing should be offered at a discount (~15–20% off monthly) from day one — standard in this category and helps cash flow as a bootstrapped, pre-revenue business.

## Tiers

### Starter — ~$79–99/mo per location

- Core task verification (NFC-tap checklists)
- Basic reports
- Mobile app access

Positioning: priced slightly under Jolt's full bundle to win first customers pre-case-study. This is the tier to launch Stripe against first.

### Pro — ~$149–179/mo per location

- Everything in Starter
- Inventory management
- Admin Console / Reports v2 suite
- Notifications (missed-list alerts, start-time reminders)
- Time clock (once shipped)

Positioning: priced alongside Jolt's mid-tier. Competing here on the NFC audit-trail/location-lock differentiator (Jolt is self-reported), not on price — do not discount this tier to undercut Jolt, that undersells the core sales pitch.

### Multi-location / Enterprise — custom, volume discount

- Per-location rate steps down at higher location counts (matches Jolt and category norms for franchise-group deals).
- Not built out now — leave room in the tier-gating logic for a "custom" plan type that isn't hardcoded to a fixed price point.

## NFC hardware kit — separate line item

One-time onboarding fee per location, charged separately from the subscription — do not fold tag cost into the recurring price.

- Flat kit price: ~$49–99 per location (not a per-tag SKU menu — keep checkout simple).
- At real order volumes (25+ units), on-metal vs. off-metal cost delta narrows enough that a single flat kit price is viable; no need to differentiate SKUs by tag type at this stage.

## Open questions — not yet decided

- **Exact price points within the ranges above are not final.** These are starting anchors for early sales conversations, not a locked price sheet. Do not hardcode a single number as gospel — structure the Stripe Price objects/tier config so numbers can be adjusted without a code change (e.g. driven by a config value or Stripe Product/Price lookup, not a literal constant).
- Whether the multi-location custom tier is self-serve (a location-count slider with a formula) or purely sales-assisted (manual quote, Stripe invoice) is undecided.
- Whether the NFC kit fee is charged at signup (before first login) or after onboarding is undecided — depends on the NFC tag delivery model, which is also still open (physical kit at signup vs. ongoing reorder — see `nfc.md` provisioning notes).
- Trial period length/structure (if any) is undecided.
- Downgrade/cancellation behavior (what happens to historical `TaskLog`/`InventoryLog` data, whether NFC tags stay functional) is undecided — likely follows the same "retain operational logs" principle as the account-deletion spec, but not confirmed.

## Depends on / interacts with

- `Company.subscription` schema (already stubbed: tier, status, stripeCustomerId).
- Stripe billing integration (not yet built).
- Admin Console, Reports v2, Notifications, Time Clock — all referenced as Pro-tier gates above; each has its own spec and none are tier-gated today.
- NFC tag provisioning/delivery model (`nfc.md`) — affects when/how the hardware kit fee is charged.
