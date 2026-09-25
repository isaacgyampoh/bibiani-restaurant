import type { AdminRepository } from '@rp/application';
import type { ConfigEntity } from '@rp/contracts';
import { DomainError } from '@rp/domain';
import type { Sql } from '../db/sql';
import { json } from './util';

interface EntityMap {
  table: string;
  /** camelCase field -> column. Only these fields are ever written. */
  columns: Record<string, string>;
  /** Fields that are part of the key when there is no single id column. */
  key?: string[];
}

const ENTITIES: Record<ConfigEntity, EntityMap> = {
  branch: {
    table: 'branches',
    columns: {
      name: 'name',
      code: 'code',
      address: 'address',
      timezone: 'timezone',
      businessDayCutoff: 'business_day_cutoff',
      orderNumberStart: 'order_number_start',
      isActive: 'is_active',
    },
  },
  area: {
    table: 'operational_areas',
    columns: {
      branchId: 'branch_id',
      name: 'name',
      channel: 'channel',
      requiresTable: 'requires_table',
      requiresCustomerName: 'requires_customer_name',
      paymentPolicy: 'payment_policy',
      requirePaymentBeforeProduction: 'require_payment_before_production',
      showOnCustomerDisplay: 'show_on_customer_display',
      isActive: 'is_active',
      sortOrder: 'sort_order',
    },
  },
  table: {
    table: 'dining_tables',
    columns: {
      branchId: 'branch_id',
      areaId: 'area_id',
      label: 'label',
      capacity: 'capacity',
      isActive: 'is_active',
    },
  },
  category: {
    table: 'categories',
    columns: { name: 'name', parentId: 'parent_id', sortOrder: 'sort_order', isActive: 'is_active' },
  },
  taxRate: {
    table: 'tax_rates',
    columns: {
      name: 'name',
      rateBp: 'rate_bp',
      isInclusive: 'is_inclusive',
      isCompound: 'is_compound',
      applyOrder: 'apply_order',
      isActive: 'is_active',
    },
  },
  product: {
    table: 'products',
    columns: {
      categoryId: 'category_id',
      name: 'name',
      kitchenName: 'kitchen_name',
      basePrice: 'base_price',
      requiresPreparation: 'requires_preparation',
      isActive: 'is_active',
    },
  },
  branchProduct: {
    table: 'branch_products',
    columns: {
      branchId: 'branch_id',
      productId: 'product_id',
      priceOverride: 'price_override',
      isAvailable: 'is_available',
    },
    key: ['branch_id', 'product_id'],
  },
  station: {
    table: 'stations',
    columns: {
      branchId: 'branch_id',
      name: 'name',
      code: 'code',
      targetPrepSeconds: 'target_prep_seconds',
      autoReady: 'auto_ready',
      isActive: 'is_active',
      sortOrder: 'sort_order',
    },
  },
  device: {
    table: 'devices',
    columns: {
      branchId: 'branch_id',
      kind: 'kind',
      name: 'name',
      stationId: 'station_id',
      receiptPrinterId: 'receipt_printer_id',
      isActive: 'is_active',
    },
  },
  stationOutput: {
    table: 'station_outputs',
    columns: { stationId: 'station_id', deviceId: 'device_id', role: 'role', copies: 'copies' },
  },
  routingRule: {
    table: 'routing_rules',
    columns: {
      branchId: 'branch_id',
      match: 'match',
      productId: 'product_id',
      categoryId: 'category_id',
      areaId: 'area_id',
      stationId: 'station_id',
      priority: 'priority',
      isActive: 'is_active',
    },
  },
  role: { table: 'roles', columns: { name: 'name' } },
};

async function upsert(sql: Sql, map: EntityMap, record: Record<string, unknown>): Promise<string> {
  const cols: string[] = [];
  const params: unknown[] = [];
  for (const [field, column] of Object.entries(map.columns)) {
    if (record[field] === undefined) continue;
    cols.push(column);
    params.push(record[field]);
  }
  if (map.key) {
    const assignments = cols.filter((c) => !map.key!.includes(c)).map((c) => `${c} = excluded.${c}`);
    await sql.query(
      `insert into ${map.table} (restaurant_id, ${cols.join(', ')})
       values (app.current_restaurant_id(), ${cols.map((_, i) => `$${i + 1}`).join(', ')})
       on conflict (${map.key.join(', ')}) do update set ${assignments.join(', ')}`,
      params,
    );
    return map.key.map((k) => String(params[cols.indexOf(k)])).join(':');
  }
  const id = (record.id as string | undefined) ?? crypto.randomUUID();
  const assignments = cols.map((c) => `${c} = excluded.${c}`);
  const [row] = await sql.query<{ id: string }>(
    `insert into ${map.table} (id, restaurant_id, ${cols.join(', ')})
     values ($${cols.length + 1}, app.current_restaurant_id(), ${cols.map((_, i) => `$${i + 1}`).join(', ')})
     on conflict (id) do update set ${assignments.length ? assignments.join(', ') : 'id = excluded.id'}
     returning id`,
    [...params, id],
  );
  if (!row) throw new DomainError('NOT_FOUND', 'Record not found');
  return row.id;
}

export function createAdminRepository(sql: Sql): AdminRepository {
  return {
    async get(entity, id) {
      const map = ENTITIES[entity];
      if (map.key) {
        const [a, b] = id.split(':');
        const [row] = await sql.query(
          `select * from ${map.table} where ${map.key[0]} = $1 and ${map.key[1]} = $2`,
          [a, b],
        );
        return row ?? null;
      }
      const [row] = await sql.query(`select * from ${map.table} where id = $1`, [id]);
      return row ?? null;
    },

    async save(entity, record) {
      const map = ENTITIES[entity];
      const id = await upsert(sql, map, record);

      // Child collections that belong to the entity are replaced as a whole.
      if (entity === 'product' && Array.isArray(record.taxRateIds)) {
        await sql.query('delete from product_taxes where product_id = $1', [id]);
        await sql.query(
          `insert into product_taxes (restaurant_id, product_id, tax_rate_id)
           select app.current_restaurant_id(), $1, value::uuid from jsonb_array_elements_text($2::text::jsonb)`,
          [id, json(record.taxRateIds)],
        );
      }
      if (entity === 'routingRule' && Array.isArray(record.extraPrinterIds)) {
        await sql.query('delete from routing_rule_extra_outputs where routing_rule_id = $1', [id]);
        await sql.query(
          `insert into routing_rule_extra_outputs (restaurant_id, routing_rule_id, device_id)
           select app.current_restaurant_id(), $1, value::uuid from jsonb_array_elements_text($2::text::jsonb)`,
          [id, json(record.extraPrinterIds)],
        );
      }
      if (entity === 'role' && Array.isArray(record.permissions)) {
        await sql.query('delete from role_permissions where role_id = $1', [id]);
        await sql.query(
          `insert into role_permissions (restaurant_id, role_id, permission_code)
           select app.current_restaurant_id(), $1, value from jsonb_array_elements_text($2::text::jsonb)`,
          [id, json(record.permissions)],
        );
      }
      if (entity === 'device') {
        const printer = record.printer as
          | {
              address: string;
              agentDeviceId?: string | null;
              paperWidthMm?: number;
              backupPrinterId?: string | null;
            }
          | null
          | undefined;
        if (record.kind === 'printer' && printer) {
          await sql.query(
            `insert into printers (device_id, restaurant_id, connection, address, agent_device_id, paper_width_mm, backup_printer_id)
             values ($1, app.current_restaurant_id(), 'network_escpos', $2, $3, $4, $5)
             on conflict (device_id) do update set address = excluded.address, agent_device_id = excluded.agent_device_id,
               paper_width_mm = excluded.paper_width_mm, backup_printer_id = excluded.backup_printer_id`,
            [
              id,
              printer.address,
              printer.agentDeviceId ?? null,
              printer.paperWidthMm ?? 80,
              printer.backupPrinterId ?? null,
            ],
          );
        }
      }
      return id;
    },

    async delete(entity, id) {
      const map = ENTITIES[entity];
      const rows = await sql.query(`delete from ${map.table} where id = $1 returning id`, [id]);
      return rows.length > 0;
    },

    async insertStaff(st) {
      await sql.query(
        `insert into staff (id, restaurant_id, user_id, display_name, email) values ($1, app.current_restaurant_id(), $2, $3, $4)`,
        [st.id, st.userId, st.displayName, st.email],
      );
    },

    async updateStaff(id, patch) {
      await sql.query(
        `update staff set display_name = coalesce($2, display_name), is_active = coalesce($3, is_active) where id = $1`,
        [id, patch.displayName ?? null, patch.isActive ?? null],
      );
    },

    async setStaffRoles(staffId, roleIds, branchId) {
      await sql.query('delete from staff_roles where staff_id = $1', [staffId]);
      await sql.query(
        `insert into staff_roles (restaurant_id, staff_id, role_id, branch_id)
         select app.current_restaurant_id(), $1, value::uuid, $3 from jsonb_array_elements_text($2::text::jsonb)`,
        [staffId, json(roleIds), branchId],
      );
    },

    async staff(staffId) {
      const [r] = await sql.query<{
        id: string;
        user_id: string | null;
        display_name: string;
        is_active: boolean;
      }>('select id, user_id, display_name, is_active from staff where id = $1', [staffId]);
      return r ? { id: r.id, userId: r.user_id, displayName: r.display_name, isActive: r.is_active } : null;
    },

    async insertPairingCode(p) {
      await sql.query(
        `insert into device_pairing_codes (restaurant_id, device_id, code_hash, expires_at, created_by_staff_id)
         values (app.current_restaurant_id(), $1, $2, $3, $4)`,
        [p.deviceId, p.codeHash, p.expiresAt.toISOString(), p.createdByStaffId],
      );
    },

    async device(deviceId) {
      const [r] = await sql.query<{
        id: string;
        branch_id: string;
        kind: string;
        name: string;
        auth_user_id: string | null;
        is_active: boolean;
      }>('select id, branch_id, kind, name, auth_user_id, is_active from devices where id = $1', [deviceId]);
      return r
        ? {
            id: r.id,
            branchId: r.branch_id,
            kind: r.kind,
            name: r.name,
            authUserId: r.auth_user_id,
            isActive: r.is_active,
          }
        : null;
    },

    async unbindDeviceIdentity(deviceId) {
      await sql.query(`update devices set auth_user_id = null, status = 'unknown' where id = $1`, [deviceId]);
    },

    async setTableStatus(tableId, status) {
      const [r] = await sql.query<{ branch_id: string }>(
        `update dining_tables set status = $2, status_changed_at = now(), version = version + 1 where id = $1 returning branch_id`,
        [tableId, status],
      );
      return r ? { branchId: r.branch_id } : null;
    },
  };
}
