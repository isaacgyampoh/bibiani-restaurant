# MY FOOD — reports and exports

Reports → choose a report → choose the period and filters → **Export** (PDF, Excel or CSV).

## How figures are calculated

- Every report is computed once on the server (`packages/application/src/use-cases/reports.ts`) from the same tables the POS, payments and stock screens write. The screen and the three export formats render that one result, so they always match.
- **Business day.** An order belongs to the trading day it was opened on, in the branch timezone (Africa/Accra) with the business-day cutoff (04:00). An order at 01:30 belongs to the previous day. Stock, audit and register timestamps are placed on business days the same way. No UTC dates are used.
- **Sales** are the items sent to the kitchen on orders that are not cancelled or voided. Gross = price × quantity (with modifiers); net = gross − promotions − manager discounts. Tax included in prices is inside net sales; tax added on top is shown separately.
- **Money received** = recorded payments − refunds. Voided payment records never count. A split payment counts each part once under its own method; the order is not counted twice.
- **Tax** comes from the tax rates configured in Menu → Taxes and recorded on each order line at the time of sale. No rate is hard-coded. The tax report is a restaurant summary, not an official tax return.

## Reports

| Report | What it shows | PDF | Excel | CSV |
|---|---|---|---|---|
| End of Day | Sales, payments by method, dine-in / takeaway, staff, terminals, tax, registers, stock movements, voids, bills, best sellers | ✓ | ✓ | ✓ |
| Tax | Gross, discounts, net, taxable sales, tax by rate (included / added), refunds and voids | ✓ | ✓ | ✓ |
| Item Sales | Quantity, gross, promotions, discounts, net, average price, tax per item and category; sortable | ✓ | ✓ | ✓ |
| Payment Methods | Cash, MoMo, card: payments, refunds, net, split payments | ✓ | ✓ | ✓ |
| Dine-in and Takeaway | Orders and sales per service type | ✓ | ✓ | ✓ |
| Sales by Terminal | Orders and payments per paired till, by method | ✓ | ✓ | ✓ |
| Orders | Every order with order staff, kitchen sender, cashier, status and totals | ✓ | ✓ | ✓ |
| Sales by Staff | Order staff, kitchen sender and cashier kept separate | ✓ | ✓ | ✓ |
| Staff Activity | Orders, sends, payments, bills, voids, cancellations, discounts, registers per person | ✓ | ✓ | ✓ |
| Customers | Customers on record, new, returning, their orders and spend | ✓ | ✓ | ✓ |
| Inventory Valuation | Stock on hand now, at cost | ✓ | ✓ | ✓ |
| Stock Movements | Every ledger entry with before / after quantities | ✓ | ✓ | ✓ |
| Deliveries | Stock received, cost, supplier / invoice reference | ✓ | ✓ | ✓ |
| Wastage | Stock written off, reasons, value | ✓ | ✓ | ✓ |
| Adjustments | Manual adjustments and approved stock-take corrections | ✓ | ✓ | ✓ |
| Stock Taking | Expected, counted, variance, who counted, submitted and approved | ✓ | ✓ | ✓ |
| Recipe Consumption | Ingredients used by sales and their cost | ✓ | ✓ | ✓ |
| Cashier Register Closing | One register: float, cash sales, expected, counted, variance, other methods, orders, sign-off lines | ✓ | ✓ | ✓ |

Sales overview (charts by day and hour) is kept under Reports → Sales overview.

## Filters and periods

Today, Yesterday, This week (from Monday), This month, Custom (up to one year). Depending on the report: staff, payment method, service type, terminal, table, category, item, movement type, order status, sort order. The filters used are printed on every export.

## Formats

- **PDF:** real text document (not a screenshot): MY FOOD and restaurant header on every page, title, period, generation time, tables with repeated headers, wrapped cells, totals, page numbers. Amounts are in GHS (standard PDF fonts have no ₵ sign).
- **Excel (.xlsx):** a Summary sheet, then one sheet per table with the report details on top, a frozen and filterable header, column widths, currency / date / percent formats, and a SUBTOTAL totals row that follows the filter.
- **CSV:** UTF-8, one rectangular table per file, properly quoted; plain numbers; text that a spreadsheet would treat as a formula is neutralised.

## Security

- Sales and staff reports need `reports.view`; inventory reports `reports.view` or `inventory.manage`; the customer report also needs `customer.view`. Enforced on the server.
- Every export is recorded in Activity (`report.export`): who, which report, period, filters, format, device.
