import type {
  CreateCustomerCommand,
  CustomerDetailView,
  CustomerListView,
  CustomerLookupView,
  MergeCustomerCommand,
  OrderView,
  SetOrderCustomerCommand,
  UpdateCustomerCommand,
} from '@rp/contracts';
import { assertOrderOpen, canonicalPhone, DomainError, displayPhone, requirePhone } from '@rp/domain';
import type { Repositories } from '../ports';
import { authorize, authorizeAnywhere, can, canAnywhere, type RequestContext } from '../principal';
import type { Dependencies } from './shared';

/**
 * Customers belong to the restaurant (every branch sees the same customer). The telephone number
 * is required and is the duplicate key: numbers are stored in one canonical form, so the same
 * number typed differently finds the same customer. Customer details are private: the list,
 * history and reports need customer.view; tills only look up and attach (customer.attach).
 */
const optional = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);

/**
 * The customer for an order's name and telephone number: the existing customer with that number,
 * or a new one. Returns null when no number was given. An existing customer's name is not
 * overwritten from the till (it is corrected in Customers).
 */
export async function customerForOrder(
  deps: Dependencies,
  tx: Repositories,
  ctx: RequestContext,
  name: string | null | undefined,
  phoneInput: string | null | undefined,
): Promise<{ id: string; phone: string; name: string | null } | null> {
  if (!phoneInput?.trim()) return null;
  const phone = requirePhone(phoneInput);
  const existing = await tx.customers.findByPhone(phone);
  if (existing) return { id: existing.id, phone, name: existing.fullName ?? optional(name) };
  // Without customer.attach the order keeps the name and number, but no customer record is made.
  if (!canAnywhere(ctx.principal, 'customer.attach')) return null;
  const id = deps.ids.uuid();
  await tx.customers.insert({
    id,
    fullName: optional(name),
    phone,
    email: null,
    notes: null,
    staffId: ctx.principal.staffId,
  });
  await tx.audit.append({
    branchId: null,
    actorStaffId: ctx.principal.staffId,
    actorDeviceId: ctx.deviceId,
    action: 'customer.create',
    entityType: 'customer',
    entityId: id,
    after: { source: 'order' },
    correlationId: ctx.correlationId,
  });
  return { id, phone, name: optional(name) };
}

export class ListCustomers {
  constructor(private readonly deps: Dependencies) {}

  async execute(
    ctx: RequestContext,
    q: { search?: string | null; limit?: number; offset?: number },
  ): Promise<CustomerListView> {
    authorizeAnywhere(ctx.principal, 'customer.view');
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const [page, currency] = await Promise.all([
        tx.customers.list({
          search: q.search?.trim().slice(0, 80) || null,
          limit: Math.min(Math.max(q.limit ?? 50, 1), 200),
          offset: Math.max(q.offset ?? 0, 0),
        }),
        restaurantCurrency(tx),
      ]);
      return { ...page, currency };
    });
  }
}

export class GetCustomer {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, customerId: string): Promise<CustomerDetailView> {
    authorizeAnywhere(ctx.principal, 'customer.view');
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const detail = await tx.customers.detail(customerId);
      if (!detail) throw new DomainError('NOT_FOUND', 'Customer not found');
      return { ...detail, currency: await restaurantCurrency(tx) };
    });
  }
}

/** Till lookup while taking an order: exact number match, or a short name search (numbers masked). */
export class LookupCustomer {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, query: string): Promise<CustomerLookupView> {
    if (!canAnywhere(ctx.principal, 'customer.view')) authorizeAnywhere(ctx.principal, 'customer.attach');
    const q = query.trim().slice(0, 80);
    if (q.length < 2) return { matches: [] };
    const phone = canonicalPhone(q);
    const name = /\p{L}/u.test(q) ? q : null;
    if (!phone && !name) return { matches: [] };
    const full = canAnywhere(ctx.principal, 'customer.view');
    const rows = await this.deps.uow.run(ctx.principal.restaurantId, (tx) =>
      tx.customers.lookup(phone, name, 6),
    );
    return {
      matches: rows.map((r) => {
        const exact = r.phone === phone;
        const shown = displayPhone(r.phone);
        return {
          id: r.id,
          fullName: r.fullName,
          phoneDisplay: exact || full ? shown : mask(shown),
          exact,
          orders: r.orders,
        };
      }),
    };
  }
}

const mask = (shown: string) =>
  shown.replace(
    /^(.{3,4})(.*)(.{4})$/,
    (_, a: string, mid: string, b: string) => `${a}${mid.replace(/\d/g, '*')}${b}`,
  );

export class CreateCustomer {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, cmd: CreateCustomerCommand): Promise<CustomerDetailView> {
    if (!canAnywhere(ctx.principal, 'customer.manage')) authorizeAnywhere(ctx.principal, 'customer.attach');
    const phone = requirePhone(cmd.phone);
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const same = await tx.customers.find(cmd.customerId);
      if (same) {
        if (same.phone !== phone)
          throw new DomainError('IDEMPOTENCY_MISMATCH', 'This customer id was already used');
      } else {
        const existing = await tx.customers.findByPhone(phone);
        if (existing)
          throw new DomainError('CUSTOMER_EXISTS', 'A customer with this telephone number already exists', {
            customerId: existing.id,
            fullName: existing.fullName,
          });
        await tx.customers.insert({
          id: cmd.customerId,
          fullName: cmd.fullName.trim(),
          phone,
          email: optional(cmd.email),
          notes: optional(cmd.notes),
          staffId: ctx.principal.staffId,
        });
        await tx.audit.append({
          branchId: null,
          actorStaffId: ctx.principal.staffId,
          actorDeviceId: ctx.deviceId,
          action: 'customer.create',
          entityType: 'customer',
          entityId: cmd.customerId,
          after: { source: 'customers' },
          correlationId: ctx.correlationId,
        });
      }
      const detail = (await tx.customers.detail(cmd.customerId))!;
      // Tills may create customers but only managers see the full record.
      return {
        ...detail,
        recentOrders: canAnywhere(ctx.principal, 'customer.view') ? detail.recentOrders : [],
        currency: await restaurantCurrency(tx),
      };
    });
  }
}

export class UpdateCustomer {
  constructor(private readonly deps: Dependencies) {}

  async execute(
    ctx: RequestContext,
    customerId: string,
    cmd: UpdateCustomerCommand,
  ): Promise<CustomerDetailView> {
    authorizeAnywhere(ctx.principal, 'customer.manage');
    const phone = requirePhone(cmd.phone);
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const current = await tx.customers.find(customerId);
      if (!current) throw new DomainError('NOT_FOUND', 'Customer not found');
      if (current.mergedIntoId)
        throw new DomainError('VALIDATION_FAILED', 'This record was merged into another customer');
      if (phone !== current.phone) {
        const clash = await tx.customers.findByPhone(phone);
        if (clash && clash.id !== customerId)
          throw new DomainError('CUSTOMER_EXISTS', 'Another customer already has this telephone number', {
            customerId: clash.id,
            fullName: clash.fullName,
          });
      }
      const patch = {
        fullName: cmd.fullName.trim(),
        phone,
        email: optional(cmd.email),
        notes: optional(cmd.notes),
      };
      if (!(await tx.customers.update(customerId, patch, cmd.version)))
        throw new DomainError(
          'VERSION_CONFLICT',
          'Someone else changed this customer. Reload and try again.',
        );
      await tx.audit.append({
        branchId: null,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: 'customer.update',
        entityType: 'customer',
        entityId: customerId,
        // Which fields changed, not the private values themselves.
        after: {
          changed: (['fullName', 'phone', 'email', 'notes'] as const).filter(
            (k) => (patch[k] ?? null) !== (current[k] ?? null),
          ),
        },
        correlationId: ctx.correlationId,
      });
      return { ...(await tx.customers.detail(customerId))!, currency: await restaurantCurrency(tx) };
    });
  }
}

/** Merges a duplicate into the customer to keep. Both records and all orders stay; history is audited. */
export class MergeCustomer {
  constructor(private readonly deps: Dependencies) {}

  async execute(
    ctx: RequestContext,
    duplicateId: string,
    cmd: MergeCustomerCommand,
  ): Promise<CustomerDetailView> {
    authorizeAnywhere(ctx.principal, 'customer.manage');
    if (duplicateId === cmd.intoCustomerId)
      throw new DomainError('VALIDATION_FAILED', 'Choose two different customers');
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const [from, into] = await Promise.all([
        tx.customers.find(duplicateId),
        tx.customers.find(cmd.intoCustomerId),
      ]);
      if (!from || !into) throw new DomainError('NOT_FOUND', 'Customer not found');
      if (from.mergedIntoId || into.mergedIntoId)
        throw new DomainError('VALIDATION_FAILED', 'One of these records was already merged');
      await tx.customers.merge(duplicateId, cmd.intoCustomerId);
      await tx.audit.append({
        branchId: null,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: 'customer.merge',
        entityType: 'customer',
        entityId: cmd.intoCustomerId,
        before: { mergedCustomerId: duplicateId },
        after: { keptCustomerId: cmd.intoCustomerId },
        reason: cmd.reason,
        correlationId: ctx.correlationId,
      });
      return { ...(await tx.customers.detail(cmd.intoCustomerId))!, currency: await restaurantCurrency(tx) };
    });
  }
}

/** Sets or changes the customer of an open order (e.g. at checkout), by telephone number. */
export class SetOrderCustomer {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, orderId: string, cmd: SetOrderCustomerCommand): Promise<OrderView> {
    return this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const agg = await tx.orders.findForUpdate(orderId);
      if (!agg) throw new DomainError('NOT_FOUND', 'Order not found', { orderId });
      authorize(ctx.principal, 'order.create', agg.header.branchId);
      if (!can(ctx.principal, 'customer.attach', agg.header.branchId))
        authorize(ctx.principal, 'customer.manage', agg.header.branchId);
      assertOrderOpen(agg.header.status);
      const customer = await customerForOrder(this.deps, tx, ctx, cmd.customerName, cmd.customerPhone);
      await tx.customers.linkOrder(
        orderId,
        customer?.id ?? null,
        customer?.name ?? optional(cmd.customerName),
        customer?.phone ?? null,
      );
      await tx.audit.append({
        branchId: agg.header.branchId,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: 'order.customer',
        entityType: 'order',
        entityId: orderId,
        after: { customerId: customer?.id ?? null },
        correlationId: ctx.correlationId,
      });
      return (await tx.read.order(orderId))!;
    });
  }
}

const restaurantCurrency = (tx: Repositories) => tx.customers.currency();
