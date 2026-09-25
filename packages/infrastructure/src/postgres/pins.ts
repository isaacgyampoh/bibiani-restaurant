import type { PinRepository, PinStaff } from '@rp/application';
import { dateOrNull, type Sql } from '../db/sql';

type Row = Record<string, unknown>;
const COLUMNS = `id, user_id, display_name, email, is_active, pin_must_change, pin_lookup is not null as has_pin`;
const map = (r: Row): PinStaff => ({
  staffId: r.id as string,
  userId: (r.user_id ?? null) as string | null,
  displayName: r.display_name as string,
  email: (r.email ?? null) as string | null,
  isActive: Boolean(r.is_active),
  mustChange: Boolean(r.pin_must_change),
  hasPin: Boolean(r.has_pin),
});

/** PIN digests never leave this repository: callers only ever get who the PIN belongs to. */
export function createPinRepository(sql: Sql): PinRepository {
  return {
    async staffByLookup(lookup) {
      const [r] = await sql.query(`select ${COLUMNS} from staff where pin_lookup = $1`, [lookup]);
      return r ? map(r) : null;
    },
    async staffById(staffId) {
      const [r] = await sql.query(`select ${COLUMNS} from staff where id = $1`, [staffId]);
      return r ? map(r) : null;
    },
    async staffByEmail(email) {
      const [r] = await sql.query(`select ${COLUMNS} from staff where lower(email) = lower($1)`, [email]);
      return r ? map(r) : null;
    },
    async setPin(staffId, lookup, mustChange, now) {
      await sql.query(
        `update staff set pin_lookup = $2, pin_must_change = $3, pin_set_at = $4 where id = $1`,
        [staffId, lookup, mustChange, now.toISOString()],
      );
    },
    async activate(staffId, now) {
      await sql.query(`update staff set activated_at = coalesce(activated_at, $2) where id = $1`, [
        staffId,
        now.toISOString(),
      ]);
    },
    async recordAttempt(a) {
      await sql.query(
        `insert into pin_attempts (restaurant_id, device_id, staff_id, succeeded, created_at)
         values (app.current_restaurant_id(), $1, $2, $3, $4)`,
        [a.deviceId, a.staffId, a.succeeded, a.at.toISOString()],
      );
    },
    async failures(scope, since) {
      const rows =
        scope === 'restaurant'
          ? await sql.query(
              `select created_at from pin_attempts where not succeeded and created_at > $1 order by created_at desc limit 100`,
              [since.toISOString()],
            )
          : await sql.query(
              `select created_at from pin_attempts where device_id = $1 and not succeeded and created_at > $2
               order by created_at desc limit 100`,
              [scope.deviceId, since.toISOString()],
            );
      return rows.map((r) => dateOrNull(r.created_at)!);
    },
  };
}
