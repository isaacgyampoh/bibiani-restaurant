# Printing: set-up for the restaurant

A browser cannot send to receipt printers by itself. **One Windows PC in the restaurant runs MY FOOD Printing** and prints everything: kitchen tickets, receipts and bills, from every till and phone. (In a branch run by the MY FOOD Hub, the hub does this instead.)

## 1. Install MY FOOD Printing (once)

1. Choose a Windows 10/11 PC at the counter that stays on during service (it can also be a till).
2. Download **MY FOOD Printing**: https://github.com/isaacgyampoh/bibiani-restaurant/releases/latest/download/MY-FOOD-Printing-Setup.exe and install it. It starts with Windows and keeps running next to the clock.
3. It shows a code. In MY FOOD → **Devices & printing**, press **Enter code from device** on **PRINT-AGENT-01** and type the code. The app then says **Printing is on**.

## 2. Tell MY FOOD where each printer is

In MY FOOD Printing:
- **Search the network** lists every network printer it finds (e.g. `192.168.1.87`). **Print test page** shows which one is which.
- **USB printers on this PC** lists printers plugged into this PC by USB (install the printer's Windows driver first). Use the name exactly as shown.

Then in MY FOOD → Devices & printing → **Edit** the printer:
- **How is it connected?** Network, or USB cable into the printing PC.
- **Printer IP address** (network) or **Windows printer name** (USB).
- **Printed by:** PRINT-AGENT-01 (the PC running MY FOOD Printing).

`192.168.0.1` / `192.168.1.1` are usually the Wi-Fi router, not a printer; MY FOOD warns about this.

## 3. Send tickets and receipts to the printers

- **Kitchen tickets:** Stations & routing → the station (e.g. Kitchen) → connect the printer (Main). A station can have both a screen and a printer.
- **Receipts and bills:** Devices & printing → **Edit** each till → **Receipt printer**.

## 4. Check

Devices & printing → **Test print** on the printer. MY FOOD reports **printed**, **did not print** (with the reason), or **waiting** (MY FOOD Printing is not running).

The panel at the top of Devices & printing always says whether printing is working and what to fix: printing not installed or stopped, printers with a router address or no address, stations that do not print, tills without a receipt printer, and how many jobs are waiting.

## What has been verified

- Automated, against the real MY FOOD API with a simulated network printer: pairing with a code, a wrong-device code refused with an explanation, an order printed once, a direct test page, network search (`apps/desktop/test/printing-station.test.ts`).
- USB printing through the Windows spooler: tested with a stand-in for Windows (`apps/print-agent/test/windows.test.ts`). **Not yet tested on the restaurant's printers or a Windows PC with a real USB printer.**
