/**
 * Prepares a photo for upload in the browser: keeps the orientation the camera recorded, scales the
 * longest side down to 800 px, and re-encodes as WebP (JPEG where the browser cannot write WebP).
 * Phone photos of several MB become ~50-150 KB, which keeps the tills fast on restaurant Wi-Fi.
 */
export async function preparePhoto(file: File, maxSide = 800): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('Choose a photo (JPEG, PNG or WebP).');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('This photo could not be read. Try a JPEG or PNG.');
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot prepare photos.');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const encode = (type: string, quality: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  const webp = await encode('image/webp', 0.82);
  if (webp && webp.type === 'image/webp') return webp;
  const jpeg = await encode('image/jpeg', 0.85);
  if (!jpeg) throw new Error('This photo could not be prepared.');
  return jpeg;
}
