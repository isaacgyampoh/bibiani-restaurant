# MY FOOD — Chefelisha Restaurant: your guide

Welcome to MY FOOD. This guide explains, in plain words, how to start and run your restaurant on it.

## Where MY FOOD lives

**https://bibiani-restaurant.vercel.app**

It works in any modern browser (Chrome or Edge recommended). When your own web address is ready, MY FOOD will also open there. The address above keeps working.

## 1. Create your owner account

1. Your MY FOOD contact invites your email address.
2. Open **…/welcome**, type that email and press **Send verification link**.
3. Open the email "MY FOOD — confirm it's you" and press **Continue to MY FOOD**. The link works once, for one hour.
4. Enter your full name and choose your own password (at least 10 characters). Nobody else knows it, not even us.
5. You arrive at **Set up your restaurant**, a checklist of 13 steps. Do them in any order, skip what you don't need, and come back any time from **Set-up guide** in the menu.

**Forgot your password?** Press **Forgot password?** on the sign-in screen.

## 2. Add your staff

**Staff → Add staff member:**
- name, email and role (Cashier, Waiter, Kitchen, Supervisor, Manager…);
- a starting PIN (4–6 digits).

Tell the person their starting PIN in person. At their first sign-in on a till, they choose their own PIN.

- Each PIN belongs to one person. The system refuses a PIN already in use, without saying whose it is.
- After several wrong PINs, the till locks for a short time.
- **Forgot PIN?** on the till sends a link to the person's email.
- Staff with a PIN can use the tills. Only owners and managers, signed in with email and password, can change staff, devices or settings.

## 3. Connect your devices

Open **Devices & printing** on your computer.

- **Tills (POS):** on the till, open **…/pair**. It shows a code like `K7M4-Q2RT`. On your computer, find the till (e.g. POS-01), press **Enter code from device** and type the code. The till then shows the PIN screen.
- **Kitchen screens:** the same, choosing the kitchen screen (e.g. KITCHEN-01). It then shows its orders.
- **Customer display** (the TV for customers): the same, choosing CUSTOMER-DISPLAY-01. It shows **Order received**, **Preparing** and **Ready — please collect**, with order numbers only.
- **Install on the till computer (recommended):** in Chrome or Edge, press **Install MY FOOD on this computer**. MY FOOD then opens in its own window and updates itself.
- **Lost or replaced a device?** Press **Revoke**. It stops working immediately. Pair the new one the same way.

## 4. Taking orders

1. On the till, choose a table or **Takeaway**.
2. Tap dishes. Photos, prices and promotions are shown.
   - **Sold out** dishes can't be added.
   - **Ingredient low** is only a warning.
3. Press **Send to kitchen**. The kitchen sees each item with quantity, price, promotion and total. Printed kitchen tickets show prices too, if you turn this on for the station.
4. **Take payment** (cash, mobile money, card). Cash shows the change to give.
5. **Print receipt** (or **View receipt** to show it on screen). Reprints are marked REPRINT.

## 5. Receipts

Each receipt shows:
- the MY FOOD logo and restaurant name;
- the order number, date and time, table or takeaway, and cashier;
- each dish with quantity, unit price and line total;
- promotions and discounts (with the reason);
- the subtotal, taxes and total;
- the payment method, the cash received and the change;
- your thank-you message, set in **Settings**.

## 6. Menu, photos and promotions

- **Menu & recipes → Edit** a dish:
  - name, description, category, price;
  - On sale / Sold out;
  - photo (a clear phone photo is fine);
  - recipe;
  - kitchen station.
- **Promotions:** percentage off, amount off, a special price, bundles ("3 for GH₵25") or "buy 2 get 1 free", for set dates, days or times. Orders always keep the price they were taken at.
- **Manager discounts** need a manager and a reason. Every discount is recorded.

## 7. Stock

- **Stock:**
  - add ingredients with a minimum level;
  - record deliveries, wastage and adjustments;
  - statuses are In stock, Low stock and Out of stock.
- **Recipes:** when a dish with a recipe is sent to the kitchen, its ingredients come out of stock automatically. A cancelled order puts them back once.
- **Stock taking:** count what is on the shelves, explain differences, then a manager approves.
- **Reports:** ingredient cost and margin for dishes that have a recipe. Items without a recipe are shown separately; their cost is never guessed.

## 8. Keeping an eye on things

- **Dashboard:** today's sales, open orders, the kitchen, stock alerts and promotions.
- **Supervisor:** every active order, which station it is waiting on and for how long, what is ready to hand over, and what was handed over in the last hour.
- **Activity:** who changed what, and when. Covers prices, promotions, discounts, stock, staff and PINs, and devices. Export it with **Export CSV**.

## 9. When the internet goes down (MY FOOD Hub)

MY FOOD can keep your restaurant running without internet, using one **MY FOOD Hub**: an always-on Windows computer in the restaurant with the MY FOOD Hub program installed.

- **Your devices use the hub.** Tills, kitchen screens and the customer display open MY FOOD from the hub's address (shown in the hub window, e.g. `http://192.168.1.20:8080`) instead of the internet address.
- **Internet down:** nothing changes for your staff.
  - They sign in with their PIN, take orders, take cash, and send to the kitchen.
  - Kitchen screens and printers get the tickets, and the customer display updates.
  - Tills show a small line: *"Offline · everything keeps working and is saved on the hub"*.
- **Internet back:** everything recorded meanwhile is sent to MY FOOD automatically, exactly once. Your reports, stock and back office then include it. The hub window shows **All sent**.
- **MoMo and card:** record them only after the payment is confirmed on the phone or card terminal, as always. MY FOOD never marks a payment as received on its own.
- **PIN sign-in without internet** works for staff who have signed in on the hub at least once while the internet was on. Changing a PIN needs the internet.
- **Keep the hub computer on.** If it is switched off, the tills cannot work locally. If only the hub is broken but the internet works, a manager can press **Stop running branch** in Devices & printing, and the tills then use the normal MY FOOD address.
- **Menu, prices, staff and settings are still changed in the back office.** The hub picks up changes within about 15 seconds while online.

Setting up the hub: see [DESKTOP-POS.md](DESKTOP-POS.md), "Setting up the hub PC". Your MY FOOD contact can do this with you.

## 10. Printers

- **Where tickets go.** Each kitchen station can have a screen, a printer, or both. Set this in **Stations → Connect screen or printer**. Pastry, for example, can use only a printer.
- **Test print.** In **Devices & printing**, press **Test print** next to a printer. A short page with the printer's name should come out within a minute.
- **If a printer is offline:**
  - its tickets wait, and are never lost; the kitchen screen shows a printer alert;
  - MY FOOD retries by itself and, if a backup printer is set, prints there;
  - when the printer is back, press **Retry** in **Devices & printing → Print queue** for any ticket still waiting;
  - a ticket marked *possible duplicate* may have printed already: check before making the food twice.
- **Turn off** a printer you are repairing, so tickets are not sent to it.

## 11. Checking your devices

**Devices & printing** shows every till, kitchen screen, printer and the hub: online or offline, when it was last seen, and for printers any error and unprinted tickets. In a restaurant run by the hub, the top line tells you in plain words whether the hub is online and whether everything has been sent.

## 12. Backups and safety

- Your data is kept in a secure database in Europe (Ireland), with **daily backups**.
- Every important change is recorded in Activity and cannot be deleted.
- Passwords and PINs are never stored in readable form. Nobody can look up your PIN or password.
- If something goes wrong on a screen, MY FOOD shows **Something went wrong** with a **Reload** button. Saved orders and payments are safe.

## 13. Contact

For help, changes or new devices, contact your MY FOOD developer: **Isaac Gyampoh**, through the contact details agreed at handover. When you report a problem, include:
- what you were doing;
- the time;
- the device name (e.g. POS-01).
