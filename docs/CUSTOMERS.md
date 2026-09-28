# MY FOOD — customers

## Rules

- A customer must have a **telephone number**. It is validated and stored in one form (`+233241234567`), so `024 123 4567`, `0241234567` and `+233 24 123 4567` are the same customer.
- The number is the duplicate check: adding an existing number shows "A customer with this telephone number already exists" and offers to open that customer.
- Duplicates are fixed with **Merge duplicate…** (managers): the duplicate's orders count for the kept customer; nothing is deleted; the merge is audited with a reason.
- Visits, orders and spend are calculated from the orders themselves.

## On the POS

- Takeaway orders have **Phone number** and **Customer name** fields. A known number shows the customer's name and visits ("Use" fills the name). A new number becomes a new customer when the order is sent.
- **Customer** on an open order adds or changes the customer (e.g. at checkout).
- Kitchen tickets never show the customer's telephone number.

## Who can see what

| Permission | Roles (default) | Allows |
|---|---|---|
| `customer.attach` | Owner, Manager, Cashier, Waiter (any role that takes orders) | Look up by number and attach at the till; name searches show masked numbers (024 *** 4567) |
| `customer.view` | Owner, Manager, Supervisor | Customers page, details, order history, customer report |
| `customer.manage` | Owner, Manager | Edit and merge |

Customer data is protected by row-level security per restaurant, is never in public pages or URLs, and edits are audited without storing the private values in the audit log.

On a phone, **Call** opens the phone's own dialler. Nothing is sent to customers automatically.

## In a hub branch

Customers made on the hub upload to the cloud. The hub does not hold the full customer list: at a hub till, a number is recognised only if it was used at that hub. If the cloud already has that number, the hub's record is merged into it automatically on upload.
