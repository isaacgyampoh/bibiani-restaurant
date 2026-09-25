import { randomUUID } from 'node:crypto';
import { ApiError } from '@rp/client-core';
import type { ApiErrorBody, OrderView } from '@rp/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpHarness, type HttpHarness, MONITOR_TOKEN } from './harness';

const uuid = () => randomUUID();

describe('HTTP API', () => {
  let h: HttpHarness;
  beforeAll(async () => {
    h = await createHttpHarness();
  });
  afterAll(() => h.db.close());

  it('rejects missing, forged and foreign-issuer tokens', async () => {
    const noToken = await h.http.request(`/v1/branches/${h.f.branchId}/orders`);
    expect(noToken.status).toBe(403);
    const bad = await h.http.request(`/v1/branches/${h.f.branchId}/orders`, {
      headers: { authorization: 'Bearer abc.def.ghi' },
    });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as ApiErrorBody).error.message).toBe('Please sign in again.');
    const foreign = await h.token(h.f.authUsers.manager, { issuer: 'https://evil.example/auth/v1' });
    expect(
      (
        await h.http.request(`/v1/branches/${h.f.branchId}/orders`, {
          headers: { authorization: `Bearer ${foreign}` },
        })
      ).status,
    ).toBe(401);
    const stranger = await h.token(uuid()); // valid signature, but no membership
    expect(
      (
        await h.http.request(`/v1/branches/${h.f.branchId}/orders`, {
          headers: { authorization: `Bearer ${stranger}` },
        })
      ).status,
    ).toBe(403);
  });

  it('ops health: token-protected counts of 5xx, auth failures and printing problems', async () => {
    expect((await h.http.request('/v1/ops/health')).status).toBe(403);
    expect(
      (await h.http.request('/v1/ops/health', { headers: { authorization: 'Bearer wrong' } })).status,
    ).toBe(403);
    const before = (await (
      await h.http.request('/v1/ops/health', { headers: { authorization: `Bearer ${MONITOR_TOKEN}` } })
    ).json()) as Record<string, number>;
    await h.http.request(`/v1/branches/${h.f.branchId}/orders`, {
      headers: { authorization: 'Bearer abc.def.ghi' },
    }); // 401
    const res = await h.http.request('/v1/ops/health', {
      headers: { authorization: `Bearer ${MONITOR_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const after = (await res.json()) as Record<string, number>;
    expect(Number(after.authFailures)).toBe(Number(before.authFailures) + 1);
    expect(Object.keys(after)).toEqual(
      expect.arrayContaining([
        'http5xx',
        'printJobsFailedLastHour',
        'printJobsDeadLastDay',
        'printJobsRetrying',
        'printJobsWaitingOver5Min',
        'agentsOffline',
        'printersUnhealthy',
      ]),
    );
  });

  it('a PIN session runs the till but cannot use back-office administration', async () => {
    const station = { branchId: h.f.branchId, name: `Bar ${uuid().slice(0, 4)}`, code: 'BAR2' };
    const post = async (amr: string[]) =>
      h.http.request('/v1/admin/config/station', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await h.token(h.f.authUsers.manager, { amr })}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(station),
      });
    expect((await post(['otp'])).status).toBe(403);
    expect((await post(['password'])).status).toBe(200);
    const menu = await h.http.request(`/v1/branches/${h.f.branchId}/menu`, {
      headers: { authorization: `Bearer ${await h.token(h.f.authUsers.manager, { amr: ['otp'] })}` },
    });
    expect(menu.status).toBe(200);
  });

  it('health endpoints need no auth', async () => {
    expect((await h.http.request('/health')).status).toBe(200);
  });

  it('submits Scenario A over HTTP with a correlation id on the response', async () => {
    const res = await h.http.request('/v1/orders/submit', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await h.token(h.f.authUsers.waiter)}`,
        'content-type': 'application/json',
        'x-request-id': 'corr-12345678',
        'x-device-id': h.f.devices.pos,
      },
      body: JSON.stringify({
        orderId: uuid(),
        branchId: h.f.branchId,
        areaId: h.f.areas.hall,
        tableId: h.f.tables['12'],
        items: [
          { id: uuid(), productId: h.f.products.jollof, quantity: 2 },
          { id: uuid(), productId: h.f.products.chicken, quantity: 2 },
          { id: uuid(), productId: h.f.products.meatPie, quantity: 2 },
          { id: uuid(), productId: h.f.products.coke, quantity: 2 },
        ],
        send: { submissionId: uuid() },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('corr-12345678');
    const order = (await res.json()) as OrderView;
    expect(order.orderNumber).toBe(5001);
    expect(order.tickets).toHaveLength(4);

    // Structured logs tie the request, order, tickets and print jobs together.
    const submitted = h.t.logger.lines.find((l) => l.event === 'order.submitted')!;
    expect(submitted.fields).toMatchObject({
      correlationId: 'corr-12345678',
      orderId: order.id,
      deviceId: h.f.devices.pos,
    });
    expect((submitted.fields.printJobIds as string[]).length).toBe(4);
  });

  it('turns failures into operator messages, never raw database errors', async () => {
    const client = h.client(h.f.authUsers.waiter);
    const err = await client
      .submitOrder({
        orderId: uuid(),
        branchId: h.f.branchId,
        areaId: h.f.areas.hall,
        tableId: h.f.tables['12'],
        items: [],
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 409,
      code: 'TABLE_UNAVAILABLE',
      message: 'Table 12 already has an open order',
    });

    const invalid = await h.http.request('/v1/orders/submit', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await h.token(h.f.authUsers.waiter)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ orderId: 'not-a-uuid' }),
    });
    expect(invalid.status).toBe(422);
    const body = (await invalid.json()) as ApiErrorBody;
    expect(body.error.message).toBe('Some details are missing or invalid');
    expect(body.error.message).not.toMatch(/violates|constraint|relation|syntax|sql/i);
  });

  it('a device id the staff member does not own is refused', async () => {
    const res = await h.http.request(`/v1/branches/${h.f.branchId}/orders`, {
      headers: { authorization: `Bearer ${await h.token(h.f.authUsers.cashier)}`, 'x-device-id': uuid() },
    });
    expect(res.status).toBe(403);
  });
});
