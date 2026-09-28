import type { RegisterRecord, RegisterRepository } from '@rp/application';
import type { RegisterPayment, RegisterTotals } from '@rp/domain';
import { dateOrNull, num, numOrNull, type Sql } from '../db/sql';

type Row = Record<string, unknown>;
const sn = (v: unknown) => (v ?? null) as string | null;

const SELECT = `select r.*, cb.display_name as closed_by_name from register_sessions r
  left join staff cb on cb.id = r.closed_by_staff_id`;

const map = (r: Row): RegisterRecord => ({
  id: String(r.id),
  branchId: String(r.branch_id),
  deviceId: sn(r.device_id),
  terminalName: String(r.terminal_name),
  cashierStaffId: String(r.cashier_staff_id),
  cashierName: String(r.cashier_name),
  status: r.status as RegisterRecord['status'],
  openedAt: dateOrNull(r.opened_at)!,
  openingCash: num(r.opening_cash),
  openingNote: sn(r.opening_note),
  closedAt: dateOrNull(r.closed_at),
  closedByName: sn(r.closed_by_name),
  cashSales: numOrNull(r.cash_sales),
  cashRefunds: numOrNull(r.cash_refunds),
  expectedCash: numOrNull(r.expected_cash),
  countedCash: numOrNull(r.counted_cash),
  variance: numOrNull(r.variance),
  // (Rows written before the ::text::jsonb fix hold the object as a JSON string.)
  closingTotals: (typeof r.closing_totals === 'string'
    ? JSON.parse(r.closing_totals)
    : (r.closing_totals ?? null)) as RegisterTotals | null,
  closingNote: sn(r.closing_note),
  reopenCount: num(r.reopen_count),
  reopenedAt: dateOrNull(r.reopened_at),
  reopenReason: sn(r.reopen_reason),
  version: num(r.version),
});

export function createRegisterRepository(sql: Sql): RegisterRepository {
  return {
    async insert(r) {
      await sql.query(
        `insert into register_sessions (id, restaurant_id, branch_id, device_id, terminal_name, cashier_staff_id,
           cashier_name, opening_cash, opening_note, opened_at)
         values ($1, app.current_restaurant_id(), $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          r.id,
          r.branchId,
          r.deviceId,
          r.terminalName,
          r.cashierStaffId,
          r.cashierName,
          r.openingCash,
          r.openingNote,
          r.openedAt.toISOString(),
        ],
      );
    },

    async find(sessionId, forUpdate = false) {
      const [r] = await sql.query(
        forUpdate ? 'select * from register_sessions where id = $1 for update' : `${SELECT} where r.id = $1`,
        [sessionId],
      );
      if (!r) return null;
      if (!forUpdate) return map(r);
      const [full] = await sql.query(`${SELECT} where r.id = $1`, [sessionId]);
      return map(full!);
    },

    async openFor(branchId, staffId) {
      const [r] = await sql.query(
        `${SELECT} where r.branch_id = $1 and r.cashier_staff_id = $2 and r.status = 'open'`,
        [branchId, staffId],
      );
      return r ? map(r) : null;
    },

    async openOnDevice(deviceId) {
      const [r] = await sql.query(`${SELECT} where r.device_id = $1 and r.status = 'open'`, [deviceId]);
      return r ? map(r) : null;
    },

    async payments(sessionId) {
      const rows = await sql.query(
        `select method, direction, amount from payments where register_session_id = $1 and status = 'recorded'`,
        [sessionId],
      );
      return rows.map(
        (p): RegisterPayment => ({
          method: p.method as RegisterPayment['method'],
          direction: p.direction as RegisterPayment['direction'],
          amount: num(p.amount),
        }),
      );
    },

    async orderCounts(sessionId) {
      const [r] = await sql.query(
        `select count(distinct o.id)::int as total,
                count(distinct o.id) filter (where o.channel = 'dine_in')::int as dine_in,
                count(distinct o.id) filter (where o.channel = 'takeaway')::int as takeaway
           from payments p join orders o on o.id = p.order_id
          where p.register_session_id = $1 and p.status = 'recorded' and p.direction = 'charge'`,
        [sessionId],
      );
      return { total: num(r?.total), dineIn: num(r?.dine_in), takeaway: num(r?.takeaway) };
    },

    async close(sessionId, c, expectedVersion) {
      const rows = await sql.query(
        `update register_sessions
            set status = 'closed', closed_at = $2, closed_by_staff_id = $3, cash_sales = $4, cash_refunds = $5,
                expected_cash = $6, counted_cash = $7, variance = $8, closing_totals = $9::text::jsonb, closing_note = $10,
                version = version + 1
          where id = $1 and status = 'open' and version = $11
          returning 1`,
        [
          sessionId,
          c.closedAt.toISOString(),
          c.staffId,
          c.totals.cashSales,
          c.totals.cashRefunds,
          c.totals.expectedCash,
          c.countedCash,
          c.variance,
          JSON.stringify(c.totals),
          c.note,
          expectedVersion,
        ],
      );
      return rows.length > 0;
    },

    async reopen(sessionId, r, expectedVersion) {
      const rows = await sql.query(
        `update register_sessions
            set status = 'open', closed_at = null, closed_by_staff_id = null, cash_sales = null, cash_refunds = null,
                expected_cash = null, counted_cash = null, variance = null, closing_totals = null, closing_note = null,
                reopened_at = $2, reopened_by_staff_id = $3, reopen_reason = $4, reopen_count = reopen_count + 1,
                version = version + 1
          where id = $1 and status = 'closed' and version = $5
          returning 1`,
        [sessionId, r.at.toISOString(), r.staffId, r.reason, expectedVersion],
      );
      return rows.length > 0;
    },

    async list({ branchId, staffId, from, to }) {
      const rows = await sql.query(
        `${SELECT} join branches b on b.id = r.branch_id
          where r.branch_id = $1 and ($2::uuid is null or r.cashier_staff_id = $2)
            and ($3::date is null or ((r.opened_at at time zone b.timezone) - b.business_day_cutoff::interval)::date >= $3::date)
            and ($4::date is null or ((r.opened_at at time zone b.timezone) - b.business_day_cutoff::interval)::date <= $4::date)
          order by (r.status = 'open') desc, r.opened_at desc
          limit 60`,
        [branchId, staffId, from, to],
      );
      return rows.map(map);
    },

    async names(staffId, deviceId) {
      const [r] = await sql.query(
        `select (select display_name from staff where id = $1) as staff,
                (select name from devices where id = $2::uuid) as device`,
        [staffId, deviceId],
      );
      return { staff: sn(r?.staff), device: sn(r?.device) };
    },
  };
}
