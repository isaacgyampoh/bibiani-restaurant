# MY FOOD — hardware acceptance test (to run at the restaurant)

This is the on-site test for the real equipment. **Nothing here is marked as passed until someone has done it at the restaurant.** Fill in the Result column (PASS / FAIL + note), the date, and who tested. Anything that fails goes back to development before handover.

- **Use test data, not the restaurant's real sales.** Use the demo restaurant, or test orders cancelled afterwards with reason "acceptance test". Never reset or delete production data.
- **Testers:** ____________ **Date:** ____________
- **Hub PC** (model / Windows version / IP): ____________
- **Printer(s)** (model / connection / IP / paper width): ____________
- **Router / network:** ____________

## 1. Installer and Windows

| # | Step | Expected | Result |
|---|---|---|---|
| 1.1 | Download the **production** installer from GitHub Actions (artifact `MY-FOOD-Hub-production-<sha>`) | File named `MY-FOOD-Hub-Setup-<version>-production.exe` | |
| 1.2 | Run it | Windows SmartScreen warns (installer is **not signed**). *More info → Run anyway* works | |
| 1.3 | Install | Installs for all users; desktop shortcut "MY FOOD Hub" | |
| 1.4 | Start | Hub window opens with a pairing code; title "MY FOOD Hub" (not "TEST") | |
| 1.5 | Check `%APPDATA%\myfood-hub\hub` | Contains `db`, `secrets.bin`, `hub.log`; **no** `secrets.json` | |
| 1.6 | Open `secrets.bin` in Notepad | Unreadable (encrypted by Windows); no readable key | |
| 1.7 | Search `hub.log` for any PIN used in the tests, "Bearer", "refresh" | Not found | |
| 1.8 | Pair the hub: back office → Devices & printing → add *MY FOOD Hub* → *Enter code from device* | Hub window shows Connected; *Run branch from hub* works | |
| 1.9 | Restart Windows | MY FOOD Hub starts by itself, tray icon appears, tills work again without anyone opening it | |
| 1.10 | Start MY FOOD Hub a second time from the shortcut | No second hub, no error: the existing window comes forward | |
| 1.11 | Close the hub window (X) | Window hides; tray icon stays; tills keep working | |
| 1.12 | Tray → Open MY FOOD Hub | Window returns | |
| 1.13 | Tray → Quit | Hub stops; tills show they cannot reach the hub. Start it again from the shortcut; everything returns | |

## 2. Network and pairing

| # | Step | Expected | Result |
|---|---|---|---|
| 2.1 | Give the hub PC a fixed IP in the router. Windows Firewall: allow MY FOOD Hub on **private** networks when asked | Tills can open `http://<hub-ip>:8080` | |
| 2.2 | POS 01: open the hub address → shows a code. Approve in the hub window with a manager PIN | Till shows the PIN pad | |
| 2.3 | Approve with a cashier's PIN | Refused | |
| 2.4 | Wait more than 10 minutes with a code shown, then approve with the old code | Refused; the device shows a new code by itself | |
| 2.5 | Pair POS 02, a kitchen screen, and the customer display | Each continues by itself | |
| 2.6 | Printers are not "paired": add each in Devices & printing with its IP and the hub's print agent | Printer appears with status | |
| 2.7 | Revoke POS 02 in the back office, then use it | Needs pairing again; cannot continue silently | |
| 2.8 | Re-pair POS 02 | Works | |

## 3. Printers

Before step 3.1, the technician may run `pnpm hardware:printer-check <printer-ip> [--width 58]` from a laptop on the same network. It checks the printer independently of MY FOOD: the ruler line must fit on one line.

| # | Step | Expected | Result |
|---|---|---|---|
| 3.1 | Devices & printing → **Test print** | Test page prints within a minute: printer name, paper width, time | |
| 3.2 | Stations → connect the printer to a station | Shows "Printer: <name>" | |
| 3.3 | Order an item routed to that station | Ticket prints: order number, time, station, items, quantities; prices and line totals if the station shows prices; promotions; total. **Fits the paper width** (check the actual paper) | |
| 3.4 | Turn the printer off (Turn off), order again | No ticket sent to it; routing skips a station with no active output | |
| 3.5 | Turn on again, order | Prints | |
| 3.6 | Unplug the printer's network cable, order | Ticket not lost: printer alert on the kitchen screen; Print queue shows it waiting / failed | |
| 3.7 | With a backup printer set, keep it unplugged | Ticket prints on the backup after about 3 attempts | |
| 3.8 | Plug it back in; Retry any waiting ticket in Print queue | Prints **once**. A ticket marked "possible duplicate" is checked by staff | |
| 3.9 | Customer receipt after a cash payment | Receipt prints with logo, items, totals, cash received, change | |

## 4. Station configurations

| # | Configuration | Expected | Result |
|---|---|---|---|
| 4.1 | Screen only (e.g. Grill → Grill screen) | Ticket on the screen; nothing printed | |
| 4.2 | Printer only (e.g. Pastry → Pastry printer) | Ticket printed; no screen needed. Supervisor can mark the order ready | |
| 4.3 | Screen + printer (e.g. Bar) | Both get the same ticket | |

## 5. Internet outage (real network)

Do steps 1–9 with the internet on. Then **unplug the router's internet cable** (not the local network).

| # | Step | Expected | Result |
|---|---|---|---|
| 5.1 | Tills show "Offline · everything keeps working…"; the hub window shows Offline | As described | |
| 5.2 | Staff sign in with PIN (people who signed in before, online) | Works | |
| 5.3 | Several orders on POS 01 and POS 02, cash payments | Works; order numbers all different | |
| 5.4 | Kitchen screen, printer, customer display | Update as usual | |
| 5.5 | Kitchen marks items ready; order handed over | Works | |
| 5.6 | Reconnect the internet | Within about a minute the hub window shows "All sent" | |
| 5.7 | Back office → Orders / Reports | Every offline order appears once, with the charged prices; payments once; stock deducted once | |
| 5.8 | Devices & printing | Hub online, "Everything is sent"; devices shown "through the hub" | |

## 6. Hub PC failure

| # | Step | Expected | Result |
|---|---|---|---|
| 6.1 | Quit the hub (tray → Quit) | Tills cannot reach the hub (as documented) | |
| 6.2 | Back office → Devices & printing → **Stop running branch** on the hub | Web POS works again on the internet address | |
| 6.3 | Start the hub again, finish or cancel web POS orders, then **Run branch from hub** | Hub takes over again; numbering continues | |

## 7. USB printer and cash drawer (only if the restaurant has them)

| # | Step | Expected | Result |
|---|---|---|---|
| 7.1 | USB printer | **Not supported by MY FOOD today.** Record the model. Most models also come in an Ethernet version: prefer that | |
| 7.2 | Cash drawer on the receipt printer: `pnpm hardware:printer-check <ip> --drawer` | Record whether the drawer opens. MY FOOD does not open drawers automatically today | |

## Sign-off

All rows PASS (or accepted with a note): ____________ (restaurant) ____________ (MY FOOD)
