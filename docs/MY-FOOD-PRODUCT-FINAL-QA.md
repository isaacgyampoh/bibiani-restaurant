# MY FOOD — Chefelisha Restaurant: final product quality pass

Date: 2026-09-26 · Production: **https://bibiani-restaurant.vercel.app** (unchanged)
Release: `production-bfe4b38` · Schema `20260926000100` · Companion document: [MY-FOOD-ADVANCED-PRODUCT-REVIEW.md](MY-FOOD-ADVANCED-PRODUCT-REVIEW.md)

Constraints respected:
- no infrastructure changes;
- no new Supabase or Vercel project;
- no URL change;
- no applied migration edited;
- no audit history deleted;
- no credentials, PINs or passwords in this repository or in this document.

## 1. Audit first: state before this pass

| Area | Before | Now |
|---|---|---|
| Kitchen prices | COMPLETE (line total only) | COMPLETE: quantity × unit price, promotion, manager discount, net, ticket total |
| Promotions | MISSING | COMPLETE (see companion document) |
| Manager discounts | MISSING (receipt had a `discountTotal` always 0) | COMPLETE: permissioned, reasoned, audited |
| Reports: gross / discount / net / cost | PARTIAL (net only) | COMPLETE; cost shows NOT RECORDED (not stored) |
| Staff page for the signed-in person | **BROKEN**: "Deactivate" was offered for yourself (the server refused it), and editing your own name failed because the form always sent your role | COMPLETE: shows "You", your role is read-only, the name edit works |
| PIN uniqueness after deactivation | PARTIAL: a deactivated person kept their PIN, blocking reuse | COMPLETE: deactivation clears the PIN |
| Loading skeleton | PARTIAL: the last gradient in the product | COMPLETE: solid pulse |
| Settings | PARTIAL: one form, no grouping | COMPLETE: Restaurant, POS, Kitchen, Inventory, Staff, Promotions |
| Inventory status wording | PARTIAL: "low" only | COMPLETE: In stock / Low stock / Out of stock |
| Environment verifier | **BROKEN**: expected 40 tables (stale) | COMPLETE: 49 tables, primary key on every table |
| Phone layout of tab rows | **BROKEN**: five tabs widened the page at 390 px | COMPLETE: tab rows scroll inside themselves |

Problems found **during this pass's own QA** and fixed before sign-off:
- **Kitchen screen:** the manager discount was shown under the promotion's name. The two are now shown separately.
- **POS:** the bundle estimate showed GHS 24.99 instead of 25.00 because of per-unit rounding. It now uses the exact saving.
- **Database:** `promotion_targets` had no primary key. A new migration adds one.
- **POS product cards:** the promo price wrapped awkwardly.

## 2. Staff PINs

| Requirement | How | Status |
|---|---|---|
| Unique among active staff | Unique digest per restaurant; deactivation clears the PIN | **VERIFIED** (test: PIN in use → refused; after deactivation → reusable) |
| No enumeration | Duplicate: "This PIN is already in use", without saying whose. Wrong PIN: "PIN not recognised". Recovery gives the same answer for any email | **VERIFIED** (tests) |
| Never stored raw | HMAC-SHA256 with a server-only secret, keyed per restaurant. Never returned, logged, put in URLs or local storage, or written to audit | **VERIFIED** (test checks the stored digest and that the configuration API never contains it) |
| PIN sign-in screen | On a paired till only | **VERIFIED** (staging e2e `pin.spec.ts`) |
| Brute-force protection | Lockout: 5 failures per till in 10 minutes; 30 per restaurant | **VERIFIED** (test "repeated wrong PINs lock the till…") |
| Activation | Assigned starting PIN → person chooses their own; the old PIN stops working | **VERIFIED** (test + staging e2e) |
| Email recovery | Link to a registered staff address only | **VERIFIED** (test) |
| Owner security retained | PIN sessions cannot manage staff, devices or settings; those need email + password | **VERIFIED** (tests; production PIN flow checked 2026-09-25) |

## 3. Inventory flow

| Requirement | Status |
|---|---|
| Stock deducted once when the order is sent to the kitchen; retries do not deduct again | **VERIFIED** (test) |
| Cancellation returns stock exactly once; the database refuses a second reversal | **VERIFIED** (test + unique index) |
| Promotions and discounts never change recipe consumption | **VERIFIED** (test) |
| Movement trail: delivery, wastage, stock count, sale, sale reversal, with who and why | **VERIFIED** (staging screenshot) |

## 4. Kitchen and printing

| Requirement | Status |
|---|---|
| Kitchen screens keep prices (on by default), now with the full calculation | **VERIFIED** |
| Station setting to hide prices (the API then sends none) | **VERIFIED** |
| **Printed kitchen tickets stay price-free.** Decision after inspecting the design: printed tickets are production tickets for cooks, not a mirror of the screen | **VERIFIED** (ticket document unchanged; no price fields) |
| Physical printer test of this release | **REMAINING**: no hardware available; not claimed |

## 5. Receipts

| Requirement | Status |
|---|---|
| Fully branded: logo, restaurant name, address, phone, order, cashier, footer | **VERIFIED** |
| Promotions and manager discounts shown in one consistent way (see companion document §7) | **VERIFIED** (staging receipt adds up: 120.00 − 14.00 − 5.00 = 101.00) |

## 6. Screen-by-screen UX review (staging, owner, 1366 px and 390 px)

| Screen | Result |
|---|---|
| Sign-in | Branded, no gradient; unchanged this pass |
| Dashboard | Sections Today / Operations / Inventory / Promotions; fits a phone |
| POS floor and order | Promo tags, struck-through prices, bundle hint, Discount dialog (with permission only) |
| Kitchen (paired KITCHEN-01, DRINKS-01) | Full price detail, discounts separate, late tickets stand out |
| Orders | Unchanged; shows the new totals from the server |
| Stock | Status badges, low/out counts, movement trail |
| Promotions | List, editor with live preview, end confirmation; fits a phone |
| Staff | "You" for the signed-in owner; deactivate needs confirmation |
| Reports | Gross to net, per promotion, cost NOT RECORDED |
| Settings | Six groups; unsaved-change warning |
| Supervisor, Customer display | Behaviour covered by staging e2e (4/4 READY, live display); not re-screenshotted this pass |

## 7. Real restaurant and demo data

Chefelisha Restaurant and "Chefelisha Restaurant — Demo" are separate restaurants in the one production project. Row-level security isolates them.

In production this pass:
- the demo owner sees only the demo restaurant;
- the demo owner's promotions list is empty;
- the demo owner's reports cover only demo orders.

No real-restaurant data was created or changed by testing. All test orders and promotions in this pass were made on **staging**.

**Status: VERIFIED** (tenant isolation tests; production smoke test as the demo owner, read-only).

## 8. Tests

| Suite | Result |
|---|---|
| Typecheck, lint (Biome, including a11y rules), build | Pass |
| Unit + integration (PGlite, real migrations) | **155 / 155** |
| Staging browser e2e | **16 / 16** (includes the new promotions spec) |
| Production readiness `/health/ready` | ready, schema `20260926000100` |
| Production environment verifier | **15 / 15** checks |

## 9. Remaining (not done in this pass)

1. **Cost of goods per sale:** needs a cost snapshot on order lines. Reports show NOT RECORDED until then.
2. **Audit viewer:** promotion and discount history is in the audit log but has no screen.
3. **Branch picker for promotions:** supported by the server; not offered in the screen (one branch today).
4. **Unsaved-change warning** in the menu, staff and stock side panels.
5. **Physical printer test** of discounted receipts: hardware not available.
6. **Full screen-reader accessibility audit.**
