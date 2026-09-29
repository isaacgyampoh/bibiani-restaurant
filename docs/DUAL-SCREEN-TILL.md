# Dual-screen tills: the customer screen

Tills with a second, customer-facing monitor show the customer their order as it is rung up:

- **Between customers:** the restaurant logo and "Welcome".
- **While ordering:** each item, quantity and price, and the total (large).
- **After payment:** "Thank you!", the total and, for cash, **the change**. It stays for 20 seconds, even if the cashier moves on, then returns to Welcome.

It runs on the till itself: the POS window feeds the customer window directly (no server, no second sign-in). It is instant and keeps working without internet. Customer phone numbers are never shown on it.

## Set up (once per till, Chrome or Edge on Windows)

1. Sign in on the till as usual and open the POS.
2. Press **Customer screen** (top bar).
   - The first time, the browser asks to "manage windows on all your displays": choose **Allow**. The customer screen then opens on the second monitor by itself.
   - If you choose Block, the customer screen opens as a normal window: drag it onto the second monitor.
3. Tap the customer screen once: it goes full screen.

After a restart, repeat steps 2 and 3. Keep both windows in the same browser.

## Not the same as the Customer display

The **Customer display** (Devices & printing) is a separate, paired screen for the whole restaurant that shows which orders are being prepared and ready. It is unchanged. A till's customer screen shows only that till's current order.

## Verified

`e2e/till-screen.spec.ts`: on staging, a POS window and its customer window in one browser: items and total appear as they are added, the order number after sending, "Thank you!" with the change after a cash payment, and it stays when the cashier goes back. Tested in Chromium; not yet on the restaurant's physical dual-screen tills.
