# MY FOOD — device management and health

## Devices

| Type | What it is | Logs in as |
|---|---|---|
| POS till | A browser (or installed app) where staff take orders with their PIN | Its own device login; staff unlock it with a PIN |
| Kitchen screen | Shows one station's tickets | Its own device login |
| Customer display | Shows order numbers: Order received / Preparing / Ready | Its own device login (read-only) |
| Printer | Network ESC/POS printer, driven by a print agent or the hub | No login |
| Print agent | Program that prints for a cloud branch | Its own device login |
| **MY FOOD Hub** | The in-store PC running the restaurant locally | Its own device login to the cloud |

Each device has:
- a name, type, station and branch;
- active or off;
- whether it is paired, and when it was last seen;
- its software version;
- for printers: address, paper width, backup printer, last error and unprinted count;
- for the hub: its sync state.

## Where devices are managed

- **Back office, Devices & printing:**
  - add a device;
  - rename it;
  - pair it (*Enter code from device*, or *Create code*);
  - revoke it (it stops at once);
  - turn a printer off or on, or send a test print;
  - *Run branch from hub* / *Stop running branch*.
- **Hub window (on the hub PC):**
  - the hub's connection and sync state;
  - the address tills and screens open;
  - devices of the branch, and *Enter code from device* (with a manager PIN).

## Health

**Cloud branch.** Devices report to the cloud, and the Devices page shows online or offline (a heartbeat within 90 seconds), last seen and printer state.

**Hub branch.** Devices talk to the hub. The hub reports to the cloud after every sync, and the Devices page shows:
- a summary line: *"HUB-01 is online. Everything is sent."*, *"…is online and sending 7 change(s)."*, or *"…has not reported since 19:02. The restaurant keeps working on the hub if only the internet is down…"*;
- each till and screen, with status *through the hub* and last seen as reported by the hub;
- each printer's error and unprinted count as the hub sees them;
- on the hub row: *All sent*, *N changes waiting since …*, or *N records need attention*.

**On tills and kitchen screens served by the hub.** While the internet is down they show *"Offline · everything keeps working and is saved on the hub · N changes to send"*. The customer display never shows it.

## Printers are not paired

Printers have no login. They are added in Devices & printing with their network address and the program that drives them:
- in a cloud branch, the print agent;
- in a hub branch, the hub's own print agent, which uses the branch's *Print agent* device record.

To take a printer out of use, turn it off; to remove it, deactivate it.

## What is verified

- **In software (automated and browser tests):**
  - status and "last seen" from heartbeats;
  - the hub's report of its devices;
  - the summary line;
  - device revocation.
- **On the real restaurant network:** not yet. See [HARDWARE-ACCEPTANCE.md](HARDWARE-ACCEPTANCE.md) §2 and §5.

## Pairing and revocation

See [DEVICE-PAIRING.md](DEVICE-PAIRING.md). Every pairing:
- uses a short-lived single-use code;
- creates a new login and removes the previous one;
- is audited.

Revoking removes the login immediately.
