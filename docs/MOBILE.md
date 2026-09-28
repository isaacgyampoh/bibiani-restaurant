# MY FOOD on phones and tablets

The same web app (PWA), laid out as a mobile app below 900 px wide:

- App bar at the top with the page title; **tab bar** at the bottom with the person's main screens (e.g. Home, POS, Orders, Register) and **More** for everything else they may use, plus Change PIN and Sign out.
- **POS:** two-column product grid, category chips, search; a sticky "*n* items · total · View order" bar; the order opens full screen with large buttons for quantity, customer, Send to kitchen and payment.
- Dialogs open as bottom sheets; forms use 16 px text (no zoom on focus) and 44 px or larger touch targets; safe areas (notches, home bar) are respected.
- Reports show summary cards first; tables collapse and scroll inside their section; filters open in a sheet; Export opens a sheet.
- Installed to the home screen it runs standalone (manifest: standalone, theme colour, icons, shortcuts for POS, Kitchen, Cash register, Customers, Customer display).

Verified by `e2e/responsive.spec.ts` (runs in `pnpm staging:e2e`) at 320×568, 360×800, 375×812, 390×844, 412×915, 768×1024 and 1024×1366: no horizontal page scrolling on any main screen, phone navigation present, and the POS order, register close, customer and report-export flows completed at phone size. Tested in Chromium's device emulation; not yet checked on physical phones.
