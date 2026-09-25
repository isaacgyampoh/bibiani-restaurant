/**
 * Renders the platform's printer-agnostic document model into ESC/POS bytes.
 * Kept free of any domain or network dependency so it can be replaced per
 * printer family without touching the order system.
 */

import { LOGO_BITS_BASE64, LOGO_HEIGHT, LOGO_WIDTH } from './logo';

export type Block =
  | {
      type: 'text';
      text: string;
      align?: 'left' | 'center' | 'right';
      size?: 'normal' | 'tall' | 'large';
      bold?: boolean;
    }
  | { type: 'columns'; left: string; right: string; bold?: boolean }
  | { type: 'divider' }
  | { type: 'logo' }
  | { type: 'feed'; lines: number }
  | { type: 'cut' };

export interface Document {
  schema: 1;
  title: string;
  blocks: Block[];
}

export interface RenderOptions {
  paperWidthMm: 58 | 80 | number;
  possibleDuplicate?: boolean;
  isReprint?: boolean;
}

const ESC = 0x1b;
const GS = 0x1d;
export const CMD = {
  init: [ESC, 0x40],
  align: (n: 0 | 1 | 2) => [ESC, 0x61, n],
  bold: (on: boolean) => [ESC, 0x45, on ? 1 : 0],
  size: (n: number) => [GS, 0x21, n],
  feed: (n: number) => [ESC, 0x64, Math.max(0, Math.min(255, n))],
  cut: [GS, 0x56, 0x42, 0x00], // feed to cutter, partial cut
  statusRequest: [0x10, 0x04, 0x01], // DLE EOT 1: printer status
} as const;

const SIZE = { normal: 0x00, tall: 0x01, large: 0x11 } as const;
const ALIGN = { left: 0, center: 1, right: 2 } as const;

export function charsPerLine(paperWidthMm: number): number {
  return paperWidthMm <= 58 ? 32 : 48;
}

/** Thermal printers in their default code page reliably print ASCII only. */
export function toPrintable(text: string): string {
  return text
    .replace(/₵/g, 'GHS ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '?');
}

export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let current = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (w.length > width) {
        if (current) {
          lines.push(current);
          current = '';
        }
        lines.push(w.slice(0, width));
        w = w.slice(width);
      }
      if (!current) current = w;
      else if (current.length + 1 + w.length <= width) current += ` ${w}`;
      else {
        lines.push(current);
        current = w;
      }
    }
    lines.push(current);
  }
  return lines;
}

let logoCache: Uint8Array | null = null;
function logoBits(): Uint8Array {
  if (!logoCache) {
    const raw = atob(LOGO_BITS_BASE64);
    logoCache = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  return logoCache;
}

export function render(doc: Document, options: RenderOptions): Uint8Array {
  const cols = charsPerLine(options.paperWidthMm);
  const out: number[] = [...CMD.init];
  const push = (...bytes: number[]) => out.push(...bytes);
  const line = (text: string) => {
    for (const ch of toPrintable(text)) out.push(ch.charCodeAt(0));
    out.push(0x0a);
  };

  const banners: string[] = [];
  if (options.possibleDuplicate) banners.push('** POSSIBLE DUPLICATE **');
  if (options.isReprint) banners.push('** REPRINT **');
  for (const banner of banners) {
    push(...CMD.align(1), ...CMD.bold(true), ...CMD.size(SIZE.tall));
    line(banner);
  }
  if (banners.length) push(...CMD.size(SIZE.normal), ...CMD.bold(false));

  for (const block of doc.blocks) {
    switch (block.type) {
      case 'text': {
        const size = block.size ?? 'normal';
        const width = size === 'large' ? Math.floor(cols / 2) : cols;
        push(
          ...CMD.align(ALIGN[block.align ?? 'left']),
          ...CMD.bold(Boolean(block.bold)),
          ...CMD.size(SIZE[size]),
        );
        for (const l of wrap(toPrintable(block.text), width)) line(l);
        push(...CMD.size(SIZE.normal), ...CMD.bold(false));
        break;
      }
      case 'columns': {
        push(...CMD.align(0), ...CMD.bold(Boolean(block.bold)));
        const left = toPrintable(block.left);
        const right = toPrintable(block.right);
        if (left.length + right.length + 1 <= cols)
          line(left + ' '.repeat(cols - left.length - right.length) + right);
        else {
          for (const l of wrap(left, cols)) line(l);
          line(right.padStart(cols));
        }
        push(...CMD.bold(false));
        break;
      }
      case 'divider':
        push(...CMD.align(0));
        line('-'.repeat(cols));
        break;
      case 'logo': {
        // Raster bit image (GS v 0), centred: the real brand logo, 1 bit per dot.
        const bits = logoBits();
        const widthBytes = LOGO_WIDTH / 8;
        push(...CMD.align(1), 0x1d, 0x76, 0x30, 0x00);
        push(widthBytes & 0xff, widthBytes >> 8, LOGO_HEIGHT & 0xff, LOGO_HEIGHT >> 8);
        for (const b of bits) out.push(b);
        push(0x0a, ...CMD.align(0));
        break;
      }
      case 'feed':
        push(...CMD.feed(block.lines));
        break;
      case 'cut':
        push(...CMD.cut);
        break;
    }
  }
  if (!doc.blocks.some((b) => b.type === 'cut')) push(...CMD.feed(3), ...CMD.cut);
  return Uint8Array.from(out);
}

/** Decodes the DLE EOT 1 status byte. Printers vary; treat this as advisory. */
export function decodeStatus(byte: number): { online: boolean; drawerOpen: boolean } {
  return { online: (byte & 0x08) === 0, drawerOpen: (byte & 0x04) !== 0 };
}
