# MY FOOD — Chefelisha Restaurant: pricing, promotions and product upgrade

Date: 2026-09-26 · Production: **https://bibiani-restaurant.vercel.app** (unchanged)
Release: `production-bfe4b38` · Database: the one production Supabase project, schema `20260926000100`

Each item is marked **VERIFIED** (checked by automated tests and/or in the browser on staging and
production) or **REMAINING** (not done, or done only partly — the reason is given).

Nothing about the infrastructure changed:
- no new Supabase or Vercel project, and no URL change;
- two new, additive migrations: `20260925002100_pricing_promotions` and `20260926000100_promotion_targets_pk`. No applied migration was edited;
- the layering is unchanged: domain → contracts → application → infrastructure → apps;
- every price decision is made on the server, inside the order transaction, under RLS.

## 1. Where a price comes from

```
catalogue price → live promotion (automatic) → POS → ORDER LINE SNAPSHOT → kitchen / receipt / reports
                                                        ↑
                                  manager discount (separate, permissioned, audited)
```

Each order line stores its whole price history when it is added:
- unit price;
- gross (unit price plus modifiers, × quantity);
- the promotion that applied (id, name, discount);
- its share of any manager discount;
- the net line total.

The database enforces that `net = gross − promotion − manager discount` and that discounts never
exceed gross. Kitchen screens, receipts and reports read these stored values. They never recompute
from today's menu, so **historical orders never change** when prices or promotions change.

| Item | Status |
|---|---|
| Line snapshot (gross, promotion id/name/discount, manager discount, net); existing lines backfilled with gross = net | **VERIFIED** (tests; production check: historical report gross = net) |
| A promotion that has ended does not change orders taken while it ran; new orders pay the normal price | **VERIFIED** (test "a promotion that has ended never changes historical orders"; staging e2e) |

## 2. Promotion system

**Types:**

| Type | Effect | Example |
|---|---|---|
| Percentage off | Takes a share off the price | "10% off" |
| Amount off | Takes a fixed amount off each item | "GH₵2 off each" |
| Promotional price | Sets a new price for each item | "GH₵50 each" |
| Bundle price | Sets a price for a group of items | "3 Kebabs for GH₵25" |

**Scope:**
- everything on the menu, chosen categories (including the categories inside them), or chosen products;
- optionally one branch;
- start and end dates, days of the week, and a daily time window;
- time windows may cross midnight: a 22:00–02:00 window belongs to the day it started;
- all times are restaurant local time.

**Rules (one strategy everywhere):**
- A promotion discounts the item's **normal price**. Extras and modifiers are always charged in full.
- A line never goes below zero, a percentage is at most 100%, and amounts cannot be negative. A "promotional price" above the normal price gives nothing: it never adds a surcharge.
- **Promotions never add up.** When several could apply, the **highest priority** wins, then the bigger saving, then the older promotion.
- Two active promotions with the **same priority** that cover the same items at overlapping times are **refused** when saved or turned on. The message names the clashing promotion.
- Promotions change prices only. **Recipe and stock consumption are unchanged.**

| Item | Status |
|---|---|
| Each type, bundle counting (4 items = one bundle + one at full price) | **VERIFIED** (domain tests + end-to-end test) |
| Dates, days, time windows, midnight crossing, paused, ended | **VERIFIED** (tests) |
| Refusal of impossible promotions (over 100%, negative, no targets, bad dates, half a time window) | **VERIFIED** (tests) |
| Same-priority overlap refused; higher priority wins over a bigger saving | **VERIFIED** (tests) |
| Promotion does not change recipe consumption | **VERIFIED** (test: 3 chicken on promotion still deducts 3 × recipe) |
| Only `promotions.manage` (Owner, Manager) can list, create, change, pause or end promotions | **VERIFIED** (tests; cashier gets FORBIDDEN) |
| Every create, update, pause, turn on and end is written to the audit log with before and after | **VERIFIED** (code path + audit rows in tests) |

## 3. Management → Promotions

The Promotions page has:
- tabs: Running (live or scheduled), Upcoming, Paused, Ended, All;
- per promotion: name, type, what it applies to, normal → promotional price (for single-product promotions), when it runs, status, last changed by and at;
- actions: Edit, Pause / Turn on, End (with a confirmation that explains history is kept), and Reuse for an ended promotion.

The editor is a side panel:
- sections: type, value, targets, dates, days, time window, priority, and "save paused";
- a **live preview** before saving: plain-language summary, today's status, clashes, and a normal-vs-promotional price per item;
- saving is blocked while the promotion is invalid or clashes;
- closing with unsaved edits asks for confirmation.

| Item | Status |
|---|---|
| Create, edit, pause, turn on, end, schedule; active / upcoming / ended / all views | **VERIFIED** (browser e2e `promotions.spec.ts` on staging; screenshots reviewed) |
| Preview before activation | **VERIFIED** (e2e checks normal GHS 10.00 → GHS 8.00 in the preview) |
| Edit history beyond "last changed by and at" | **REMAINING**: the full history is in the audit log, but there is no audit viewer screen yet |
| Branch picker for promotions | **REMAINING**: the model and server support a branch; the screen does not offer it yet (one branch today) |

## 4. POS

- Product buttons show a red promotion tag ("10% off", "3 for GHS 25.00"). One-item promotions also show the normal price struck through above the new price.
- Cart lines show the struck-through normal amount, the promotional amount, and the promotion name. The cart shows "buy 3 to get it" until a bundle is complete.
- Sent lines show the stored gross and net, and the promotion with its discount. The order foot shows Promotions and Discount (reason) above tax and total.
- Before sending, the cart total is labelled an estimate. The server prices the lines again when they are added.

| Item | Status |
|---|---|
| Struck-through price, promotion tag and name, applied automatically | **VERIFIED** (screenshots on staging; cart estimate GHS 65.50 = 40.50 + 25.00) |
| Bundles count items on the **same order line** | **VERIFIED** (by design). Note: taps on the same product merge into one line; items with different notes or modifiers, or added in a later round, are priced as separate lines |

## 5. Manager discounts (separate from promotions)

- They need the `discount.apply` permission: Owner, Manager and Supervisor have it; Cashier and Waiter do not.
- A discount is an amount or a percentage, with a **reason** (at least 3 characters). It can never be more than what is still unpaid.
- It is spread over the order's lines, in proportion to each line (parts add up exactly), and each line's taxes are recalculated.
- An order has **one active** manager discount. Applying again replaces it and the old one stays in history. Removing it restores the prices.
- A retry of the same request (same id) changes nothing.
- It is recorded in `order_discounts`: who applied it, when, the reason, the kind and value, the amount, and the totals before and after. It is also audited as `order.discount` / `order.discount_removed`.

| Item | Status |
|---|---|
| Permission, reason, cap, spreading, taxes, idempotency, replace, remove, audit | **VERIFIED** (test "manager discount: permissioned, reasoned…"; staging e2e: cashier 403, manager applies) |
| POS "Discount" dialog (amount or %, reason, new total before applying, remove) | **VERIFIED** (typecheck + build; button shown only with `discount.apply`) |

## 6. Kitchen

- **Kitchen screens** show, when the station shows prices (the default):
  - quantity × unit price = gross;
  - the promotion and its discount;
  - any manager discount, shown separately;
  - the net line total and the ticket total.
  - When a station hides prices, the API sends no price fields at all.
- **Printed kitchen tickets** stay **price-free**. They are production tickets for cooks and are not meant to mirror the screen. This decision is unchanged.

| Item | Status |
|---|---|
| "2 × GHS 45.00 = GHS 90.00 · Jollof Friday −GHS 9.00 · Discount −GHS 3.82", totals | **VERIFIED** (staging KDS screenshots; e2e checks `2 × GHS 10.00 = GHS 20.00` and total GHS 16.00) |
| Station hide setting kept (Settings → Kitchen, and Stations & routing) | **VERIFIED** |

## 7. Receipts

Screen, browser print and ESC/POS use one document:
- item lines show the **normal amount**;
- a "Promo: name −amount" line sits under each discounted item;
- then Subtotal (normal prices), Promotions, Discount (reason), taxes and TOTAL.

Real staging receipt #5012:
- 2 × Jollof GHS 90.00, with Promo: Jollof Friday −9.00;
- 3 × Coke GHS 30.00, with Promo: 3 Cokes for 25 −5.00;
- Subtotal 120.00 − Promotions 14.00 − Discount (Regular customer) 5.00 = **TOTAL 101.00**.

| Item | Status |
|---|---|
| Receipt lines as above; the same document on screen and printer | **VERIFIED** (tests + staging receipt) |
| Discounted receipt printed on a physical thermal printer | **REMAINING**: no printer hardware available in this session; not claimed |

## 8. Reports and dashboard

- **Reports:**
  - a "Gross to net" section: items at normal prices, automatic promotions, manager discounts, net item sales;
  - cost of goods shows **NOT RECORDED**, because order lines do not store a cost price;
  - a per-promotion table: items and amount given away;
  - best sellers show gross and net.
- **Dashboard** sections:
  - **Today:** sales, average, promotions given, manager discounts;
  - **Operations:** open, preparing, ready, awaiting payment, tables;
  - the kitchen and payments panels;
  - **Inventory:** low stock, out of stock, stock counts in progress;
  - **Promotions:** live and upcoming.

| Item | Status |
|---|---|
| Gross, promotion discounts, manager discounts, net, by promotion, cost NOT RECORDED | **VERIFIED** (staging screenshots; production demo tenant: report and dashboard return the new fields) |
| Cost of goods per sale | **REMAINING**: needs a cost snapshot on order lines (stock unit cost × recipe) in a future migration |

## 9. UI/UX pass

| Item | Status |
|---|---|
| No gradients anywhere (the last one, the loading skeleton, is now a solid pulse; reduced-motion respected) | **VERIFIED** (`grep gradient` finds only a comment) |
| Inventory statuses: In stock / Low stock / Out of stock, with a filter; stock movement trail kept | **VERIFIED** (screenshot) |
| Settings grouped: Restaurant, POS, Kitchen, Inventory, Staff, Promotions (sub-navigation, deep links `#kitchen`) | **VERIFIED** (screenshot) |
| Unsaved-change protection: Settings (tab switch and page close), promotion editor | **VERIFIED** |
| Unsaved-change protection in the menu, staff and stock forms | **REMAINING**: these side panels still close without asking |
| Staff: no Deactivate or role change for yourself ("You"); deactivation needs confirmation and clears the PIN | **VERIFIED** (screenshot; server test) |
| Phone width: tab rows scroll inside themselves; no sideways page scroll at 390 px (promotions, dashboard) | **VERIFIED** (screenshot widths 390 px) |
| Branding on every screen (logo, MY FOOD kicker, red accent) | **VERIFIED** |
| Accessibility: labelled controls, pressed states on segmented buttons, dialogs with Escape | **VERIFIED** (lint a11y rules pass). A full screen-reader audit was **not** done |

## 10. Tests and deployment

- **Unit and integration:** 155 of 155 pass. They include 14 new pricing and promotion tests and the PIN-deactivation test. The query budget is updated: the menu goes from 8 to 10 queries (live promotions and the branch time zone). Order submission stays within 46.
- **Staging browser e2e:** 16 of 16 pass (15 existing + the new `promotions.spec.ts`).
- **Production:**
  - `/health/ready` reports ready with schema `20260926000100`;
  - the environment verifier passes 15 of 15: 49 tables, RLS on every table, every table has a primary key, and browser roles have no table privileges;
  - the demo tenant has the new permissions and endpoints. The real restaurant's data was not modified.

## 11. Product photos (added 2026-09-26)

- **Adding a photo:** in **Menu & recipes → Edit product → Photo** (Add, Change, Remove). The browser shrinks the photo to 800 px WebP before uploading, so a phone photo of several MB becomes about 50–150 KB.
- **Where it shows:**
  - a thumbnail in the product list;
  - large photo buttons on the POS, which turn on once any product has a photo. A menu without photos keeps the compact buttons, and products without a photo show their first letter.
- **Storage:** Supabase Storage in the **same** production project, bucket `product-images` (public read). Only the API writes to it, using the server-side key. Browser sign-ins cannot upload, delete or list; row-level security refuses them.
- **Checks on every upload:**
  - it needs the `menu.manage` permission;
  - it must be a real JPEG, PNG or WebP (checked from the file's bytes, not its name or declared type), at most 2 MB;
  - the database only accepts photo paths in the expected shape.
- **Audit:** every change is logged (`product.image` / `product.image_removed`).
- **Replacing a photo:** the old file is deleted. Photos are cached for up to one day, so a removed photo can stay reachable through the CDN for that long.

| Item | Status |
|---|---|
| Upload, preview, change, remove; POS and list display | **VERIFIED** (5 new tests; browser check on staging with screenshots) |
| Security: cashier refused (403), fake image (SVG) refused, browser cannot write, delete or list the bucket | **VERIFIED** (staging and production) |
| Production cycle on the demo restaurant: upload → public read (identical bytes) → remove (bucket empty afterwards) | **VERIFIED**; no photo was left on the demo or the real restaurant |
| Real dish photos | **REMAINING**: the restaurant needs to take and add its own photos. None were invented or copied from elsewhere |

## 12. Latest verified state (2026-09-26, release `production-6fea1a9`)

This pass focused on the restaurant experience as a whole. The full details and every VERIFIED / REMAINING item are in [MY-FOOD-FINAL-PRODUCT-QA.md](MY-FOOD-FINAL-PRODUCT-QA.md).

| Change | Status |
|---|---|
| **Printed kitchen tickets now show prices** (quantity × unit price, promotion, line total, ticket total) whenever the station shows prices (the default), matching the kitchen screen. This replaces the earlier "printed tickets stay price-free" decision, as now requested | **VERIFIED** (tests; physical printer **REMAINING**) |
| Receipt shows the unit price on every line | **VERIFIED** |
| Product description, and a sectioned product editor (basic information, price & availability, photo with guidance and states, recipe, kitchen with route preview) | **VERIFIED** |
| POS buttons: category, readable price under the photo, promotion tag, Sold out (not sellable) versus ingredient low or out (warning only) | **VERIFIED** |
| Activity page: plain-language audit history for owners and managers | **VERIFIED** |
| Dashboard recent stock changes; supervisor order total; "Kitchen is clear"; staff search | **VERIFIED** |
| Stock-count fix: a reason typed just before Submit is no longer lost | **VERIFIED** |
| Tests | **169 / 169** automated tests; **16 / 16** staging browser tests |
