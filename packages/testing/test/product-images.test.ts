import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestDatabase,
  type RestaurantFixture,
  seedRestaurant,
  type TestApp,
  type TestDatabase,
} from '../src';
import { uuid } from './helpers';

// Smallest real files of each kind (headers are what the server checks), padded past the minimum size.
const pad = (head: number[]) => new Uint8Array([...head, ...new Array(200).fill(0)]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const WEBP = pad([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

describe('Product photos', () => {
  let db: TestDatabase;
  let f: RestaurantFixture;
  let t: TestApp;
  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedRestaurant(db, { slug: 'photos' });
    t = createTestApp(db);
  });
  afterAll(() => db.close());
  const owner = () => t.as(f.authUsers.manager);
  const menuPhoto = async (productId: string) =>
    (await t.app.getMenu.execute(await t.as(f.authUsers.cashier, f.devices.pos), f.branchId)).products.find(
      (p) => p.id === productId,
    )!.imageUrl;

  it('owner adds a photo: stored under the restaurant, shown on the POS menu and in the back office, audited', async () => {
    expect(await menuPhoto(f.products.jollof)).toBeNull();
    const { imageUrl } = await t.app.setProductImage.execute(await owner(), f.products.jollof, WEBP);
    expect(imageUrl).toMatch(
      new RegExp(
        `^https://storage\\.test/product-images/${f.restaurantId}/${f.products.jollof}-[0-9a-f-]{36}\\.webp$`,
      ),
    );
    expect(t.images.objects.size).toBe(1);
    expect([...t.images.objects.values()][0]!.contentType).toBe('image/webp');
    expect(await menuPhoto(f.products.jollof)).toBe(imageUrl);
    const config = await t.app.getConfiguration.execute(await owner());
    expect(
      (config.products as { id: string; imageUrl: string | null }[]).find((p) => p.id === f.products.jollof)!
        .imageUrl,
    ).toBe(imageUrl);
    const audit = await db.query(
      `select 1 from audit_logs where action = 'product.image' and entity_id = $1`,
      [f.products.jollof],
    );
    expect(audit).toHaveLength(1);
  });

  it('replacing a photo deletes the old file; removing clears it', async () => {
    const before = [...t.images.objects.keys()];
    const { imageUrl } = await t.app.setProductImage.execute(await owner(), f.products.jollof, JPEG);
    expect(imageUrl.endsWith('.jpg')).toBe(true);
    expect([...t.images.objects.keys()]).toHaveLength(1);
    expect(t.images.objects.has(before[0]!)).toBe(false);
    await t.app.removeProductImage.execute(await owner(), f.products.jollof);
    expect(t.images.objects.size).toBe(0);
    expect(await menuPhoto(f.products.jollof)).toBeNull();
  });

  it('only real JPEG / PNG / WebP up to 2 MB; the declared type is not trusted', async () => {
    const m = await owner();
    const html = new TextEncoder().encode(`<svg onload="alert(1)">${'x'.repeat(300)}</svg>`);
    await expect(t.app.setProductImage.execute(m, f.products.coke, html)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const huge = new Uint8Array(2 * 1024 * 1024 + 1);
    huge.set(PNG.slice(0, 8));
    await expect(t.app.setProductImage.execute(m, f.products.coke, huge)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(t.app.setProductImage.execute(m, f.products.coke, PNG.slice(0, 20))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(t.images.objects.size).toBe(0);
  });

  it('cashiers cannot change photos; unknown products store nothing', async () => {
    await expect(
      t.app.setProductImage.execute(await t.as(f.authUsers.cashier, f.devices.pos), f.products.coke, PNG),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(t.app.setProductImage.execute(await owner(), uuid(), PNG)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(t.images.objects.size).toBe(0);
  });

  it('a small version for POS buttons lives next to the photo and never outlives it', async () => {
    const m = await owner();
    await expect(t.app.setProductImageThumb.execute(m, f.products.coke, WEBP)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const { imageUrl } = await t.app.setProductImage.execute(m, f.products.coke, WEBP);
    const menuItem = async () =>
      (await t.app.getMenu.execute(await t.as(f.authUsers.cashier, f.devices.pos), f.branchId)).products.find(
        (p) => p.id === f.products.coke,
      )!;
    // No thumbnail yet: buttons fall back to the photo.
    expect((await menuItem()).thumbUrl).toBe(imageUrl);
    const { thumbUrl } = await t.app.setProductImageThumb.execute(m, f.products.coke, WEBP);
    expect(thumbUrl).toBe(imageUrl.replace(/\.webp$/, '-t.webp'));
    expect((await menuItem()).thumbUrl).toBe(thumbUrl);
    expect(t.images.objects.size).toBe(2);
    // A new photo removes the old photo and its thumbnail.
    await t.app.setProductImage.execute(m, f.products.coke, JPEG);
    expect(t.images.objects.size).toBe(1);
    await t.app.setProductImageThumb.execute(m, f.products.coke, JPEG);
    await t.app.removeProductImage.execute(m, f.products.coke);
    expect(t.images.objects.size).toBe(0);
    expect((await menuItem()).thumbUrl).toBeNull();
  });

  it('the database only accepts photo paths in the expected shape (no traversal, no foreign URLs)', async () => {
    for (const bad of [
      '../x.png',
      'https://evil.test/a.png',
      `${f.restaurantId}/${f.products.coke}-${uuid()}.svg`,
    ])
      await expect(
        db.query('update products set image_path = $1 where id = $2', [bad, f.products.coke]),
      ).rejects.toBeTruthy();
  });
});
