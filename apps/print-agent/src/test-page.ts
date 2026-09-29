import { render } from '@rp/escpos';

/** A printer check page: fits-the-paper ruler and sample lines. Printed directly, not through MY FOOD. */
export function testPage(width: 58 | 80, label: string, drawer = false): Uint8Array {
  const cols = width === 58 ? 32 : 48;
  const page = render(
    {
      schema: 1,
      title: 'MY FOOD printer check',
      blocks: [
        { type: 'logo' },
        { type: 'text', text: 'MY FOOD PRINTER CHECK', align: 'center', size: 'large', bold: true },
        { type: 'text', text: label, align: 'center' },
        { type: 'text', text: `${width} mm paper, ${cols} characters`, align: 'center' },
        { type: 'divider' },
        { type: 'text', text: '1234567890'.repeat(5).slice(0, cols) },
        { type: 'text', text: 'The line above must fit on one line.' },
        { type: 'columns', left: '2 x Jollof Rice', right: 'GHS 90.00' },
        { type: 'columns', left: 'TOTAL', right: 'GHS 90.00', bold: true },
        { type: 'text', text: `Sent ${new Date().toLocaleString()}`, align: 'center' },
        { type: 'feed', lines: 3 },
        { type: 'cut' },
      ],
    },
    { paperWidthMm: width },
  );
  return drawer ? new Uint8Array([...page, 0x1b, 0x70, 0x00, 0x19, 0xfa]) : page;
}
