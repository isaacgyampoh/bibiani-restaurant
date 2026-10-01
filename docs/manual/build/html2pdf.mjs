// HTML -> A4 PDF with Chromium. Usage: node html2pdf.mjs <in.html> <out.pdf> <compact 0|1> [footer title]
import { chromium } from '@playwright/test';

const [, , html, pdf, compact, footer = 'MY FOOD · Installation &amp; Operations Manual'] = process.argv;
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`file://${html}`, { waitUntil: 'load' });
await page.pdf({
  path: pdf,
  format: 'A4',
  printBackground: true,
  preferCSSPageSize: true,
  displayHeaderFooter: compact !== '1',
  headerTemplate: '<span></span>',
  footerTemplate: `<div style="font-size:7pt;width:100%;text-align:center;color:#777">${footer} · page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`,
});
await browser.close();
