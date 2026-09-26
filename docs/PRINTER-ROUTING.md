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

## Not yet supported

- **USB printers, cash drawer kick:** need the restaurant's hardware to build and test.
- **Moving one failed ticket to a different printer by hand:** today, failed tickets retry and then fall back to the configured backup printer.
- **Physical printers have not been tested.** Everything above is tested with the document model and a simulated transport.
