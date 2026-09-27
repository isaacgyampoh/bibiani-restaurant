# MY FOOD — printers, screens and routing

## Model

```
Product ──(routing rule: product > category (walking up) > branch default)──▶ Station
Station ──(station outputs)──▶ any number of screens and/or printers
```

- **Independent outputs.** Screens (kitchen screens) and printers are separate devices, linked to a station by *station outputs*. The roles are:
  - `primary`;
  - `copy`: an extra printed copy;
  - `backup`: used if the main printer fails.
- **Any combination.** A station can have a screen only (e.g. Bar), a printer only (e.g. Pastry), both (e.g. Grill), or several of each.
- **No outputs.** A station with no active output is skipped by routing: its items go to the next matching rule, so no ticket lands where nobody sees it.
- **Extra printers per rule.** A routing rule can also add extra printers (e.g. a second pastry printer for cakes).

Tested in `packages/testing/test/station-outputs.test.ts`:
- printer-only;
- screen-only;
- both;
- all outputs off, so routing falls through;
- test print.

## Printing

- **One document.** The server renders every kitchen ticket, receipt, void slip and test page as a printer-independent document. Kitchen tickets can show prices, depending on the station setting.
- **Rendering.** The print agent turns documents into ESC/POS bytes (80 mm or 58 mm, with the logo) and sends them to network printers (IP, port 9100).
  - In a cloud branch it is a separate program.
  - In a hub branch it runs **inside the hub** and prints over the restaurant LAN, also offline.
- **Queue states:**
  - `pending` (queued);
  - `claimed` (printing);
  - `printed`;
  - `failed` (retrying with backoff);
  - `dead` (needs a person);
  - `cancelled`.
- **Failures:**
  - a ticket is never dropped;
  - repeated failures move it to the printer's backup, if one is set;
  - a failure after bytes may have been sent is marked **possible duplicate**;
  - a crashed agent's lease expires and the job is retried;
  - the agent keeps a local journal so it never prints a finished job twice.
- **Where failures show:** on the kitchen screen (printer alert), in **Devices & printing → Print queue** (Retry), and in device health ("N unprinted").

## Managing printers (Devices & printing)

- **Add a printer** with its name, IP address and the agent (or hub) that drives it.
- **Connect it to stations:** *Stations → Connect screen or printer* (Main, Extra copy, or Backup).
- **Test print:** queues a test page (printer name, paper width, time). If nothing prints within a minute, check the printer and the print queue.
- **Turn off / Turn on:** a turned-off printer receives no new tickets. A station whose only outputs are off is skipped by routing.
- **Status:** online or offline, last seen, last error, and unprinted count. In a hub branch these come from the hub's report.

## What has been verified, and how

| What | How verified | Physical printer |
|---|---|---|
| Station screen-only, printer-only, both, none | Automated (`station-outputs.test.ts`) | n/a |
| Ticket bytes to a network printer through the hub: order number, items, quantities | Automated over real TCP with simulated printers (`apps/hub/test/hub-printing.test.ts`) | **Not yet** |
| Printer off: ticket waits, is visible as failed, prints **once** when back | Same test | **Not yet** |
| Main printer stays down: moves to the backup, prints once | Same test | **Not yet** |
| No double printing after a crash or lost acknowledgement | Automated (`apps/print-agent/test/agent.test.ts`) | **Not yet** |
| Layout fits 58 mm (32 columns) and 80 mm (48 columns) | Automated (`packages/escpos/test/render.test.ts`); diagnostic ruler line | **Not yet**: check on real paper |

On site, the technician first runs `pnpm hardware:printer-check <printer-ip> [--width 58]` from a laptop on the restaurant network. It prints directly, bypassing MY FOOD: the ruler line must fit on one line. Then comes the full test in [HARDWARE-ACCEPTANCE.md](HARDWARE-ACCEPTANCE.md) §3.

## Not implemented (by decision, until hardware is chosen and tested)

- **USB printers.** MY FOOD prints to network (Ethernet, port 9100) ESC/POS printers. A USB-only printer is not supported, and support is not claimed. Recommendation: buy the Ethernet model of the printer (most thermal receipt printers are sold in both versions). If a USB printer must be used, the extension point is the printer driver (`PrinterDriver` in `apps/print-agent/src/driver.ts`): a Windows printer-spooler driver would be added next to the network one. It would be built and tested against that exact printer.
- **Cash drawer.** MY FOOD does not open a cash drawer. Most drawers plug into the receipt printer and open on an ESC/POS pulse. Whether the restaurant's printer and drawer do this is checked on site with `pnpm hardware:printer-check <ip> --drawer`. Only after that is verified would an "open drawer on cash payment" option be added.
- **Manually sending one failed ticket to a different printer.** Future enhancement. Today a failed ticket retries automatically, moves to the station's backup printer after 3 attempts, and can be retried from the Print queue. A manual reroute would keep the ticket's identity, station and audit trail and mark the original failure. It is not added now, to avoid destabilising the working automatic fallback.
