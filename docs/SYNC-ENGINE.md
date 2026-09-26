# MY FOOD — sync engine (hub ↔ cloud)

How the in-store hub and the MY FOOD cloud stay consistent. Context: [OFFLINE-ARCHITECTURE.md](OFFLINE-ARCHITECTURE.md).

## Direction and authority

| Flow | What | How it is applied |
|---|---|---|
| Cloud → hub (**snapshot**) | Branch configuration: restaurant, branch, roles, staff (no PIN digests, no emails), menu, taxes, modifiers, floor, stations, devices, printers, routing, inventory items, recipes, promotions. Also today's and yesterday's order-number counters | Rows are upserted in foreign-key order. Rows the cloud no longer has are deleted; a row still referenced locally is switched off instead. Columns the hub owns are never in a snapshot (see below) |
| Cloud → hub (**movements**) | Stock movements of the branch (last pull minus 10 minutes of overlap) | Inserted once by id; the quantity change is applied the first time a movement is seen |
| Hub → cloud (**batches**) | Orders, rounds, items, modifiers, tax lines, discounts, kitchen tickets, payments, table status, stock movements, order/ticket events, audit events | One transaction per batch, record by record. See "Ingest" |

Columns the hub owns, which snapshots never carry:
- staff PIN digests;
- devices' local logins and health;
- table status;
- stock quantities;
- the branch's hub link.

## Change capture (hub)

Triggers on the floor tables write one row per changed record into `hub.outbox`. This is hub-only schema in `packages/hub/src/hub-schema.ts`, never in the cloud migrations. An upload always sends the record's **current** state, so repeated changes collapse into one.

| State | Meaning |
|---|---|
| `pending` | Waiting to be uploaded (shown as RETRYING when `attempts > 0`) |
| `syncing` | Part of a batch in flight. A change during flight marks it `dirty`, and it goes back to `pending` after the acknowledgement |
| `synced` | Acknowledged by the cloud |
| `conflict` | Refused by the cloud, with a reason. Kept and shown in the hub window and the back office; never dropped |

- **Order within a batch:** parents before children (orders, then rounds, items, tickets, payments…), then by change sequence.
- **After a crash:** records left in `syncing` go back to `pending` at start-up.

## Ingest (cloud)

`POST /v1/hub/batches` is only for the hub device attached to the branch (`hub.sync` permission).

- **Replays:** a batch ID already applied returns the stored result and changes nothing.
- **Kinds of record:**
  - `upsert`: replace by primary key;
  - `origin`: event rows, inserted once by `origin_id`, because sequence IDs would collide;
  - `movement`: inserted once, and the delta applied when first seen;
  - `table_status`: status columns only.
- **Uploaded orders:**
  - record the hub that made them;
  - move the cloud's order-number counter past the hub's numbers, so a detached branch never reuses a number.
- **Branch checks:**
  - records with a branch must be for the hub's branch; records without one (restaurant-wide audit) are accepted;
  - rows linked to an order are checked against that order's branch.
- **Deletions:** accepted only for recomputed tax lines.
- **Refusals:** each failure, such as a missing reference, is rolled back to a savepoint and reported as a conflict. The rest of the batch still applies. Conflicts are audited as `hub.sync_conflicts`.
- **The branch guard:** while a branch has a hub, database triggers refuse floor writes (orders, payments, kitchen tickets) that do not come from the hub. Error: *"This branch is run by its in-store hub…"*.

## Conflict rules

| Situation | Rule |
|---|---|
| Price changed while offline | The sale keeps the price charged (stored on the line). New price for new orders after the next snapshot |
| Product sold out while offline | Sales already made stand; new orders see sold-out after the snapshot |
| Staff deactivated or role changed | Applied at the next snapshot. Offline sales stay attributed to that person |
| PIN reset in the back office | The PIN version differs, so the hub forgets its copy and the old PIN stops working on the hub |
| Order numbers | Only the hub numbers its branch's orders. The cloud counter is raised past uploaded numbers. Attaching a hub is refused while the web POS has open orders |
| Stock | Quantity = sum of movements; each movement applied once on each side |
| Same batch sent twice / lost acknowledgement | Idempotent: same batch ID replays; same records under a new ID change nothing |

## Timing

- The hub runs a sync cycle every 15 seconds: upload first, then snapshot and movements.
- While the cloud is unreachable it backs off, up to 5 minutes.
- After each successful cycle it sends a heartbeat with its health (pending, conflicts, and what it sees of local devices) for the back office.

## Tests

- `packages/testing/test/hub-sync.test.ts` (12 tests) uses two separate databases, cloud and hub:
  - first sync;
  - branch guard;
  - offline selling;
  - price change;
  - exactly-once upload;
  - duplicate batches;
  - lost acknowledgement;
  - two tills;
  - stock both ways;
  - staff deactivation;
  - attach and detach numbering;
  - permissions.
- `apps/hub/test/hub-http.test.ts` (7) runs the same over HTTP.
- `e2e-hub/hub.spec.ts` runs it in a real browser.
