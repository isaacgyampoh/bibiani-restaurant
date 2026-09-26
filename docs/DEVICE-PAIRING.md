# MY FOOD — device pairing

Tills (POS), kitchen screens, the customer display and the print agent each get their **own login**. A device is never given a shared password. Printers are not paired: the print agent drives them.

## Two ways to pair (both secure, both audited)

### A. The device shows a code (recommended)

1. On the device, open `…/pair`. It shows **Pair this device** and a code like `K7M4-Q2RT`.
2. A manager or owner opens **Devices & printing**, finds the device (e.g. `POS-01`) and presses **Enter code from device**, then types the code.
3. The device continues by itself within about 3 seconds:
   - a till goes to PIN sign-in;
   - a kitchen screen shows its station;
   - the customer display shows the board.

### B. The manager creates a code

1. In **Devices & printing**, press **Create code** on the device. An 8-character code is shown.
2. On the device, open `…/pair`, choose **I have a code from a manager** and type it.

## Security

- **Code format:** codes use an unambiguous 30-symbol alphabet, 8 characters (about 6.6 × 10¹¹ possibilities). They work once and expire after 10 minutes.
- **Hashes only.** The server stores only hashes. For device-shown codes the device also holds a random secret, in memory only, which it must present to collect its login. A code seen over someone's shoulder is useless without the device itself.
- **Manager approval.** Approving needs the `device.manage` permission with a password sign-in, not a PIN. The database also checks that the device belongs to the approving restaurant.
- **Rate limits.** The public pairing calls are rate-limited per network address.
- **Each pairing replaces the previous one.** It creates a new login for the device and deletes the previous one, so a stolen or old installation stops working immediately.
- **Revoke** (with confirmation) deletes the device's login at once. The next action from that device is refused, and it drops back to pairing. Proven by the browser test "device revoked while active".

## Managing devices (Devices & printing)

- **See every device:** type (POS till, Kitchen screen, Customer display, Print agent, Printer), status (online, offline, never connected, from heartbeats), last seen, and whether it is paired.
- **Rename** (tills, screens, agents), **deactivate**, **revoke**, **re-pair** (either method, at any time).
- **Add device:** name, type, station (kitchen screens), receipt printer (tills), printer address.
- **Audit:** every pairing step appears in **Activity** ("Device set up", "Pairing code created", "Device removed"), and approvals are recorded as `device.pairing_approved`.

## Verified

- **Automated tests** (`device-pairing-requests.test.ts`, plus the earlier pairing tests):
  - waiting until approval;
  - wrong code refused;
  - cashier refused;
  - another restaurant's device refused;
  - single use;
  - expiry after 10 minutes;
  - printers refused;
  - only hashes stored.
- **Browser test on staging** (`e2e/onboarding-pairing.spec.ts`): the device shows a code, the owner enters it in Devices, and the device becomes the customer display.
