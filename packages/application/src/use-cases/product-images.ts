import { DomainError } from '@rp/domain';
import type { RequestContext } from '../principal';
import { authorizeRestaurantWide } from './administration';
import type { Dependencies } from './shared';

export const MAX_PRODUCT_IMAGE_BYTES = 2 * 1024 * 1024;

/** The real image type, from the file's first bytes (the declared type is not trusted). */
export function sniffImage(bytes: Uint8Array): { type: string; ext: 'webp' | 'jpg' | 'png' } | null {
  const at = (i: number, ...v: number[]) => v.every((b, n) => bytes[i + n] === b);
  if (at(0, 0xff, 0xd8, 0xff)) return { type: 'image/jpeg', ext: 'jpg' };
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { type: 'image/png', ext: 'png' };
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
    return { type: 'image/webp', ext: 'webp' };
  return null;
}

/**
 * Sets a product's photo. The file is checked (real JPEG/PNG/WebP, at most 2 MB), stored under a new
 * random name, then the product points at it in one audited transaction; the previous photo is
 * deleted afterwards. If saving fails, the uploaded file is removed again.
 */
export class SetProductImage {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, productId: string, bytes: Uint8Array): Promise<{ imageUrl: string }> {
    authorizeRestaurantWide(ctx, 'menu.manage');
    const images = this.deps.images;
    if (!images) throw new DomainError('UNAVAILABLE', 'Photo upload is not set up on this server');
    if (bytes.length > MAX_PRODUCT_IMAGE_BYTES)
      throw new DomainError('VALIDATION_FAILED', 'Choose a photo smaller than 2 MB');
    if (bytes.length < 100) throw new DomainError('VALIDATION_FAILED', 'This file is not a usable photo');
    const kind = sniffImage(bytes);
    if (!kind) throw new DomainError('VALIDATION_FAILED', 'Choose a JPEG, PNG or WebP photo');

    const restaurantId = ctx.principal.restaurantId;
    const [current, currentThumb] = await this.deps.uow.run(restaurantId, async (tx) => [
      await tx.admin.productImage(productId),
      await tx.admin.productImageThumb(productId),
    ]);
    if (current === undefined) throw new DomainError('NOT_FOUND', 'Product not found');

    const path = `${restaurantId}/${productId}-${this.deps.ids.uuid()}.${kind.ext}`;
    await images.put(path, bytes, kind.type);
    let previous: string | null | undefined;
    try {
      previous = await this.deps.uow.run(restaurantId, async (tx) => {
        const before = await tx.admin.productImage(productId);
        if (before === undefined) throw new DomainError('NOT_FOUND', 'Product not found');
        await tx.admin.setProductImage(productId, path);
        await tx.audit.append({
          branchId: null,
          actorStaffId: ctx.principal.staffId,
          actorDeviceId: ctx.deviceId,
          action: 'product.image',
          entityType: 'product',
          entityId: productId,
          before: { imagePath: before },
          after: { imagePath: path, bytes: bytes.length, type: kind.type },
          correlationId: ctx.correlationId,
        });
        return before;
      });
    } catch (e) {
      await images.remove(path).catch(() => undefined);
      throw e;
    }
    if (previous) await this.removeQuietly(ctx, previous);
    if (currentThumb) await this.removeQuietly(ctx, currentThumb);
    return { imageUrl: images.publicUrl(path) };
  }

  private async removeQuietly(ctx: RequestContext, path: string) {
    try {
      await this.deps.images!.remove(path);
    } catch (error) {
      this.deps.logger.warn('product_image.cleanup_failed', {
        correlationId: ctx.correlationId,
        path,
        error: String(error),
      });
    }
  }
}

export class RemoveProductImage {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, productId: string): Promise<{ ok: true }> {
    authorizeRestaurantWide(ctx, 'menu.manage');
    let previousThumb: string | null = null;
    const previous = await this.deps.uow.run(ctx.principal.restaurantId, async (tx) => {
      const before = await tx.admin.productImage(productId);
      if (before === undefined) throw new DomainError('NOT_FOUND', 'Product not found');
      if (!before) return null;
      previousThumb = await tx.admin.productImageThumb(productId);
      await tx.admin.setProductImage(productId, null);
      await tx.audit.append({
        branchId: null,
        actorStaffId: ctx.principal.staffId,
        actorDeviceId: ctx.deviceId,
        action: 'product.image_removed',
        entityType: 'product',
        entityId: productId,
        before: { imagePath: before },
        after: { imagePath: null },
        correlationId: ctx.correlationId,
      });
      return before;
    });
    if (previousThumb && this.deps.images)
      await this.deps.images.remove(previousThumb).catch(() => undefined);
    if (previous && this.deps.images)
      await this.deps.images.remove(previous).catch((error) =>
        this.deps.logger.warn('product_image.cleanup_failed', {
          correlationId: ctx.correlationId,
          path: previous,
          error: String(error),
        }),
      );
    return { ok: true };
  }
}

export const MAX_THUMB_BYTES = 512 * 1024;

/**
 * The small version of the current photo (POS buttons, lists). Stored next to the photo; replaced
 * whenever the photo changes. Same checks as the photo: real image, menu permission.
 */
export class SetProductImageThumb {
  constructor(private readonly deps: Dependencies) {}

  async execute(ctx: RequestContext, productId: string, bytes: Uint8Array): Promise<{ thumbUrl: string }> {
    authorizeRestaurantWide(ctx, 'menu.manage');
    const images = this.deps.images;
    if (!images) throw new DomainError('UNAVAILABLE', 'Photo upload is not set up on this server');
    if (bytes.length < 100 || bytes.length > MAX_THUMB_BYTES)
      throw new DomainError('VALIDATION_FAILED', 'The thumbnail must be smaller than 512 KB');
    const kind = sniffImage(bytes);
    if (!kind) throw new DomainError('VALIDATION_FAILED', 'Choose a JPEG, PNG or WebP photo');
    const restaurantId = ctx.principal.restaurantId;
    const [photo, oldThumb] = await this.deps.uow.run(restaurantId, async (tx) => [
      await tx.admin.productImage(productId),
      await tx.admin.productImageThumb(productId),
    ]);
    if (photo === undefined) throw new DomainError('NOT_FOUND', 'Product not found');
    if (!photo) throw new DomainError('VALIDATION_FAILED', 'Add a photo first');
    const path = `${photo.replace(/\.(webp|jpg|png)$/, '')}-t.${kind.ext}`;
    if (oldThumb === path) await images.remove(path).catch(() => undefined);
    await images.put(path, bytes, kind.type);
    try {
      await this.deps.uow.run(restaurantId, async (tx) => {
        // Only if the photo is still the one this thumbnail belongs to.
        if ((await tx.admin.productImage(productId)) !== photo)
          throw new DomainError('VERSION_CONFLICT', 'The photo changed; try again');
        await tx.admin.setProductImageThumb(productId, path);
      });
    } catch (e) {
      await images.remove(path).catch(() => undefined);
      throw e;
    }
    if (oldThumb && oldThumb !== path) await images.remove(oldThumb).catch(() => undefined);
    return { thumbUrl: images.publicUrl(path) };
  }
}
