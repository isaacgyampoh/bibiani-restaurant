# MY FOOD — Chefelisha Restaurant: final product QA

Date: 2026-09-26 · Production: **https://bibiani-restaurant.vercel.app** (unchanged)
Release: `production-51fa726` (reviewed as `6fea1a9`; the later release only changes the reduced-motion styles) · Database: the one production Supabase project, schema `20260926000300`
Related: [MY-FOOD-ADVANCED-PRODUCT-REVIEW.md](MY-FOOD-ADVANCED-PRODUCT-REVIEW.md) (pricing, promotions, photos) · [MY-FOOD-PRODUCT-FINAL-QA.md](MY-FOOD-PRODUCT-FINAL-QA.md) (previous pass)

Each item is marked:
- **VERIFIED** — checked by automated tests and/or by looking at the running app;
- **REMAINING** — not done, or only partly done; the reason is given.

"Staging" is the separate test deployment. On **production**, only the demo restaurant ("Chefelisha Restaurant — Demo") was used, and only **read-only**: no orders, payments, photos or device pairing were created there in this pass. Real restaurant data was not touched.

Constraints kept:
- same production URL;
- no new Supabase or Vercel project;
- no applied migration edited: this pass adds one new migration, `…000300_product_description`;
- architecture unchanged (domain → application → infrastructure → apps; server-side permissions; row-level security);
- no secrets in the repository or in this document.

---

## 1. Audit first: what was found

Every screen was opened on staging at desktop (1366 px), POS (1280 px), tablet (1024 px) and phone (390 px) sizes before anything was changed.

| Area | Finding | Result |
|---|---|---|
| Kitchen tickets | Screens showed prices; **printed** tickets did not | Printed tickets now carry prices too (see §4) |
| Menu editor | One long pop-up: no description, availability, recipe or photo guidance in one place | Rebuilt as a sectioned side panel (§3) |
| POS buttons | No category; "sold out" was not told apart from low ingredients; a photo could push the price out of view | Redesigned (§2) |
| Audit history | Recorded for every important action, but **no screen** to read it | New **Activity** page (§8) |
| Stock taking | **Bug:** a reason typed just before tapping Submit could be lost (its save was still in flight). Approve then stayed disabled. Found because the full browser suite failed twice at the same step | Fixed (§6) |
| Dashboard | No recent stock changes | Added (§7) |
| Supervisor | No order total | Added (§5) |
| Receipt | Unit price only when the quantity was more than 1 | Unit price on every line (§5) |
| Staff | No search | Added |
| Styles | No gradients; 3 small shadows; 3 purposeful animations. Four near-identical greys hard-coded in 20 places | One grey token; "reduce motion" respected everywhere |
| Touch targets | POS order tools and quantity buttons were 32–36 px | Now 40–44 px |
| Phone | Activity table unreadable at 390 px; drawer sections squeezed | Stacked layouts |

Kept as they were, because they already worked well:
- sign-in and PIN sign-in;
- the customer display (NOW PREPARING / READY FOR COLLECTION, branded, no internal information);
- payments;
- promotions and manager discounts (last pass);
- the photo system (behaviour unchanged; only its editor states were improved).

## 2. POS

| Item | Status |
|---|---|
| Buttons show photo (when there is one), name, category, price, promotional price and tag | **VERIFIED** (staging screenshots at 1280 and 1024 px; production demo) |
| Price stays readable under the photo on one line; photos are never distorted (16:10, cropped to fill) | **VERIFIED** |
| Products without a photo show a quiet tile with their first letter; a menu with no photos keeps compact buttons | **VERIFIED** |
| **Sold out** (set by staff): shown on the button, cannot be added, and the server refuses it (`PRODUCT_UNAVAILABLE`) | **VERIFIED** (test + screenshot) |
| **Ingredient low / Ingredient out** (from the recipe and stock): a warning on the button with the ingredient names; it never blocks a sale | **VERIFIED** (test: still sellable when an ingredient is out; production demo shows Beef and Malt low) |
| Product description shown in the options dialog | **VERIFIED** |
| Touch targets 40–44 px or more for order tools and quantity; visible keyboard focus on product buttons | **VERIFIED** |
| Photos load lazily and are cached for a day. The POS downloads the 800 px photo for small buttons | **REMAINING** (improvement): store a small thumbnail as well, for very large menus on slow Wi-Fi |

## 3. Menu management (product editor)

The editor is a side panel with five sections:
1. **Basic information:** name, description (up to 300 characters), category.
2. **Price & availability:** selling price; On sale / Sold out; which promotions affect the product, with a link to Promotions.
3. **Photo:** add, change or remove, with tips for a good photo. The status is shown clearly: preparing, uploading, saved, replaced, removed, or a plain-language error (not a JPEG, PNG or WebP photo; over 25 MB before resizing; any server refusal).
4. **Recipe:** ingredients, quantity per portion and units.
5. **Kitchen:** name on kitchen tickets, a live "Goes to Main Kitchen (category …, printer …, screen …)" preview using the same routing as the server, options, tax, and on the menu or hidden.

It asks before discarding unsaved changes. If a later step fails, it says the product was saved but not everything was, and retrying does not create a duplicate.

| Item | Status |
|---|---|
| Sections, description, availability, promotions list, recipe, kitchen, route preview | **VERIFIED** (staging screenshots; production demo opened read-only) |
| Description saved and shown on the POS | **VERIFIED** (test) |
| Photo states and client-side checks | **VERIFIED** (code and build; the upload path was already tested) |

## 4. Kitchen

| Item | Status |
|---|---|
| **Kitchen screens:** quantity × unit price = gross, the promotion, any manager discount shown separately, the actual line price, and the ticket total | **VERIFIED** (staging: "1 × GHS 60.00 = GHS 60.00 · Lunch Promotion −GHS 10.00", line GHS 50.00, Total GHS 50.00) |
| **Printed kitchen tickets** now show the same prices when the station shows prices (the default) | **VERIFIED** (document test + test through the real send path); example below |
| A station can still hide prices; then the screen and printed ticket show none | **VERIFIED** (test) |
| Empty kitchen: "Kitchen is clear — No active orders are waiting" | **VERIFIED** |
| A manager discount given **after** a ticket was printed is not on that paper ticket (the screen shows it) | **REMAINING** by design: tickets print when the order is sent |
| Printed ticket on a physical thermal printer | **REMAINING**: no printer hardware available; not claimed |

Printed kitchen ticket with prices (from the test):

```
1 x YAM
   1 x GHS 50.00                 GHS 50.00
3 x KEBAB
   3 x GHS 10.00                 GHS 30.00
   Lunch Promotion              -GHS 6.00
   Line total                    GHS 24.00
------------------------------------------
TOTAL                            GHS 74.00
```

## 5. Supervisor, customer display, payments and receipts

| Item | Status |
|---|---|
| **Supervisor:** in kitchen, ready, late and rush counts; each order shows which station is holding it, "Waiting on …", per-station Ready, **order total** and amount due or Paid, and hand-over | **VERIFIED** (staging; production demo) |
| **Customer display:** branded, large, NOW PREPARING and READY FOR COLLECTION, order numbers only | **VERIFIED** (staging; unchanged) |
| **Receipt:** logo, restaurant name, order, date and time, order type, cashier; each line with quantity, unit price and line total; promotions, manager discount with reason, subtotal, taxes, total; payment method, cash received, change; footer. Same document on screen, browser print and thermal printer | **VERIFIED** (staging receipt #5012: 170.00 − 10.00 = TOTAL 160.00, CASH 160.00, received 200.00, change 40.00) |

## 6. Inventory

| Item | Status |
|---|---|
| A confirmed sale deducts each recipe quantity, with an auditable movement per ingredient ("Sold · Order #…") | **VERIFIED** (tests; staging dashboard) |
| Retries never deduct twice; a cancellation returns stock once, as a new compensating movement (the original stays) | **VERIFIED** (tests) |
| Promotions and discounts never change recipe consumption | **VERIFIED** (test) |
| Statuses: In stock / Low stock / Out of stock | **VERIFIED** |
| **Stock count fix:** Submit waits for, and completes, any quantity or reason still being saved | **VERIFIED**: the full browser suite passes (16/16) where it failed twice before |

## 7. Dashboard

The dashboard is organised as:
- **Today:** sales, average order, promotions given, manager discounts.
- **Live operations:** open, preparing, ready, awaiting payment, tables.
- **Kitchen:** stations with oldest and late tickets.
- **Payments:** by method.
- **Inventory:** low stock, out of stock, stock counts in progress, and the latest six stock changes.
- **Promotions:** live and upcoming.
- **Recent orders.**

| Item | Status |
|---|---|
| All sections, including recent stock changes | **VERIFIED** (staging; production demo returns 6 recent changes) |

## 8. Activity (audit history) — new

**Management → Activity** shows who changed what and when, in plain words. For example:
- "Changed product · Jollof Rice · Price GHS 45.00 → GHS 50.00"
- "Manager discount · #5008 · GHS 1.00 · Reason: Regular customer"
- "Assigned a starting PIN · Kofi"

Filters: menu and prices, promotions, payments and discounts, orders, stock, staff and PINs, setup. There is a search box and older entries load in pages. The log is read-only and permanent.

| Item | Status |
|---|---|
| Recorded and shown: price changes, menu and photo changes, recipes, promotions, discounts, payments, cancellations and voids, stock movements and counts, staff changes, PIN assignments, activation, changes, recovery requests, PIN sign-ins and lockouts, devices | **VERIFIED** (4 tests; staging and production screenshots) |
| Only owners and managers (`audit.view`) can see it; cashiers are refused (403) | **VERIFIED** (test) |
| Never shows a PIN, PIN digest or password: none are recorded, and fields with secret-looking names are removed before sending | **VERIFIED** (test; production check) |
| Export (CSV or print) | **REMAINING** |

## 9. Staff, PINs and permissions

| Item | Status |
|---|---|
| Daily sign-in with a PIN on a registered till; email and password only for managers and owners | **VERIFIED** (staging browser test `pin.spec.ts`) |
| Unique among active staff; "This PIN is already in use" without saying whose; stored only as a keyed digest; never returned or logged | **VERIFIED** (tests) |
| Recovery through the registered email; a new PIN replaces the old one; every step audited | **VERIFIED** (tests; visible in Activity) |
| Screens adapt to the role (cashier → POS and orders; kitchen → kitchen screen; supervisor → operations; inventory → stock; owner and manager → management). The server checks every action | **VERIFIED** |
| Staff search by name or email; nobody can deactivate or change their own access | **VERIFIED** |
| Per-person permissions: people get permissions through roles only | **REMAINING** by design |

## 10. Pricing, promotions and reporting (unchanged, re-checked)

There is one pricing truth:

**product → price or promotion → POS → order price snapshot → kitchen → receipt → reports**

Historical orders are never recalculated.

| Item | Status |
|---|---|
| Snapshot, promotions (percentage, fixed amount, promotional price, bundle; dates, days, times; product or category; no negatives; ≤100%; no stacking; conflicts refused; owner, status, schedule, targets, audit) | **VERIFIED** (15 pricing tests; staging browser test `promotions.spec.ts`) |
| "Buy X get Y free" as its own promotion type | **REMAINING** (a bundle price covers most uses) |
| Reports: gross, automatic promotions, manager discounts, net, payment methods, order count; cost of goods shows NOT RECORDED rather than an invented figure | **VERIFIED** |
| Cost of goods and profit | **REMAINING**: order lines do not record a cost price yet |

## 11. Photos

| Item | Status |
|---|---|
| Resizing in the browser, JPEG/PNG/WebP only, 2 MB limit, server-side writes, permissions, audit, replace and remove, existing storage, 1-day cache | **VERIFIED** (unchanged; 5 tests) |
| Menu → list thumbnail → POS button → order price → kitchen price → receipt, as one connected flow | **VERIFIED** (staging) |
| Real dish photos | **REMAINING**: the restaurant adds its own; none were invented. Staging used the logo as a stand-in |

## 12. Design, branding, accessibility and performance

| Item | Status |
|---|---|
| One visual language: tokens for colour, radius, height and shadow; one fill grey; no gradients; 3 small shadows; brand red used for actions, promotions and the header line only | **VERIFIED** (stylesheet audit) |
| MY FOOD / Chefelisha branding on every screen: sign-in, PIN, back office, POS, kitchen, supervisor, customer display, receipts, empty states | **VERIFIED** |
| Responsive: desktop, POS 1280, tablet 1024 (three dishes per row), phone 390 (no sideways scrolling on Activity or Promotions) | **VERIFIED** (screenshots) |
| "Reduce motion" respected; labelled controls; visible focus; accessibility lint rules pass | **VERIFIED** |
| Formal contrast measurement and a full screen-reader audit | **REMAINING** |
| Speed: the POS menu stays within its database query limit (the stock warning is part of the same query); lazy-loaded photos; order submission still within 46 queries | **VERIFIED** (query-budget test) |

## 13. Tests and verification

| Check | Result |
|---|---|
| Typecheck, lint (including accessibility rules), build | Pass |
| Unit and integration tests (real migrations on Postgres) | **169 / 169** (was 160): +1 printed-ticket document, +1 printed ticket through the send path, +3 menu availability, +4 Activity |
| Staging browser tests (full suite) | **16 / 16** |
| Staging manual review of all 19 screens plus Activity, including device screens (POS PIN, kitchen, customer display) | Done; issues found were fixed and re-checked |
| Production | `/health/ready` ready (schema `…000300`); read-only browser pass as the demo restaurant (dashboard, menu, product editor, promotions, orders, supervisor, stock, stock taking, staff, reports, settings, Activity, POS); read-only API checks |
| Production kitchen and customer display screens | **REMAINING** in this pass: not paired on production, to avoid re-registering real devices. Verified on staging |

## 14. Remaining limitations (summary)

1. Physical thermal printing of the new priced kitchen tickets and receipts was not tested (no hardware).
2. Cost of goods and profit are not recorded.
3. The POS downloads full-size (800 px) photos for small buttons; a thumbnail size would help very large menus.
4. Activity has no export.
5. No "buy X get Y free" promotion type.
6. Formal contrast and screen-reader audit not done.
7. Permissions come through roles only (no per-person overrides).
8. A manager discount given after a ticket has printed appears on screens and the receipt, not on that paper ticket.
9. Real dish photos are still to be added by the restaurant.

## 15. Visual refresh (2026-09-26, after owner feedback: "still looks gradient, looks AI generated")

**Cause found:** the stylesheet had no gradients. The "gradient" look came from the supplied logo image: a scanned raster with a soft grey drop-shadow ring and pinkish anti-aliasing, shown small in many places and faded to 35% in empty states. The dark bars with red rules and the letter-spaced "MY FOOD" labels added to the generic look.

**Changes**, following the owner's reference (flat, solid-colour sidebar, white cards, photo-first POS):
- **Flat logo:** brand red and ink on white, no shadow ring, crisp at every size. Generated by `scripts/brand/make-flat-logo.py`; the original is kept as `logo-original-512.png`. The printed receipt logo is unchanged.
- **One solid brand surface:** the sidebar (#C81C23, one step deeper than the brand red so white text passes contrast), with a white pill for the current page. No other red areas; red is kept for actions and promotions.
- **Cards:** white, 14 px corners, hairline border, a barely visible shadow. Dashboard figures are separate cards with a line icon in a soft circle, under a "Welcome back, …" greeting.
- **POS:** a light top bar, area tabs and categories as pills, and white product cards with the photo inset, name, category, price and a round "+". Cart lines have a dish thumbnail. One solid "Send to kitchen" / payment button. Floor tables show a status pill instead of a coloured top rule.
- **Removed:** the red top rule on the back office, the red rules under dark bars, faded logos, letter-spaced brand labels, and the tinted fill on unsent cart lines.

| Item | Status |
|---|---|
| No gradients, no drop-shadow logo, no decorative lines | **VERIFIED** (stylesheet audit; staging screenshots of sign-in, dashboard, menu, promotions, POS, kitchen) |
| Tests after the refresh | **VERIFIED**: 169/169 automated; 16/16 staging browser tests (two updated for the new "Welcome back" heading) |

## 16. No emoji; brand on every screen (2026-09-26, after owner feedback)

- **No emoji or symbol characters as icons anywhere.** The dashboard's coloured icon circles were removed; the figures stand on their own. All 35 uses of symbol characters (arrows, check mark, cross, external-link mark, menu mark, delete key) were replaced:
  - where they worked as controls, by one small set of thin line icons (`ui/icons.tsx`);
  - where they sat inside a sentence, by words ("Price GHS 45.00 to GHS 50.00").

  A scan of the web app finds no emoji or symbol-block characters left.
- **Every screen carries one solid brand surface** with the white logo disc:

| Screen | Brand surface |
|---|---|
| Sign-in, staff PIN, device setup, set password, PIN activation, POS "no branch" or "error" states | A brand panel (logo, Chefelisha Restaurant, "Food is better than love") beside the form. On phones it becomes a brand band on top |
| App loading | Full brand splash |
| Back office (every page) | Solid brand sidebar |
| POS | Solid brand top bar; the current area is a white pill |
| Kitchen screens, supervisor | Solid brand top bar over the dark working area |
| Customer display | Solid brand header with the slogan |
| Receipts | Logo and name (unchanged) |

| Item | Status |
|---|---|
| No emoji or symbol icons; brand surface on every screen | **VERIFIED** (code scan; staging screenshots of sign-in, PIN, dashboard, POS, kitchen, supervisor, customer display) |
| Tests | **VERIFIED**: 169/169 automated; 16/16 staging browser tests (one updated: the route arrow is now an icon) |
