# MY FOOD — Chefelisha Restaurant: product redesign (final report)

Date: 2026-09-25 · Production: **https://bibiani-restaurant.vercel.app** (unchanged, as required)
Release: `production-55011a1` · Database: the one production Supabase project, schema `20260925001900`

This pass did not change the architecture. The layers stay the same:

**domain → contracts → application → infrastructure → apps**

- Business rules stayed in the domain and application layers: PIN rules, stock reversal, transfer and merge, rush.
- The UI calls use cases through the API only.
- Row-level security, transactions, idempotency and audit logging are unchanged.
- There are two new migrations: `…001800` and `…001900`. No existing migration was edited.

## Phase 1 audit: what was wrong

| Area | Finding before this pass |
|---|---|
| Visual language | Several stylesheet generations (about 1,700 lines of CSS). Dark-green brand leftovers, coloured stat cards, rounded "cards everywhere", a dark sidebar. |
| Status wording | Raw enum values on screen (`partially_ready`, `picked_up`, `never_seen`). |
| POS | Worked, but looked like a web form. Categories as pills, the cart without hierarchy. No rush, move, merge or split-by-items. |
| KDS | Readable but plain. No rush, no station switcher, no hour formatting. |
| Customer display | Functional but unbranded and staff-looking. |
| Staff | Email plus password only. No PINs. Admins created passwords for staff. |
| Inventory | Sales deducted stock, but cancellations never returned it. |
| Receipts | Plain text. No logo, phone or unit prices. On-screen view was a `<pre>`. |
| Branding | Logo only partly applied. Title "Restaurant". No manifest. |

## 1. UX/UI changes

- **Screens are separated by purpose:**
  - the back office has a light sidebar and pages;
  - operational screens (POS, Kitchen, Supervisor, Customer display) are full screen, each with its own layout.
- **Status is always plain language:** Sent, Preparing, Partly ready, Ready, Served, Collected, Completed, Unpaid, Part paid, Paid, Not sent, Online, Not connected, and so on. Each has a small dot and a restrained tone.
- **Consistent states everywhere:**
  - empty states say what the screen is and what to do next;
  - loading uses skeletons;
  - errors appear inline in plain words;
  - success is confirmed with a toast.
- **Forms:**
  - sectioned layouts (title and explanation on the left, fields on the right);
  - required markers and field-level hints and errors;
  - drawers for create and edit (Staff), modals with header, body and footer.

## 2. Design system (`apps/web/src/styles.css`, `ui/components.tsx`, `ui/Shell.tsx`)

- **Tokens:**
  - one neutral scale;
  - brand red `#E32129`, used only for primary actions and the active navigation state;
  - status colours: ok, warn, danger and info, each with a soft variant;
  - separate dark tokens for kitchen, supervisor and display.
- **Type and shape:** Inter with tabular numbers, 6–12 px radii, hairline borders, shadows only on overlays. No gradients, no decorative colour blocks.
- **Scale:** control heights of 32, 40, 52 and 64 px. The POS and kitchen use the 52–64 px touch sizes.
- **Shared components:**
  - buttons: primary, go, danger, ghost; sizes sm, lg, xl;
  - Field and FormSection;
  - Modal and Drawer;
  - status badge with labels and tones;
  - toasts, skeleton, empty state, metrics strip;
  - underline tabs and segmented control;
  - PIN pad (touch and keyboard);
  - receipt paper.
- **Navigation:**
  - **Operations:** Dashboard, POS, Orders, Kitchen, Supervisor, Customer display
  - **Inventory:** Stock, Stock taking
  - **Menu & setup:** Menu & recipes, Stations & routing, Floor & tables, Devices & printing
  - **Management:** Staff, Reports, Settings

  Items appear per permission; the server still checks every action.
- **Responsive:**
  - the sidebar collapses under 900 px;
  - the POS stacks the cart below the menu on narrow screens;
  - the customer display goes to one column.

## 3. POS

- **Order screen:** a category rail on the left, a large product grid, and a persistent cart on the right. The cart has a clear header (order and table, status, payment) and a sticky footer with totals and actions.
- **Actions:**
  - the main next step is visually strongest: Send to kitchen, or Take payment;
  - Served / Picked up is green;
  - receipts are secondary.
- **Modifiers:** choosing options opens a dialog with large option buttons and the running price.
- **New actions, all server-side, audited and keeping order history:**
  - **Rush**
  - **Move** to a free table, or convert to takeaway
  - **Merge** another open order onto this bill
- **Split payment by items:** choosing items fills in the payment amount (tax shared proportionally), alongside amount splits and cash with quick amounts and change.
- **Receipt:** "Print receipt" queues the till's printer. With no printer yet, it opens the branded receipt preview with **browser print**. Completed orders can still be reprinted.
- **Till security:** a PIN session on a registered till **locks itself after 5 idle minutes** and returns to the PIN pad.
- **Floor view:** table cards show state, order number, amount due and minutes open, with a legend and counts per state.

## 4. Kitchen (KDS)

- Tickets are built to read from across the room:
  - large order number and timer on a state-coloured header: dark for new, amber for cooking, green for ready, red for late;
  - where the order is, with state and time received;
  - large quantity and item lines;
  - modifiers indented, special instructions in red, an order note band.
- Action buttons are 56 px high: START, PAUSE, READY, RECALL, BUMP.
- **Rush tickets are listed first** and marked RUSH.
- **Station switcher** for staff. A paired kitchen screen stays on its own station, enforced by the server.
- **Timers** read as `m:ss`, and as `1h 05m` past an hour.
- **Optional prices per station** (Stations & routing → Kitchen screen settings). These are authoritative line totals from the order; the kitchen never calculates a price.
- **Notifications** for new orders, added items, voids, recalls and rush, with an unread count, a banner and optional sound.

## 5. Supervisor / expo

- **Control strip:** In the kitchen, Ready to hand over, Late, Rush. Each doubles as a filter.
- **Each order card shows:**
  - elapsed time;
  - an "x/y READY" bar;
  - every station with its state and time, plus a Ready button;
  - "Waiting on <station>" when an order is late;
  - payment due or Paid;
  - a large green **Served / Handed to customer** button.
- Rush orders are listed first.

## 6. Customer display

- A branded header (logo, MY FOOD, restaurant name) and a clock.
- Two large columns: **NOW PREPARING** and **READY FOR COLLECTION**. Ready numbers are the largest and ease in when they appear.
- Calm empty states and a brand footer line.
- Order numbers only: no staff, prices or internal states.

## 7. Inventory

- **When stock is deducted:** stock leaves when items are **sent to the kitchen**, inside the same transaction as the order round. That is the confirmed business event: never on tap, payment, reload or realtime.
  - It deducts once per round. A retried or replayed submission deducts nothing, because the round is idempotent.
  - Only products with a recipe deduct stock.
- **Cancellation:**
  - Cancelling an order writes **`sale_reversal`** movements. They return exactly what the ledger shows the order's sales took, including orders merged into it.
  - The original sale movements stay in the ledger.
  - A unique index allows **at most one reversal per order and stock item**, so repeated or duplicated cancellations cannot return stock twice. The database enforces this, not only the application.
  - The cancellation audit entry records how many items were returned.
- **Voids:** voiding items after cooking has started does **not** return stock; the food was used (waste). This is documented in the UI.
- Deliveries, wastage, adjustments, recipes, stock takes and approvals are unchanged, and restyled.

## 8. PIN authentication

- **Where it works:** PIN sign-in works **only on a registered till**, meaning a POS paired from Devices & printing.
  - The till keeps its own device login, separate from staff sessions.
  - The server accepts a PIN only from a till's login.
  - A short PIN is never an internet-facing credential on its own.
- **How PINs are stored:** only a keyed digest is stored (HMAC-SHA256 with the server-only `PIN_PEPPER`).
  - It is unique per restaurant, enforced by a unique index.
  - It is never returned, logged, shown or kept in browser state.
  - Staff lists show PIN *status* only: No PIN, Awaiting first sign-in, PIN active.
- **Assigning:** the owner adds a staff member with name, email, role, branch scope and a starting PIN, or sets or resets a PIN later.
  - Duplicates get: "This PIN is already in use. Please choose another PIN." It never says whose.
  - Weak PINs (repeated digits, simple sequences) are refused.
- **First sign-in (activation):** the staff member enters the starting PIN on the pad, then **chooses their own PIN**. The starting PIN stops working. After that the owner no longer knows it.
- **Wrong PINs:** a wrong or unknown PIN gets one generic answer, "PIN not recognised".
  - 5 failures in 10 minutes lock that till for 10 minutes.
  - 30 failures across the restaurant lock PIN sign-in for all tills for 10 minutes.
  - Every attempt is recorded in `pin_attempts`, and lockouts are audited (`security.pin_lockout`).
- **Changing a PIN:** needs the current PIN, or a verified email link.
- **Forgot PIN:** emails a single-use link to the registered address. The answer is the same whether or not the address exists. The link lands on `/reset-pin`. The owner can also reset a PIN.
- **Admin security kept:** a PIN session **cannot use staff, device or settings administration**, even for an owner. Those need a password sign-in; the server removes those permissions from PIN sessions. Owners and managers keep email and password.
- **Session creation:** the server creates the staff session with a one-time token after the PIN check. Nothing is emailed and no password is involved.

## 9. Receipts

- **One receipt document for every output.** The screen preview, **browser print** (80 mm page, the rest of the page hidden) and **ESC/POS** all use the same receipt.
- **Contents:**
  - the **real logo** (the owner's artwork);
  - restaurant name, address and phone;
  - order number, date and time;
  - served by, table or takeaway;
  - items with modifiers, unit price for quantities above 1, and line totals;
  - subtotal, taxes, total;
  - each payment: method, cash received, change;
  - balance due if any;
  - the configurable receipt message.
- **Thermal printers:** the logo is sent as a **1-bit raster** (GS v 0, 256×256 dots). It is generated from the same asset by `scripts/brand/make-receipt-logo.py`.
- Reprints are marked **REPRINT** and audited.
- Phone and receipt message are edited in **Settings**.

## 10. Branding

- **MY FOOD / Chefelisha Restaurant** appears on:
  - sign-in and the PIN pad, activation, reset and pairing;
  - the sidebar, the POS top bar, the customer display, receipts;
  - the browser title, favicon and touch icon;
  - the **web app manifest** (name, icons, theme colour);
  - the loading screen.
- **Repository sweep:**
  - no user-facing "Bibiani" remains in the app;
  - the test and demo script names now say "Chefelisha";
  - the demo staff email domain moved to `demo.chefelisha.test` (auth logins and staff records).
- **Kept on purpose:** technical identifiers that must not change:
  - the production URL `bibiani-restaurant.vercel.app`;
  - the repository name;
  - restaurant slugs (`bibiani`, `bibiani-demo`);
  - the Supabase config project id;
  - migration history.

## 11. Security changes

- Staff PINs, as in §8: a keyed digest, per-till and per-restaurant lockout, an audited security log, and no admin permissions in PIN sessions.
- `restaurants` can be updated by the API **only** in `name`, `phone` and `receipt_footer` (column grants), and only for the tenant's own row (RLS policy).
- Production checks: all **46 public tables have RLS**, and browser roles have **no** access to `staff` or `pin_attempts`.
- New secrets `PIN_PEPPER` (per environment) and `APP_URL` are set in Vercel. None were committed. The secret scan passes on every build.

## 12. Tests run

| Suite | Result |
|---|---|
| Lint, typecheck (all packages) | pass (only CSS specificity warnings) |
| Unit and integration tests (PGlite), including the HTTP layer | **140 / 140** (was 129) |
| New tests: PINs | unique PIN; duplicate refused without identity; weak PINs refused; digest never exposed (configuration JSON checked); cashier cannot assign; sign-in only on a till (KDS device and staff refused); invalid PIN generic; activation; old PIN invalid after change; change needs current PIN or email link; lockout after 5 failures, audited, expires; recovery email only to registered staff with the same answer; PIN session cannot use admin over HTTP |
| New tests: inventory | sale deducts once, replay does not; cancellation reverses; repeated cancellation does not; DB refuses a second reversal; ledger order and audit count |
| New tests: floor | transfer to a free table; refused onto an occupied one; convert to takeaway; merge moves items, tickets and payments; source closed with pointer; merged ticket number; second merge refused |
| New tests: kitchen | rush first; station price display uses authoritative totals |
| New tests: receipt | logo block first; name, phone and unit price; ESC/POS contains the raster |
| Migrations from empty, RLS on every table | pass (19 migrations, 46 tables) |
| Browser, staging | **15 / 15**: milestone 3, operations 3, failure behaviour 6, password 1, Realtime 1, **PIN 1** (new). Two specs were updated for the new tabs and plain-language labels. |
| GitHub CI | green on `55011a1` |

## 13. Production verification (2026-09-25)

- Before deploying: production was healthy and the schema was `…001700`.
- Migrations 1800 and 1900 were applied with `supabase db push`. `/health/ready` shows **ready**, schema `20260925001900`, and Auth and Realtime OK.
- Release `production-55011a1` is deployed at the **unchanged** URL. The manifest is served and the title is "MY FOOD — Chefelisha Restaurant".
- **PIN flow in the real browser on production (demo restaurant):**
  1. The owner assigned starting PINs.
  2. "POS-01 Main Hall" was paired and opened on the PIN pad.
  3. Kofi Mensah signed in with his starting PIN and chose his own PIN.
  4. He reached the POS; Back office was hidden for the PIN session.
  5. The till was locked; the starting PIN was refused and his own PIN worked.
- **Screens checked in the real browser on production:** kitchen with live tickets, supervisor with 7 orders (3/4 READY, Late, Waiting on Grill), customer display, POS order screen, PIN pad.
- **RLS and privilege checks on production:** as in §11.

## 14. Remaining limitations (honest)

- **Tills paired before this release** have no device login stored. Re-pair them to enable PIN sign-in; email sign-in keeps working.
- **PIN recovery email** uses Supabase's built-in email, which only delivers to Supabase organisation members. Configure custom SMTP before relying on self-service recovery. The owner reset always works.
- Each PIN sign-in creates a Supabase session server-side. Supabase's Auth rate limits apply; this has not been load-tested.
- **Split by items** fills in the payment amount. Payments are not allocated to individual items in the data, and the kitchen still sees one order.
- **Merge / move:** kitchen screens update at once. Paper tickets that were already printed keep the old number or table; no "moved" slip is printed.
- **Discounts** are not implemented. The receipt supports a discount line, but there is no discount workflow yet.
- **Voids after cooking do not return stock** (by design: waste). There is no FIFO or average costing, and no stock transfers.
- **Not rebuilt:** the Stations & routing editor, Floor & tables and Devices & printing configuration tables use the new design system but are the earlier layouts, not rebuilt as drawers.
- **Hardware:** the thermal receipt (logo raster included) is production-ready in code but **not printed on physical hardware**, which is still pending.
- **Other gaps:** no owner MFA, no Content-Security-Policy header, daily backups only (no PITR).
