import type { PinRepository, PinStaff } from '@rp/application';
import { dateOrNull, type Sql } from '../db/sql';

type Row = Record<string, unknown>;
const COLUMNS = `id, user_id, display_name, email, is_active, pin_must_change, pin_lookup is not null as has_pin, pin_set_at, pin_version`;
const map = (r: Row): PinStaff => ({
  staffId: r.id as string,
  userId: (r.user_id ?? null) as string | null,
  displayName: r.display_name as string,
  email: (r.email ?? null) as string | null,
  isActive: Boolean(r.is_active),
  mustChange: Boolean(r.pin_must_change),
  hasPin: Boolean(r.has_pin),
  pinSetAt: dateOrNull(r.pin_set_at)?.toISOString() ?? null,
  pinVersion: Number(r.pin_version ?? 0),
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
        `update staff set pin_lookup = $2, pin_must_change = $3, pin_set_at = $4, pin_version = pin_version + 1 where id = $1`,
        [staffId, lookup, mustChange, now.toISOString()],
      );
    },
    async bindSession(sessionId, staffId, deviceId, at) {
      await sql.query(
        `insert into pin_sessions (session_id, restaurant_id, staff_id, device_id, created_at)
         values ($1, app.current_restaurant_id(), $2, $3, $4) on conflict (session_id) do nothing`,
        [sessionId, staffId, deviceId, at.toISOString()],
      );
      // Bindings are kept for as long as the device exists: a refreshed session keeps its id, and an
      // unbound "otp" session would count as an email-link session (see apps/api signInMethod).
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
