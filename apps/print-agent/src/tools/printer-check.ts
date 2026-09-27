import { render } from '@rp/escpos';
import { NetworkEscPosDriver } from '../driver';

/**
 * On-site printer diagnostic (not part of MY FOOD's normal printing). Sends directly to a network
 * ESC/POS printer, bypassing MY FOOD, to answer: can this PC reach the printer, does it print our
 * layout at its paper width, and (optionally) does it open a cash drawer on its drawer port.
 *
 *   pnpm hardware:printer-check 192.168.1.50            # 80 mm test page
 *   pnpm hardware:printer-check 192.168.1.50 --width 58
 *   pnpm hardware:printer-check 192.168.1.50 --drawer   # also sends a drawer pulse (pin 2)
 *
 * The drawer pulse is the standard ESC p 0 command; whether a drawer opens depends on the printer
 * model and its cable. Record the result in docs/HARDWARE-ACCEPTANCE.md; MY FOOD does not open
 * drawers by itself.
 */
const args = process.argv.slice(2);
const address = args.find((a) => !a.startsWith('--'));
if (!address) {
  console.error('Usage: printer-check <ip[:port]> [--width 58|80] [--drawer]');
  process.exit(2);
}
const widthArg = args.indexOf('--width');
const width = widthArg >= 0 ? Number(args[widthArg + 1]) : 80;
if (width !== 58 && width !== 80) {
  console.error('--width must be 58 or 80');
  process.exit(2);
}
const drawer = args.includes('--drawer');
const cols = width === 58 ? 32 : 48;
const ruler = '1234567890'.repeat(5).slice(0, cols);

const driver = new NetworkEscPosDriver(address);
const probe = await driver.probe();
console.log(probe.ok ? `Reached ${address}.` : `Cannot reach ${address}: ${probe.error}`);
if (!probe.ok) process.exit(1);

const page = render(
  {
    schema: 1,
    title: 'MY FOOD printer check',
    blocks: [
      { type: 'logo' },
      { type: 'text', text: 'MY FOOD PRINTER CHECK', align: 'center', size: 'large', bold: true },
      { type: 'text', text: `${width} mm paper, ${cols} characters`, align: 'center' },
      { type: 'divider' },
      { type: 'text', text: ruler },
      { type: 'text', text: 'The line above must fit on one line.' },
      { type: 'columns', left: '2 x Jollof Rice', right: 'GHS 90.00' },
      { type: 'columns', left: '1 x Grilled Chicken (extra pepper)', right: 'GHS 60.00' },
      { type: 'columns', left: 'TOTAL', right: 'GHS 150.00', bold: true },
      { type: 'text', text: `Sent ${new Date().toLocaleString()}`, align: 'center' },
      { type: 'feed', lines: 3 },
      { type: 'cut' },
    ],
  },
  { paperWidthMm: width },
);
const bytes = drawer ? new Uint8Array([...page, 0x1b, 0x70, 0x00, 0x19, 0xfa]) : page;
const result = await driver.send(bytes);
if (!result.ok) {
  console.error(`Printing failed after ${result.bytesWritten} bytes: ${result.error}`);
  process.exit(1);
}
console.log(
  `Sent ${bytes.length} bytes. Check the paper${drawer ? ' and whether the cash drawer opened' : ''}.`,
);
