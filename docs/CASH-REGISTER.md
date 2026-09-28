# MY FOOD — cash registers

1. **Open.** Cash register → enter the opening cash (float) → Open register. Records the cashier, terminal, time and float. One open register per cashier and per terminal.
2. **During the shift.** Every payment the cashier records is attached to their register. A payment recorded by someone else on the same till (e.g. a manager's refund) goes into the register open on that till.
3. **Close.** Close register → count the drawer → enter the actual cash → the screen shows *Balanced*, *Short by* or *Over by* → Review → Close register.
   - Expected cash = opening cash + cash payments − cash refunds.
   - Variance = actual − expected. It is recorded as it is; no total is adjusted.
   - A double tap closes once. A closed register cannot be edited (enforced in the database).
4. **Report.** The closing report (cashier, terminal, session, times, cash, MoMo, card, total, orders, dine-in / takeaway, discounts, tax, voids, signature lines) opens after closing and can be exported as PDF, Excel or CSV. Past registers are listed on the same page.
5. **Reopen.** Only `register.manage` (Owner, Manager), with a reason. The undone close is kept in Activity (`register.reopen`) so no closing figures are lost.

Permissions: `register.operate` (any role that records payments), `register.manage` (Owner, Manager). Registers opened on a hub upload to the cloud like payments.
