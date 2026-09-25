# ADR 0002: V1 payments are manual records only

- Status: Accepted (Phase 3, 2026-09-25)
- Supersedes: backlog PAY-02 (MoMo "pending until verified") and PAY-06 (provider integration), and `01-architecture.md` §I/§J mentions of MoMo providers and webhooks

## Decision

- Methods: `cash`, `momo`, `card` (`PAYMENT_METHODS` in the domain). **Split is not a method.** A split is several payment records on one order.
- The cashier verifies the money (cash in the drawer, MoMo confirmation on the customer's phone, the card terminal slip) and records it. The system makes no provider calls, receives no webhooks and does no automatic verification.
- Cash may be tendered above the balance, and the excess is recorded as change. MoMo and card amounts may not exceed the balance.
- Records are never edited. Mistakes are **voided** (needs `payment.void`, a reason, and an audit entry with before/after) or **refunded** (new record with `refund_of_payment_id`, capped at the original, audited).
- Order payment status is derived from the records: `unpaid | partially_paid | paid | partially_refunded | refunded`. The "voided" state from the brief applies to the *payment record* (`recorded | voided`). A voided payment simply stops counting.
- Payment and kitchen state are independent. An order can be paid and in preparation, or unpaid and ready. `completed` requires fulfilment (served or picked up) **and** settlement.
- Pay-before-production is an explicit per-area setting (`operational_areas.require_payment_before_production`, default off).

## Future

A `PaymentProvider` adapter can be added in the application layer later (MoMo API, card terminal). It would add a `pending` record state. No provider code exists now, deliberately.
