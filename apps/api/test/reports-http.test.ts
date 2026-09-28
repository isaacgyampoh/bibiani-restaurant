import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpHarness, type HttpHarness } from './harness';

/** Report, register and customer endpoints over HTTP: permissions enforced server-side, real files. */
describe('Reports, registers and customers over HTTP', () => {
  let h: HttpHarness;
  const get = async (user: string, path: string) =>
    h.fetch(`http://api.test${path}`, { headers: { authorization: `Bearer ${await h.token(user)}` } });
  const post = async (user: string, path: string, body: unknown, deviceId?: string) =>
    h.fetch(`http://api.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await h.token(user)}`,
        'content-type': 'application/json',
        ...(deviceId ? { 'x-device-id': deviceId } : {}),
      },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    h = await createHttpHarness();
  });
  afterAll(() => h.db.close());

  it('exports PDF, Excel and CSV as downloadable files', async () => {
    const base = `/v1/branches/${h.f.branchId}/reports/end_of_day/export?preset=today`;
    const pdf = await get(h.f.authUsers.manager, `${base}&format=pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.headers.get('content-disposition')).toMatch(
      /attachment; filename="myfood-end-of-day-\d{4}-\d{2}-\d{2}\.pdf"/,
    );
    expect(new TextDecoder('latin1').decode(new Uint8Array(await pdf.arrayBuffer())).slice(0, 5)).toBe(
      '%PDF-',
    );
    const xlsx = await get(h.f.authUsers.manager, `${base}&format=xlsx`);
    expect(xlsx.headers.get('content-type')).toContain('spreadsheetml');
    expect(new Uint8Array(await xlsx.arrayBuffer()).slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b])); // zip
    const csv = await get(h.f.authUsers.manager, `${base}&format=csv`);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(await csv.text()).toContain('End of Day');
    expect(csv.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses reports to staff without permission, bad formats and unknown reports', async () => {
    expect(
      (await get(h.f.authUsers.waiter, `/v1/branches/${h.f.branchId}/reports/tax?preset=today`)).status,
    ).toBe(403);
    expect(
      (
        await get(
          h.f.authUsers.waiter,
          `/v1/branches/${h.f.branchId}/reports/tax/export?preset=today&format=pdf`,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await get(
          h.f.authUsers.manager,
          `/v1/branches/${h.f.branchId}/reports/tax/export?preset=today&format=doc`,
        )
      ).status,
    ).toBe(422);
    expect(
      (await get(h.f.authUsers.manager, `/v1/branches/${h.f.branchId}/reports/secrets?preset=today`)).status,
    ).toBe(404);
    const noAuth = await h.fetch(`http://api.test/v1/branches/${h.f.branchId}/reports/tax?preset=today`);
    expect(noAuth.status).toBe(403);
  });

  it('JSON report with filters', async () => {
    const res = await get(
      h.f.authUsers.manager,
      `/v1/branches/${h.f.branchId}/reports/items?preset=this_month&channel=takeaway&sort=quantity`,
    );
    expect(res.status).toBe(200);
    const view = (await res.json()) as { title: string; filters: unknown[] };
    expect(view.title).toBe('Item Sales');
    expect(view.filters).toEqual([{ label: 'Service type', value: 'Takeaway' }]);
  });

  it('register open, close and closing report over HTTP', async () => {
    const sessionId = randomUUID();
    const opened = await post(
      h.f.authUsers.cashier,
      '/v1/registers/open',
      { sessionId, branchId: h.f.branchId, openingCash: 20000 },
      h.f.devices.pos,
    );
    expect(opened.status).toBe(200);
    const current = (await (
      await get(h.f.authUsers.cashier, `/v1/branches/${h.f.branchId}/registers/current`)
    ).json()) as {
      register: { id: string; version: number };
    };
    expect(current.register.id).toBe(sessionId);
    const closed = await post(h.f.authUsers.cashier, `/v1/registers/${sessionId}/close`, {
      countedCash: 19500,
      version: current.register.version,
    });
    expect(((await closed.json()) as { variance: number }).variance).toBe(-500);
    const again = await post(h.f.authUsers.cashier, `/v1/registers/${sessionId}/close`, {
      countedCash: 20000,
      version: current.register.version + 1,
    });
    expect(again.status).toBe(409);
    const pdf = await get(h.f.authUsers.cashier, `/v1/registers/${sessionId}/report?format=pdf`);
    expect(pdf.headers.get('content-disposition')).toContain('cashier-register-closing');
    expect((await get(h.f.authUsers.waiter, `/v1/registers/${sessionId}/report?format=pdf`)).status).toBe(
      403,
    );
  });

  it('customers: phone required, duplicates refused, list closed to waiters', async () => {
    const bad = await post(h.f.authUsers.manager, '/v1/customers', {
      customerId: randomUUID(),
      fullName: 'No Phone',
      phone: '',
    });
    expect(bad.status).toBe(422);
    const ok = await post(h.f.authUsers.manager, '/v1/customers', {
      customerId: randomUUID(),
      fullName: 'Abena',
      phone: '0265556666',
    });
    expect(ok.status).toBe(200);
    const dup = await post(h.f.authUsers.manager, '/v1/customers', {
      customerId: randomUUID(),
      fullName: 'Abena 2',
      phone: '+233 26 555 6666',
    });
    expect(dup.status).toBe(409);
    expect((await get(h.f.authUsers.waiter, '/v1/customers')).status).toBe(403);
    const lookup = (await (await get(h.f.authUsers.waiter, '/v1/customers/lookup?q=0265556666')).json()) as {
      matches: { fullName: string }[];
    };
    expect(lookup.matches[0]!.fullName).toBe('Abena');
  });
});
