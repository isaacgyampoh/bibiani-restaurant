# Devices and Printing

## 1. Flow

```
Order ──► Production ticket ──► Print job (database outbox) ──► Print agent (LAN) ──► Printer
   (same transaction as the ticket)     │ lease + claim id          │ TCP 9100 ESC/POS
                                        └──── outcome reported ◄────┘
```

- The order domain never knows printer bytes. It produces a **document model** (`kitchenTicketDocument`: blocks of text, columns, dividers, cut). The agent renders it for the actual printer (`packages/escpos`).
- A kitchen ticket and its print jobs are written in **one transaction**. A submitted ticket without a print job can't exist (TEST 6).
- If a station has a KDS but no printer, the ticket is created with no print job and logged (`order.tickets_without_printer`). A station with no active output at all can't receive items: routing falls back, and if nothing is reachable the send is refused with `NO_ROUTE`.

## 2. Print job lifecycle

| Status | Meaning |
|---|---|
| `pending` | Waiting for an agent |
| `claimed` | Leased to one agent for 30 s (`claim_id`, `lease_expires_at`) |
| `printed` | Agent reports the printer accepted every byte |
| `failed` | Attempt failed; `next_attempt_at` is set by backoff (2, 5, 15, 30, 60 s…) |
| `dead` | Max attempts (8) reached; never deleted; visible in the print queue and on the station's KDS until a manager retries |
| `cancelled` | Reserved for voided orders (later phase) |

**Delivery guarantee (stated honestly):** at-least-once, with visible duplicate marking.

- Failure **before** any byte was sent (connection refused): plain retry.
- Failure **after** bytes may have reached the printer, or an agent crash (lease expiry): retry with `possible_duplicate = true`, printed as a `** POSSIBLE DUPLICATE **` banner.
- After 3 failed attempts on the original printer, a job moves to the printer's configured backup (`printers.backup_printer_id`).
- A late report from an expired lease is rejected (`STALE_PRINT_CLAIM`), so it can't overwrite a newer attempt.
- The agent keeps a local journal (`.journal/print-journal.jsonl`). A job it already printed is **never re-sent** to the printer just because the server didn't hear back in time. It re-reports instead (tested).

"Printed" means the printer accepted all bytes over TCP and the connection closed cleanly. Network ESC/POS printers give no stronger confirmation. That's why tickets also show on the KDS, and why printer health is shown to cooks.

## 3. Print agent

- Authenticates as its own paired device (a Supabase Auth user linked to `devices.auth_user_id`, kind `print_agent`), and can only call print endpoints (`print.agent`). It is paired like any device (§7); it keeps only the refresh token.
- It discovers its printers from `GET /v1/print-agent/config`: the printers whose `agent_device_id` is this agent.
- Loop: every 3 s it does the following. Printers work in parallel; jobs for one printer go in order.
  1. Flush any results still in the journal.
  2. Claim up to 10 jobs.
  3. Render each job and send it to its printer.
  4. Journal the result, then report it.
- Heartbeat every 30 s: probes each printer's TCP port and reports reachability (`printers.last_error`) and its own liveness (`devices.last_heartbeat_at`).
- Survives network loss: claims fail and are logged, the loop continues, and results stay in the journal until reported.
- Replaceable: nothing in the order domain depends on it. It is just an API client.

Deployment: see [05-deployment.md](05-deployment.md) §2. Configuration: `apps/print-agent/.env.example`.

## 4. Supported hardware

| Transport | Status |
|---|---|
| Network ESC/POS (TCP 9100), 58 mm / 80 mm | Implemented; tested against a TCP fake printer. **Not yet tested on a physical printer.** |
| USB ESC/POS | Enum exists, no driver yet (`PrinterDriver` interface ready) |
| Android built-in printers (e.g. Sunmi) | Not started; would be a new `PrinterDriver` |
| Cash drawer kick | Not started (backlog PRN-08) |

## 5. Devices

`devices` holds POS, KDS, printers, print agents and customer displays per branch, optionally bound to a station. Device principals get fixed, narrow permissions (`DEVICE_PERMISSIONS`):

| Kind | Can |
|---|---|
| `kds` | operate tickets of **its own station** only; view orders |
| `print_agent` | claim and report print jobs for its own printers |
| `customer_display` | read the customer board (order numbers and state only) |
| `pos` | nothing by itself. A signed-in staff member acts, and names the POS via `x-device-id` (validated) |

Pairing is implemented and tested (local and hosted DEV); see §7.

## 6. Hardware validation checklist (before the milestone counts as done) ☐

Run with the actual models on the restaurant network. Record the date, models and results in `docs/hardware-log.md`.

1. Each station printer prints a test ticket; 80 mm layout readable; codepage OK.
2. Scenario A (Table 12): four tickets on four printers within 5 s of Send.
3. Unplug the grill printer, send an order: KDS shows the printer alert; plug back in; it prints within one backoff step.
4. Pull the network cable of the agent machine mid-order: jobs print after reconnection; duplicates, if any, carry the banner.
5. Power-cycle the agent machine while printing: no ticket lost; the journal prevents a reprint of completed jobs.
6. Receipt printer (receipt printing is the next phase).
7. KDS on the kitchen tablet: realtime updates; Wi-Fi off/on reconciles within 20 s.
8. Customer display shows `5001 READY` within 2 s of the last station.

## 7. Device pairing (implemented, Phase 4)

No device ever holds a shared or embedded password.

```
Manager (Admin → Devices)             API                                   Device (browser /pair, or print agent)
─────────────────────────             ───                                   ──────────────────────────────────────
Add device "PASTRY-01" (kind, station) ──► devices row (restaurant, branch, kind, station)
"Pairing code" ──────────────────────► 8-char code from an unambiguous alphabet,
                                        10-minute expiry, single use;
                                        only a SHA-256 hash is stored; audited
Show code on screen ◄──────────────────
                                                                              types the code ──► POST /v1/devices/pair (public, 5/min/IP)
                                        redeem (SECURITY DEFINER): hash match, not expired,
                                          not used → marks this and all other open codes used
                                        create a NEW Supabase Auth user for the device
                                          (random 32-byte password, discarded immediately)
                                        bind devices.auth_user_id; delete the previous login
                                          of this device (re-pairing revokes the old tablet)
                                        sign in once → return session ─────────────► stores the refresh token
                                        audit "device.paired" + device_events
```

- **What a paired device can do:** its principal comes from `devices` (kind, branch, station). A KDS may read and act only on **its own station**. A customer display may read only the numbers-only board. A print agent may only claim and report print jobs for its printers. POS devices have no permissions of their own: a staff member signs in on the till, and the till is recorded on every order and payment (`x-device-id`, validated server-side).
- **Revoke:** Admin → Devices → Revoke unbinds the login and deletes it. The API refuses the device immediately. An already-open realtime socket survives at most until its access token expires (≤ 1 h). The token then can't be refreshed, and the channel carries only ids anyway.
- **Interrupted pairing:** if the network drops *during* pairing, the code is already used up and the device isn't paired. Generate a new code (found in staging failure testing).
- **Hosted-verified:** create code → pair → station-scoped access → re-pair replaces the identity → revoke; expired and reused codes are rejected (`administration.test.ts`).

## 8. Device and printer status (implemented, Phase 4)

| Signal | Source | "Online" means |
|---|---|---|
| POS / KDS / display | `POST /v1/devices/heartbeat` every 30 s from the running screen | last heartbeat ≤ 90 s ago |
| Print agent | its own heartbeat every 30 s | same |
| Printer | agent probes TCP 9100 and reports each print outcome | agent alive **and** last probe/print succeeded |
| Offline transition | `pg_cron` job `rp-sweep-offline-devices` every minute | writes `device_events: went_offline`, signals `branch:<id>:ops` |

Admin → Devices shows ONLINE / OFFLINE / never seen, last seen, printer errors and unprinted jobs. It updates live through the ops signal, with a 20 s safety refresh. This is real device liveness, not the browser's own connection state.
